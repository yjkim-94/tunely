"""Vercel Python Function + local Uvicorn entrypoint."""
import asyncio, base64, contextlib, hashlib, hmac, json, os, re, secrets, shutil, signal, sys, tempfile, time
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from fastapi import FastAPI, HTTPException, Request, Response, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from dotenv import load_dotenv
load_dotenv('.env.local')
app=FastAPI(docs_url=None,redoc_url=None,openapi_url=None)
TTL=30*24*60*60
COOKIE='soriham_session'
ROOT=Path(__file__).resolve().parent.parent/'backend'

class Login(BaseModel): password:str=Field(min_length=1,max_length=1024)
class Search(BaseModel): query:str=Field(min_length=1,max_length=200)
class Import(BaseModel): url:str=Field(max_length=2048); permitted:bool=False

def configured():
    if not os.getenv('APP_PASSWORD_HASH') or len(os.getenv('SESSION_SECRET',''))<32: raise HTTPException(503,'서버 비밀번호 설정이 필요합니다.')

def signature(value):
    return hmac.new(os.environ['SESSION_SECRET'].encode(),(value+os.environ['APP_PASSWORD_HASH']).encode(),hashlib.sha256).hexdigest()

def auth(request:Request):
    configured()
    try:
        token=request.cookies.get(COOKIE,''); expiry,nonce,sig=token.split('.')
        value=expiry+'.'+nonce
        if int(expiry)<=time.time() or int(expiry)>time.time()+TTL+60 or not hmac.compare_digest(signature(value),sig): raise ValueError()
    except (ValueError,TypeError): raise HTTPException(401,'다시 로그인해 주세요.')
    return token

def canonical_url(value):
    try:
        u=urlparse(value)
        if u.scheme!='https' or u.username or u.password or u.port not in (None,443): raise ValueError()
        host=(u.hostname or '').lower()
        if host=='youtu.be': video=u.path.strip('/')
        elif host in ('youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'):
            if u.path=='/watch': video=parse_qs(u.query).get('v',[''])[0]
            elif re.fullmatch(r'/(shorts|live|embed)/[\w-]{11}/?',u.path): video=u.path.strip('/').split('/')[1]
            else: raise ValueError()
        else: raise ValueError()
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}',video): raise ValueError()
        return 'https://www.youtube.com/watch?v='+video
    except ValueError: raise HTTPException(400,'올바른 YouTube 영상 URL을 입력해 주세요.')

@app.middleware('http')
async def protection(request:Request,call_next):
    if request.method=='POST':
        origin=request.headers.get('origin')
        # Explicit trusted origin is required in production. Browser requests always send Origin.
        expected=os.getenv('APP_ORIGIN')
        if origin and origin!=(expected or str(request.base_url).rstrip('/')): return Response(status_code=403)
        if int(request.headers.get('content-length','0'))>8192: return Response(status_code=413)
    response=await call_next(request)
    response.headers['Cache-Control']='no-store'
    response.headers['X-Content-Type-Options']='nosniff'
    return response

# Per-instance throttling; production adds Vercel Firewall rate limits.
_attempts={}
def rate(key,limit,period=60):
    now=time.monotonic()
    if len(_attempts)>2048:
        for k in list(_attempts):
            if now-_attempts[k][0]>period: _attempts.pop(k,None)
    start,count=_attempts.get(key,(now,0))
    if now-start>period: start,count=now,0
    if count>=limit: raise HTTPException(429,'잠시 후 다시 시도해 주세요.')
    _attempts[key]=(start,count+1)

@app.post('/api/auth/login')
async def login(body:Login,request:Request,response:Response):
    configured(); rate('login:'+(request.client.host if request.client else 'unknown'),5,60)
    try: await asyncio.to_thread(PasswordHasher().verify,os.environ['APP_PASSWORD_HASH'],body.password)
    except (VerificationError,InvalidHashError): raise HTTPException(401,'비밀번호를 확인해 주세요.')
    expiry=int(time.time())+TTL; value=f'{expiry}.{secrets.token_hex(16)}'
    response.set_cookie(COOKIE,value+'.'+signature(value),max_age=TTL,httponly=True,secure=os.getenv('COOKIE_SECURE','true').lower()!='false',samesite='strict',path='/')
    return {'authenticated':True,'expires':expiry}

@app.get('/api/auth/session')
async def session(token=Depends(auth)): return {'authenticated':True,'expires':int(token.split('.')[0])}

@app.post('/api/auth/logout')
async def logout(response:Response):
    response.delete_cookie(COOKIE,path='/');return {'ok':True}

@app.get('/api/health')
async def health(token=Depends(auth)):
    from backend.worker import runtime
    import yt_dlp.version, imageio_ffmpeg
    return {'yt_dlp':yt_dlp.version.__version__,'ffmpeg':Path(os.getenv('FFMPEG_PATH') or imageio_ffmpeg.get_ffmpeg_exe()).exists(),'deno':bool(runtime()),'configured':True}

async def spawn(*args):
    return await asyncio.create_subprocess_exec(sys.executable,str(ROOT/'worker.py'),*args,stdout=asyncio.subprocess.PIPE,stderr=None,start_new_session=os.name!='nt',env={**os.environ,'PYTHONPATH':os.pathsep.join([str(ROOT.parent),*[p for p in sys.path if p]])})

async def stop(proc):
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            if os.name!='nt': os.killpg(proc.pid,signal.SIGTERM)
            else: proc.terminate()
        try: await asyncio.wait_for(proc.wait(),2)
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                if os.name!='nt': os.killpg(proc.pid,signal.SIGKILL)
                else: proc.kill()
            await proc.wait()

@app.post('/api/search')
async def search(body:Search,request:Request,token=Depends(auth)):
    rate('search:'+token,30)
    proc=await spawn('search',body.query.strip())
    try:
        async with asyncio.timeout(45):
            task=asyncio.create_task(proc.communicate())
            try:
                while not task.done():
                    if await request.is_disconnected(): raise HTTPException(499,'검색을 취소했습니다.')
                    await asyncio.sleep(.2)
                stdout,_=await task
            finally:
                if not task.done(): task.cancel()
        if proc.returncode: raise HTTPException(502,'YouTube 검색에 실패했습니다. 서버 접근 제한 또는 네트워크 상태를 확인해 주세요.')
        return json.loads(stdout)['items']
    except TimeoutError: raise HTTPException(504,'검색 시간이 초과되었습니다.')
    finally: await stop(proc)

@app.post('/api/import/convert')
async def convert(body:Import,token=Depends(auth)):
    url=canonical_url(body.url)
    if not body.permitted: raise HTTPException(400,'저장 권한을 확인해 주세요.')
    rate('convert:'+token,10)
    async def stream():
        
        # A previous hard-killed function cannot run finally; remove old orphan folders.
        for stale in Path(tempfile.gettempdir()).glob('soriham-*'):
            if stale.is_dir() and time.time()-stale.stat().st_mtime>3600:
                shutil.rmtree(stale,ignore_errors=True)
        folder=Path(tempfile.mkdtemp(prefix='soriham-'));proc=None
        def line(**data): return json.dumps(data,ensure_ascii=False)+'\n'
        try:
            # Heartbeat starts immediately; whole request including transfer is bounded.
            yield line(type='progress',stage='영상 확인',percent=None)
            async with asyncio.timeout(275):
                proc=await spawn('convert',url,str(folder));track=None
                pending=asyncio.create_task(proc.stdout.readline())
                try:
                    while True:
                        done,_=await asyncio.wait({pending},timeout=3)
                        if not done:
                            yield line(type='heartbeat');continue
                        raw=pending.result()
                        if not raw: break
                        event=json.loads(raw)
                        if event['type']=='ready': track=event['track']
                        else: yield raw
                        pending=asyncio.create_task(proc.stdout.readline())
                    await proc.wait()
                finally:
                    if not pending.done(): pending.cancel()
                if proc.returncode or not track: raise RuntimeError('YouTube 다운로드 또는 M4A 변환에 실패했습니다. 서버 접근 제한·인증 요구·지원 형식을 확인해 주세요.')
                size=(folder/'audio.m4a').stat().st_size
                yield line(type='progress',stage='iPhone으로 전송',percent=0,total=size)
                with (folder/'audio.m4a').open('rb') as audio:
                    sent=0
                    while chunk:=audio.read(128*1024):
                        sent+=len(chunk);yield line(type='audio',data=base64.b64encode(chunk).decode(),percent=round(sent/size*100));await asyncio.sleep(0)
                yield line(type='done',track=track)
        except TimeoutError: yield line(type='error',message='처리 시간이 초과되었습니다. 더 짧은 영상으로 다시 시도해 주세요.')
        except asyncio.CancelledError: raise
        except Exception as e: yield line(type='error',message=str(e) if isinstance(e,RuntimeError) else '오디오 처리 중 오류가 발생했습니다.')
        finally:
            # Shield cleanup from the streaming disconnect cancellation scope.
            import anyio
            with anyio.CancelScope(shield=True):
                if proc: await stop(proc)
                shutil.rmtree(folder,ignore_errors=True)
    return StreamingResponse(stream(),media_type='application/x-ndjson',headers={'X-Accel-Buffering':'no'})
