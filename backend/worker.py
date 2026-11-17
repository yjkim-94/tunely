"""Isolated yt-dlp/FFmpeg process. stdout is a JSON-lines protocol."""
import json, os, shutil, subprocess, sys
from pathlib import Path
import yt_dlp

def emit(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)

def runtime():
    root=Path(__file__).resolve().parent.parent
    paths=[os.getenv('DENO_PATH'),shutil.which('deno'),str(root/'node_modules/deno/deno'),str(root/'node_modules/@deno/linux-x64-glibc/deno')]
    return next((p for p in paths if p and Path(p).is_file()),None)

def metadata(info):
    return {'id':info['id'],'title':info.get('title') or '제목 없음','artist':info.get('channel') or info.get('uploader') or '알 수 없음','duration':info.get('duration') or 0,'thumbnail':info.get('thumbnail') or f"https://i.ytimg.com/vi/{info['id']}/hqdefault.jpg",'url':f"https://www.youtube.com/watch?v={info['id']}"}

class Logger:
    def debug(self,msg): pass
    def warning(self,msg): pass
    def error(self,msg): print(msg,file=sys.stderr,flush=True)

def run():
    mode,target=sys.argv[1:3]
    opts={'quiet':True,'no_warnings':True,'logger':Logger(),'noplaylist':True,'socket_timeout':15,'retries':1,'fragment_retries':1,'cachedir':False,'remote_components':['ejs:github'],'js_runtimes':{'deno':{'path':runtime()}} if runtime() else {}}
    if mode=='search':
        opts.update({'extract_flat':'in_playlist','skip_download':True,'ignoreerrors':False})
        with yt_dlp.YoutubeDL(opts) as y:
            info=y.extract_info('ytsearch20:'+target,download=False)
            emit(type='results',items=[metadata(x) for x in (info or {}).get('entries',[]) if x and x.get('id')])
        return
    folder=Path(sys.argv[3]); last=[0]
    def progress(d):
        import time
        if time.monotonic()-last[0]>0.7:
            last[0]=time.monotonic(); total=d.get('total_bytes') or d.get('total_bytes_estimate')
            emit(type='progress',stage='다운로드',percent=round(d.get('downloaded_bytes',0)/total*100) if total else None)
    opts.update({'format':'bestaudio/best','outtmpl':str(folder/'source.%(ext)s'),'progress_hooks':[progress]})
    with yt_dlp.YoutubeDL(opts) as y:
        info=y.extract_info(target,download=True)
        source=Path(y.prepare_filename(info))
    import imageio_ffmpeg
    ffmpeg=os.getenv('FFMPEG_PATH') or imageio_ffmpeg.get_ffmpeg_exe()
    emit(type='progress',stage='M4A 변환',percent=None)
    output=folder/'audio.m4a'
    codec=['-c:a','copy'] if info.get('acodec','').startswith(('mp4a','aac')) else ['-c:a','aac','-q:a','1']
    result=subprocess.run([ffmpeg,'-nostdin','-hide_banner','-loglevel','error','-y','-i',str(source),'-vn',*codec,'-movflags','+faststart',str(output)],capture_output=True)
    if result.returncode or not output.is_file() or not output.stat().st_size: raise RuntimeError('M4A 변환 실패')
    emit(type='ready',track=metadata(info))

if __name__=='__main__':
    try: run()
    except Exception as e:
        print(str(e),file=sys.stderr,flush=True);sys.exit(1)
