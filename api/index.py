"""Vercel Python Function + local Uvicorn entrypoint."""
import asyncio, contextlib, hashlib, hmac, json, os, re, secrets, signal, sys, time
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlparse
from fastapi import FastAPI, HTTPException, Request, Response, Depends
from fastapi.responses import StreamingResponse
from typing import Literal
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
class Search(BaseModel):
    query:str=Field(min_length=1,max_length=200)
    sort:Literal['relevance','date','views']='relevance'
    limit:Literal[20,40,60]=20
class JobIn(BaseModel):
    url:str=Field(max_length=2048)
    title:str=Field(default='',max_length=300)
    artist:str=Field(default='',max_length=200)
    duration:int=Field(default=0,ge=0,le=86400)
    thumbnail:str|None=Field(default=None,max_length=2048)
class Progress(BaseModel):
    stage:str=Field(max_length=40)
    percent:int|None=Field(default=None,ge=0,le=100)
class Complete(BaseModel):
    title:str=Field(max_length=300)
    artist:str=Field(max_length=200)
    duration:int=Field(ge=0,le=86400)
    source_codec:str|None=Field(default=None,max_length=20)
    peaks:list[int]|None=Field(default=None,max_length=1000)
class Fail(BaseModel): error:str=Field(max_length=500)
VIDEO_ID=r'^[A-Za-z0-9_-]{11}$'
class LibTrack(BaseModel):
    video_id:str=Field(pattern=VIDEO_ID)
    title:str=Field(max_length=300)
    artist:str=Field(max_length=200)
    duration:int=Field(ge=0,le=86400)
    codec:str|None=Field(default=None,max_length=20)
    trim_start:float|None=Field(default=None,ge=0,le=86400)
    trim_end:float|None=Field(default=None,gt=0,le=86400)
class LibPlaylist(BaseModel):
    id:str=Field(min_length=1,max_length=64)
    name:str=Field(max_length=100)
    tracks:list[str]=Field(max_length=5000)
class LibSync(BaseModel):
    tracks:list[LibTrack]=Field(default=[],max_length=2000)
    delete_tracks:list[str]=Field(default=[],max_length=2000)
    playlists:list[LibPlaylist]=Field(default=[],max_length=200)
    delete_playlists:list[str]=Field(default=[],max_length=200)
class Uploads(BaseModel):
    parts:int=Field(ge=1,le=40)
    size:int=Field(ge=1)

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
        # Library sync sends the whole list once on first backup; everything else is tiny.
        limit=512*1024 if request.url.path=='/api/library/sync' else 128*1024 if request.url.path=='/api/debug/playback' else 8192
        if int(request.headers.get('content-length','0'))>limit: return Response(status_code=413)
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
    import yt_dlp.version
    seen=await agent_seen()
    online=bool(seen) and time.time()-datetime.fromisoformat(seen).timestamp()<AGENT_ONLINE
    return {'yt_dlp':yt_dlp.version.__version__,'agent_online':online,'agent_last_seen':seen,'configured':True}

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
    proc=await spawn('search',body.query.strip(),body.sort,str(body.limit))
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

# ---------------------------------------------------------------------------
# Download queue. Windows PC agent does the YouTube work; Supabase holds the
# queue (jobs table) and the transient files (transfers bucket).
BUCKET='transfers'
JOB_FIELDS='id,video_id,title,artist,duration,thumbnail,status,progress,stage,error,created_at,ready_at,parts,size,source_codec,peaks'
AGENT_ONLINE=30
RETENTION_DAYS=3

def supabase():
    url=os.getenv('SUPABASE_URL','').rstrip('/');key=os.getenv('SUPABASE_SECRET_KEY','')
    if not url or not key: raise HTTPException(503,'서버 저장소(Supabase) 설정이 필요합니다.')
    import httpx
    return httpx.AsyncClient(base_url=url,headers={'apikey':key,'Authorization':'Bearer '+key},timeout=15)

async def sb(method,path,**kw):
    async with supabase() as c:
        r=await c.request(method,path,**kw)
    if r.status_code>=400:
        print('supabase',method,path,r.status_code,r.text[:300],file=sys.stderr,flush=True)
        raise HTTPException(502,'서버 저장소 요청에 실패했습니다.')
    return r.json() if r.content else None

def audio_paths(job_id,parts):
    # parts is None for jobs uploaded by an older agent as a single audio.m4a.
    return [f'{job_id}/audio.m4a'] if not parts else [f'{job_id}/audio.{i:03d}' for i in range(parts)]

def base(): return os.getenv('SUPABASE_URL','').rstrip('/')+'/storage/v1'

async def signed_downloads(paths):
    data=await sb('POST',f'/storage/v1/object/sign/{BUCKET}',json={'expiresIn':3600,'paths':paths})
    urls={d['path']:d.get('signedURL') for d in data}
    if any(not urls.get(p) for p in paths): raise HTTPException(502,'전송 파일을 찾을 수 없습니다.')
    return [base()+urls[p] for p in paths]

async def signed_upload(path):
    data=await sb('POST',f'/storage/v1/object/upload/sign/{BUCKET}/{path}',headers={'x-upsert':'true'})
    return base()+data['url']

async def remove_files(job_ids):
    for j in job_ids:
        listed=await sb('POST',f'/storage/v1/object/list/{BUCKET}',json={'prefix':j+'/','limit':1000})
        paths=[f'{j}/{o["name"]}' for o in listed or []]
        if paths: await sb('DELETE',f'/storage/v1/object/{BUCKET}',json={'prefixes':paths})

def job_id(value):
    if not re.fullmatch(r'[0-9a-f-]{36}',value): raise HTTPException(404,'작업을 찾을 수 없습니다.')
    return value

async def agent_seen():
    rows=await sb('GET','/rest/v1/agents',params={'select':'last_seen','order':'last_seen.desc','limit':'1'})
    return rows[0]['last_seen'] if rows else None

@app.post('/api/jobs')
async def create_job(body:JobIn,token=Depends(auth)):
    rate('jobs:'+token,60)
    video=canonical_url(body.url).rsplit('=',1)[1]
    existing=await sb('GET','/rest/v1/jobs',params={'select':JOB_FIELDS,'video_id':'eq.'+video,'status':'in.(queued,processing,ready)'})
    if existing: return existing[0]
    row={'video_id':video,'title':body.title or 'YouTube '+video,'artist':body.artist,'duration':body.duration,
         'thumbnail':body.thumbnail if (body.thumbnail or '').startswith('https://') else f'https://i.ytimg.com/vi/{video}/hqdefault.jpg'}
    rows=await sb('POST','/rest/v1/jobs',params={'select':JOB_FIELDS},json=row,headers={'Prefer':'return=representation'})
    return rows[0]

@app.get('/api/jobs')
async def list_jobs(token=Depends(auth)):
    rows=await sb('GET','/rest/v1/jobs',params={'select':JOB_FIELDS,'status':'in.(queued,processing,ready,failed)','order':'created_at.asc'})
    for row in rows:
        if row['status']=='ready':
            row['audio_urls']=await signed_downloads(audio_paths(row['id'],row['parts']))
            try: row['cover_url']=(await signed_downloads([row['id']+'/cover.jpg']))[0]
            except HTTPException: row['cover_url']=None
    seen=await agent_seen()
    online=bool(seen) and time.time()-datetime.fromisoformat(seen).timestamp()<AGENT_ONLINE
    return {'jobs':rows,'agent':{'online':online,'last_seen':seen}}

@app.post('/api/jobs/{id}/received')
async def received(id:str,token=Depends(auth)):
    id=job_id(id)
    rows=await sb('GET','/rest/v1/jobs',params={'select':'video_id,title,artist,duration,source_codec','id':'eq.'+id,'status':'eq.ready'})
    if rows:
        j=rows[0]
        # Text-only library backup; keep an existing row so titles edited on the phone survive a restore.
        await sb('POST','/rest/v1/library_tracks',json={'video_id':j['video_id'],'title':j['title'],'artist':j['artist'],'duration':j['duration'],'codec':j['source_codec']},
                 headers={'Prefer':'resolution=ignore-duplicates'})
    # The audio is on the phone now: drop the files and the job record.
    await remove_files([id])
    await sb('DELETE','/rest/v1/jobs',params={'id':'eq.'+id,'status':'eq.ready'})
    return {'ok':True}

@app.post('/api/jobs/{id}/retry')
async def retry(id:str,token=Depends(auth)):
    id=job_id(id)
    await sb('PATCH','/rest/v1/jobs',params={'id':'eq.'+id,'status':'eq.failed'},json={'status':'queued','error':None,'progress':None,'stage':None})
    return {'ok':True}

@app.delete('/api/jobs/{id}')
async def cancel_job(id:str,token=Depends(auth)):
    id=job_id(id)
    await sb('DELETE','/rest/v1/jobs',params={'id':'eq.'+id})
    await remove_files([id])
    return {'ok':True}

def agent(request:Request):
    expected=os.getenv('AGENT_TOKEN','')
    given=request.headers.get('authorization','').removeprefix('Bearer ')
    if len(expected)<32 or not hmac.compare_digest(given.encode(),expected.encode()): raise HTTPException(401,'에이전트 인증 실패')

def agent_name(request):
    return re.sub(r'[^\w.-]','',request.headers.get('x-agent-name','pc'))[:40] or 'pc'

async def touch_agent(request):
    await sb('POST','/rest/v1/agents',json={'id':agent_name(request),'last_seen':'now'},headers={'Prefer':'resolution=merge-duplicates'})

async def agent_job(id,status='processing'):
    rows=await sb('GET','/rest/v1/jobs',params={'select':'id','id':'eq.'+job_id(id),'status':'eq.'+status})
    if not rows: raise HTTPException(409,'이미 취소되었거나 처리 중이 아닌 작업입니다.')

@app.post('/api/agent/claim')
async def claim(request:Request,_=Depends(agent)):
    rows=await sb('POST','/rest/v1/rpc/claim_job',json={'agent':agent_name(request)})
    if not rows: return {'job':None}
    job=rows[0]
    out={k:job[k] for k in ('id','video_id','title','artist','duration','thumbnail')}|{'url':'https://www.youtube.com/watch?v='+job['video_id']}
    if request.headers.get('x-agent-version')!='2':
        # Older agents upload one audio.m4a straight after claiming.
        out['upload']={'audio':await signed_upload(job['id']+'/audio.m4a'),'cover':await signed_upload(job['id']+'/cover.jpg')}
    return {'job':out}

@app.post('/api/agent/jobs/{id}/uploads')
async def agent_uploads(request:Request,id:str,body:Uploads,_=Depends(agent)):
    await agent_job(id);await touch_agent(request)
    await sb('PATCH','/rest/v1/jobs',params={'id':'eq.'+id,'status':'eq.processing'},json={'parts':body.parts,'size':body.size})
    return {'audio':[await signed_upload(p) for p in audio_paths(id,body.parts)],'cover':await signed_upload(id+'/cover.jpg')}

@app.post('/api/agent/jobs/{id}/progress')
async def agent_progress(request:Request,id:str,body:Progress,_=Depends(agent)):
    await agent_job(id);await touch_agent(request)
    await sb('PATCH','/rest/v1/jobs',params={'id':'eq.'+id,'status':'eq.processing'},json={'stage':body.stage,'progress':body.percent})
    return {'ok':True}

@app.post('/api/agent/jobs/{id}/complete')
async def agent_complete(request:Request,id:str,body:Complete,_=Depends(agent)):
    await agent_job(id);await touch_agent(request)
    await sb('PATCH','/rest/v1/jobs',params={'id':'eq.'+id,'status':'eq.processing'},json={'status':'ready','title':body.title,'artist':body.artist,'duration':body.duration,'source_codec':body.source_codec,'peaks':[max(0,min(100,v)) for v in body.peaks] if body.peaks else None,'stage':'전송 대기','progress':100,'ready_at':'now'})
    await notify({'title':'저장 준비 완료','body':f'{body.title} · Tunely를 열면 보관함에 담아요.','tag':id})
    return {'ok':True}

@app.post('/api/agent/jobs/{id}/requeue')
async def agent_requeue(request:Request,id:str,_=Depends(agent)):
    # Used after the agent upgrades yt-dlp mid-run: try this song again with the new version.
    await agent_job(id);await touch_agent(request)
    await sb('PATCH','/rest/v1/jobs',params={'id':'eq.'+id,'status':'eq.processing'},json={'status':'queued','progress':None,'stage':None})
    return {'ok':True}

@app.post('/api/agent/jobs/{id}/fail')
async def agent_fail(request:Request,id:str,body:Fail,_=Depends(agent)):
    await agent_job(id);await touch_agent(request)
    await sb('PATCH','/rest/v1/jobs',params={'id':'eq.'+id,'status':'eq.processing'},json={'status':'failed','error':re.sub(r'\S*\?token=\S+','[URL]',body.error),'stage':None})
    await remove_files([id])
    rows=await sb('GET','/rest/v1/jobs',params={'select':'title','id':'eq.'+id})
    title=(rows[0].get('title') if rows else None) or '곡'
    await notify({'title':'저장 실패','body':f'{title} · 앱에서 다시 시도할 수 있어요.','tag':id})
    return {'ok':True}

@app.get('/api/cron/cleanup')
async def cleanup(request:Request):
    secret=os.getenv('CRON_SECRET','')
    if len(secret)<16 or not hmac.compare_digest(request.headers.get('authorization','').encode(),('Bearer '+secret).encode()): raise HTTPException(401)
    cutoff=datetime.fromtimestamp(time.time()-RETENTION_DAYS*86400,timezone.utc).isoformat()
    old=await sb('GET','/rest/v1/jobs',params={'select':'id','created_at':'lt.'+cutoff})
    ids=[r['id'] for r in old]
    for i in range(0,len(ids),50):
        await remove_files(ids[i:i+50])
        await sb('DELETE','/rest/v1/jobs',params={'id':'in.('+','.join(ids[i:i+50])+')'})
    return {'deleted':len(ids)}

# ---------------------------------------------------------------------------
# Library backup: titles, artists and playlists only (never audio), so the
# library can be re-requested after the phone loses its app data.
@app.get('/api/library')
async def library(token=Depends(auth)):
    tracks=await sb('GET','/rest/v1/library_tracks',params={'select':'video_id,title,artist,duration,codec,trim_start,trim_end,added_at','order':'added_at.asc'})
    playlists=await sb('GET','/rest/v1/library_playlists',params={'select':'id,name,tracks,updated_at','order':'updated_at.asc'})
    return {'tracks':tracks,'playlists':playlists}

def in_list(values):
    return 'in.('+','.join('"'+v.replace('"','')+'"' for v in values)+')'

@app.post('/api/library/sync')
async def library_sync(body:LibSync,token=Depends(auth)):
    rate('library:'+token,120)
    for t in body.delete_tracks:
        if not re.fullmatch(VIDEO_ID,t): raise HTTPException(400,'잘못된 곡 ID입니다.')
    merge={'Prefer':'resolution=merge-duplicates'}
    if body.tracks: await sb('POST','/rest/v1/library_tracks',json=[t.model_dump() for t in body.tracks],headers=merge)
    if body.playlists: await sb('POST','/rest/v1/library_playlists',json=[p.model_dump() for p in body.playlists],headers=merge)
    for i in range(0,len(body.delete_tracks),100):
        await sb('DELETE','/rest/v1/library_tracks',params={'video_id':in_list(body.delete_tracks[i:i+100])})
    for i in range(0,len(body.delete_playlists),100):
        await sb('DELETE','/rest/v1/library_playlists',params={'id':in_list(body.delete_playlists[i:i+100])})
    return {'ok':True}

# ---------------------------------------------------------------------------
# Web Push: tell the phone a song is ready. Only installed PWAs (iOS 16.4+) can subscribe.
class PushKeys(BaseModel):
    p256dh:str=Field(min_length=10,max_length=200)
    auth:str=Field(min_length=4,max_length=100)
class PushSub(BaseModel):
    endpoint:str=Field(max_length=1024)
    keys:PushKeys
class PushEndpoint(BaseModel): endpoint:str=Field(max_length=1024)

def push_ready():
    from backend import push
    if not push.configured(): raise HTTPException(503,'알림 설정(VAPID 키)이 필요합니다.')
    return push

@app.get('/api/push/key')
async def push_key(token=Depends(auth)):
    return {'key':push_ready().public_key()}

@app.post('/api/push/subscribe')
async def push_subscribe(body:PushSub,token=Depends(auth)):
    push=push_ready()
    if not push.allowed_endpoint(body.endpoint): raise HTTPException(400,'지원하지 않는 알림 주소입니다.')
    await sb('POST','/rest/v1/push_subscriptions',json={'endpoint':body.endpoint,'p256dh':body.keys.p256dh,'auth':body.keys.auth},headers={'Prefer':'resolution=merge-duplicates'})
    return {'ok':True}

@app.post('/api/push/unsubscribe')
async def push_unsubscribe(body:PushEndpoint,token=Depends(auth)):
    await sb('DELETE','/rest/v1/push_subscriptions',params={'endpoint':'eq.'+body.endpoint})
    return {'ok':True}

@app.post('/api/push/test')
async def push_test(token=Depends(auth)):
    rate('push:'+token,5)
    sent=await notify({'title':'Tunely 알림','body':'알림이 잘 도착했어요.','tag':'test'})
    if not sent: raise HTTPException(404,'알림을 받을 기기가 없습니다. 이 기기에서 알림을 다시 켜 주세요.')
    return {'sent':sent}

async def notify(message):
    """Send to every subscription; never fails the caller. Expired subscriptions are removed."""
    try:
        from backend import push
        if not push.configured(): return 0
        subs=await sb('GET','/rest/v1/push_subscriptions',params={'select':'endpoint,p256dh,auth'})
        subject=os.getenv('APP_ORIGIN') or 'https://tunely-play.vercel.app'
        import httpx
        sent=0
        async with httpx.AsyncClient(timeout=10) as c:
            for sub in subs:
                if not push.allowed_endpoint(sub['endpoint']): continue
                url,headers,body=push.request(sub,message,subject)
                try: r=await c.post(url,headers=headers,content=body)
                except httpx.HTTPError as e:
                    print('push error',type(e).__name__,file=sys.stderr,flush=True); continue
                if r.status_code in (404,410):
                    await sb('DELETE','/rest/v1/push_subscriptions',params={'endpoint':'eq.'+sub['endpoint']})
                elif r.status_code>=400: print('push',r.status_code,r.text[:200],file=sys.stderr,flush=True)
                else: sent+=1
        return sent
    except Exception as e:
        print('notify failed',type(e).__name__,str(e)[:200],file=sys.stderr,flush=True)
        return 0

# ---------------------------------------------------------------------------
# Temporary playback diagnostics (next track sometimes does not start on iPhone).
class PlaybackLog(BaseModel):
    device:str=Field(default='',max_length=300)
    events:list[dict]=Field(max_length=500)

@app.post('/api/debug/playback')
async def debug_playback(body:PlaybackLog,token=Depends(auth)):
    rate('playlog:'+token,30)
    await sb('POST','/rest/v1/playback_logs',json={'device':body.device,'events':body.events})
    return {'ok':True}
