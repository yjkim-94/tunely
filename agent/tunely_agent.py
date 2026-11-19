"""Tunely Windows PC agent.

Polls the Tunely server for queued save requests, downloads the audio with
yt-dlp on this PC's home network, converts it to M4A with FFmpeg and uploads
the result to temporary storage. The iPhone app picks it up from there.
Run with run-agent.bat. Stop with Ctrl+C.
"""
import os, re, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
import requests, yt_dlp
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / '.env')
SERVER = os.getenv('TUNELY_URL', '').rstrip('/')
TOKEN = os.getenv('AGENT_TOKEN', '')
NAME = os.getenv('AGENT_NAME') or socket.gethostname()
POLL = 5
# Supabase free plan caps each upload at 50MB; long mixes are sent in pieces.
CHUNK = 40 * 1024 * 1024


class Cancelled(Exception):
    pass


def log(*a):
    print(time.strftime('[%H:%M:%S]'), *a, flush=True)


def call(path, body=None):
    r = requests.post(SERVER + '/api/agent/' + path, json=body or {}, timeout=30,
                      headers={'Authorization': 'Bearer ' + TOKEN, 'X-Agent-Name': NAME, 'X-Agent-Version': '2'})
    if r.status_code == 409:
        raise Cancelled()
    r.raise_for_status()
    return r.json()


def ffmpeg():
    if os.getenv('FFMPEG_PATH'):
        return os.environ['FFMPEG_PATH']
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def deno():
    return os.getenv('DENO_PATH') or shutil.which('deno')


def upload(url, data, kind):
    for attempt in range(3):
        try:
            r = requests.put(url, data=data, timeout=300, headers={'Content-Type': kind, 'x-upsert': 'true'})
            if r.status_code >= 400:
                try:
                    detail = r.json().get('message') or r.text
                except ValueError:
                    detail = r.text
                raise RuntimeError(f'업로드 실패 (HTTP {r.status_code}): {detail[:150]}')
            return
        except (requests.RequestException, RuntimeError):
            if attempt == 2:
                raise
            time.sleep(5)


def process(job, folder):
    jid = job['id']
    last = [0.0]

    def report(stage, percent=None, force=False):
        if force or time.monotonic() - last[0] > 3:
            last[0] = time.monotonic()
            call(f'jobs/{jid}/progress', {'stage': stage, 'percent': percent})

    def hook(d):
        if d.get('status') == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            report('다운로드', round(d.get('downloaded_bytes', 0) / total * 100) if total else None)

    report('다운로드', None, True)
    opts = {'quiet': True, 'no_warnings': True, 'noplaylist': True, 'socket_timeout': 20, 'retries': 3,
            'fragment_retries': 3, 'format': 'bestaudio/best', 'outtmpl': str(folder / 'source.%(ext)s'),
            'progress_hooks': [hook], 'remote_components': ['ejs:github']}
    if deno():
        opts['js_runtimes'] = {'deno': {'path': deno()}}
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(job['url'], download=True)
        source = Path(y.prepare_filename(info))

    report('M4A 변환', None, True)
    audio = folder / 'audio.m4a'
    codec = ['-c:a', 'copy'] if (info.get('acodec') or '').startswith(('mp4a', 'aac')) else ['-c:a', 'aac', '-q:a', '1']
    r = subprocess.run([ffmpeg(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(source), '-vn',
                        *codec, '-movflags', '+faststart', str(audio)], capture_output=True, text=True)
    if r.returncode or not audio.is_file() or not audio.stat().st_size:
        raise RuntimeError('M4A 변환 실패: ' + (r.stderr or '')[-200:])

    cover = folder / 'cover.jpg'
    try:
        thumb = info.get('thumbnail') or job.get('thumbnail')
        if thumb:
            raw = folder / 'thumb'
            raw.write_bytes(requests.get(thumb, timeout=20).content)
            subprocess.run([ffmpeg(), '-nostdin', '-loglevel', 'error', '-y', '-i', str(raw),
                            '-vf', "scale='min(640,iw)':-2", '-frames:v', '1', str(cover)], capture_output=True)
    except Exception as e:
        log('  썸네일 실패(음원만 전송):', e)

    size = audio.stat().st_size
    parts = -(-size // CHUNK)
    urls = call(f'jobs/{jid}/uploads', {'parts': parts, 'size': size})
    with audio.open('rb') as f:
        for i, url in enumerate(urls['audio']):
            report('업로드', round(i / parts * 100), True)
            upload(url, f.read(CHUNK), 'audio/mp4')
    if cover.is_file() and cover.stat().st_size:
        upload(urls['cover'], cover.read_bytes(), 'image/jpeg')
    call(f'jobs/{jid}/complete', {'title': info.get('title') or job['title'],
                                  'artist': info.get('channel') or info.get('uploader') or job['artist'] or '알 수 없음',
                                  'duration': int(info.get('duration') or job['duration'] or 0)})
    return size, parts


def main():
    if not SERVER.startswith('https://') and not SERVER.startswith('http://127.0.0.1'):
        sys.exit('agent/.env의 TUNELY_URL을 https://... 형식으로 설정하세요.')
    if len(TOKEN) < 32:
        sys.exit('agent/.env의 AGENT_TOKEN을 설정하세요.')
    log(f'Tunely 에이전트 시작 · {NAME} · {SERVER}')
    log(f'yt-dlp {yt_dlp.version.__version__} · Deno {"있음" if deno() else "없음(설치 권장)"} · FFmpeg {ffmpeg()}')
    idle = False
    while True:
        try:
            job = call('claim').get('job')
        except requests.RequestException as e:
            log('서버 연결 실패, 30초 후 재시도:', e)
            time.sleep(30)
            continue
        if not job:
            if not idle:
                log('대기 중… (Ctrl+C로 종료)')
                idle = True
            time.sleep(POLL)
            continue
        idle = False
        log(f'처리 시작: {job["title"]} ({job["url"]})')
        folder = Path(tempfile.mkdtemp(prefix='tunely-'))
        try:
            size, parts = process(job, folder)
            log(f'  완료 · {size / 1024 / 1024:.1f} MB · {parts}개 조각 업로드')
        except Cancelled:
            log('  iPhone에서 취소된 작업입니다.')
        except Exception as e:
            # Never store signed URLs (they carry upload tokens) in logs or the DB.
            msg = re.sub(r'https?://\S+', '[URL]', str(e).replace('\x1b', ''))[-400:] or '처리 실패'
            log('  실패:', msg)
            try:
                call(f'jobs/{job["id"]}/fail', {'error': msg})
            except Exception:
                pass
        finally:
            shutil.rmtree(folder, ignore_errors=True)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        log('종료합니다.')
