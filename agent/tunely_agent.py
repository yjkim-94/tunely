"""Tunely Windows PC agent.

Polls the Tunely server for queued save requests, downloads the audio with
yt-dlp on this PC's home network, converts it to M4A with FFmpeg and uploads
the result to temporary storage. The iPhone app picks it up from there.
Run with run-agent.bat in the repository root. Stop with Ctrl+C.
"""
import os, re, shutil, socket, subprocess, sys, tempfile, time, unicodedata
from pathlib import Path
import requests, yt_dlp
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
load_dotenv(HERE / '.env')
# Everything the agent writes stays inside the repository folder (start-agent.ps1
# sets these); deleting the folder removes all of it.
TMP_ROOT = Path(os.getenv('TUNELY_TMP') or ROOT / 'tmp')
CACHE_ROOT = Path(os.getenv('TUNELY_CACHE') or ROOT / 'tools' / 'cache')
SERVER = os.getenv('TUNELY_URL', '').rstrip('/')
TOKEN = os.getenv('AGENT_TOKEN', '')
NAME = os.getenv('AGENT_NAME') or socket.gethostname()
POLL = 5
# YouTube changes often and yt-dlp follows quickly, so check while running too.
UPDATE_EVERY = 6 * 3600     # idle check for new yt-dlp / agent code
FORCED_UPDATE_GAP = 3600    # at most one extra check per hour after a download failure
EXIT_RESTART = 75           # start-agent.ps1: restart the agent (new yt-dlp installed)
EXIT_RELAUNCH = 76          # start-agent.ps1: relaunch itself (git pull, then start)
# Supabase free plan caps each upload at 50MB; long mixes are sent in pieces.
CHUNK = 40 * 1024 * 1024
# Prefer YouTube's AAC stream (itag 140, ~128kbps) so FFmpeg only remuxes it in
# seconds; fall back to Opus etc. (re-encoded) when a video has no m4a audio.
FORMAT = 'bestaudio[ext=m4a]/bestaudio/best'


class Cancelled(Exception):
    pass


_status = {'width': 0, 'at': 0.0}


def _width(text):
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in text)


def show(text, force=False):
    """Redraw one progress line in place (\r), at most ~4 times a second."""
    if not force and time.monotonic() - _status['at'] < 0.25:
        return
    _status['at'] = time.monotonic()
    line = '  ' + text
    pad = max(0, _status['width'] - _width(line))
    sys.stdout.write('\r' + line + ' ' * pad)
    sys.stdout.flush()
    _status['width'] = _width(line)


def bar(percent, size=20):
    filled = round(size * percent / 100) if percent is not None else 0
    return '[' + '#' * filled + '-' * (size - filled) + ']'


def log(*a):
    if _status['width']:
        sys.stdout.write('\n')
        _status['width'] = 0
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
    # Prefer the Deno installed into this agent's own virtualenv (PyPI "deno").
    local = Path(sys.executable).with_name('deno.exe' if os.name == 'nt' else 'deno')
    if local.is_file():
        return str(local)
    return os.getenv('DENO_PATH') or shutil.which('deno')


def _run(args, timeout=120):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                              env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    except (OSError, subprocess.TimeoutExpired):
        return None


def ytdlp_version():
    r = _run([sys.executable, '-c', 'import importlib.metadata as m; print(m.version("yt-dlp"))'], 30)
    return r.stdout.strip() if r and r.returncode == 0 else ''


def update_ytdlp():
    """Upgrade yt-dlp in this venv with the bundled uv. True if the version changed."""
    uv = os.getenv('TUNELY_UV')
    if not uv or not Path(uv).is_file():
        return False
    before = ytdlp_version()
    r = _run([uv, 'pip', 'install', '--python', sys.executable, '--quiet', '--upgrade', 'yt-dlp', 'yt-dlp-ejs'], 600)
    if not r or r.returncode:
        log('yt-dlp 업데이트 확인 실패(인터넷 연결 확인). 지금 버전으로 계속합니다.')
        return False
    after = ytdlp_version()
    if after and after != before:
        log(f'yt-dlp {before} → {after} 업데이트했습니다. 에이전트를 다시 시작합니다.')
        return True
    return False


def code_update_available():
    """New agent code on GitHub and no local edits (the launcher then pulls it)."""
    git = shutil.which('git')
    if not git or not (ROOT / '.git').exists():
        return False
    fetched = _run([git, '-C', str(ROOT), 'fetch', '--quiet'], 120)
    if not fetched or fetched.returncode:
        return False
    behind = _run([git, '-C', str(ROOT), 'rev-list', '--count', 'HEAD..@{u}'], 30)
    dirty = _run([git, '-C', str(ROOT), 'status', '--porcelain', '--untracked-files=no'], 30)
    return bool(behind and behind.stdout.strip().isdigit() and int(behind.stdout.strip()) > 0
                and dirty and not dirty.stdout.strip())


def loudness_outline(audio, duration, report, n=600):
    """~600 loudness values (0-100) for the phone's trim editor; a few KB, any length."""
    if not duration:
        return None
    report('파형 계산', None, True)
    k = max(1, -(-int(duration * 4000) // n))   # samples per value at 4 kHz mono
    try:
        r = subprocess.run([ffmpeg(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-i', str(audio), '-af',
                            f'aresample=4000,aformat=channel_layouts=mono,asetnsamples=n={k}:p=0,'
                            'astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-',
                            '-f', 'null', '-'], capture_output=True, text=True, timeout=900)
    except (OSError, subprocess.TimeoutExpired):
        return None
    levels = []
    for line in r.stdout.splitlines():
        if 'RMS_level=' in line:
            value = line.split('=', 1)[1].strip()
            try:
                levels.append(10 ** (float(value) / 20))
            except ValueError:            # '-inf' = silence
                levels.append(0.0)
    if not levels:
        return None
    top = max(levels) or 1
    return [round(v / top * 100) for v in levels[:1000]]


def clean_tmp():
    """Remove leftovers from a previous run that was killed mid-download."""
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    for child in TMP_ROOT.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            try:
                child.unlink()
            except OSError:
                pass


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

    def report(stage, percent=None, force=False, detail=''):
        text = stage + ' ' * max(1, 9 - _width(stage)) + f'{bar(percent)} ' + (f'{percent:3d}%' if percent is not None else '  …') + (f'  {detail}' if detail else '')
        show(text, force or percent == 100)
        if force or time.monotonic() - last[0] > 3:
            last[0] = time.monotonic()
            call(f'jobs/{jid}/progress', {'stage': stage, 'percent': percent})

    def hook(d):
        if d.get('status') == 'downloading':
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            done = d.get('downloaded_bytes', 0)
            speed = d.get('speed')
            detail = f'{done / 2**20:.1f}/{total / 2**20:.1f} MB' if total else f'{done / 2**20:.1f} MB'
            if speed:
                detail += f' · {speed / 2**20:.1f} MB/s'
            report('다운로드', min(100, round(done / total * 100)) if total else None, detail=detail)

    report('다운로드', None, True)
    opts = {'quiet': True, 'no_warnings': True, 'noplaylist': True, 'socket_timeout': 20, 'retries': 3,
            'fragment_retries': 3, 'format': FORMAT, 'outtmpl': str(folder / 'source.%(ext)s'),
            'progress_hooks': [hook], 'remote_components': ['ejs:github'],
            'cachedir': str(CACHE_ROOT / 'yt-dlp')}
    if deno():
        opts['js_runtimes'] = {'deno': {'path': deno()}}
    with yt_dlp.YoutubeDL(opts) as y:
        info = y.extract_info(job['url'], download=True)
        source = Path(y.prepare_filename(info))

    copy = (info.get('acodec') or '').startswith(('mp4a', 'aac'))
    stage = 'M4A 정리' if copy else 'M4A 변환'
    report(stage, 0, True, '원본이 AAC라 재인코딩 없이 복사' if copy else '')
    audio = folder / 'audio.m4a'
    codec = ['-c:a', 'copy'] if copy else ['-c:a', 'aac', '-q:a', '1']
    total_us = (info.get('duration') or job.get('duration') or 0) * 1_000_000
    started = time.monotonic()
    # -progress pipe:1 prints key=value lines; out_time_us is how far FFmpeg has written.
    proc = subprocess.Popen([ffmpeg(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-nostats',
                             '-progress', 'pipe:1', '-y', '-i', str(source), '-vn', *codec,
                             '-movflags', '+faststart', str(audio)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace')
    for raw in proc.stdout:
        key, _, value = raw.strip().partition('=')
        if key in ('out_time_us', 'out_time_ms') and value.isdigit() and total_us:
            done = int(value)
            pct = min(99, round(done / total_us * 100))
            elapsed = time.monotonic() - started
            left = int(elapsed / done * (total_us - done)) if done else 0
            eta = (f' · 남은 시간 약 {left // 60}분 {left % 60}초' if left >= 60 else f' · 남은 시간 약 {left}초') if pct > 2 else ''
            report(stage, pct, detail=f'{done // 60_000_000}분/{int(total_us) // 60_000_000}분{eta}')
    err = proc.stderr.read()
    proc.wait()
    if proc.returncode or not audio.is_file() or not audio.stat().st_size:
        raise RuntimeError('M4A 변환 실패: ' + (err or '')[-200:])
    report(stage, 100, True, f'{time.monotonic() - started:.0f}초')

    peaks = loudness_outline(audio, info.get('duration') or job.get('duration') or 0, report)

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
            report('업로드', round(i / parts * 100), True, f'조각 {i + 1}/{parts} · 전체 {size / 2**20:.1f} MB')
            upload(url, f.read(CHUNK), 'audio/mp4')
    if cover.is_file() and cover.stat().st_size:
        upload(urls['cover'], cover.read_bytes(), 'image/jpeg')
    report('업로드', 100, True, f'조각 {parts}/{parts} · 전체 {size / 2**20:.1f} MB')
    call(f'jobs/{jid}/complete', {'title': info.get('title') or job['title'],
                                  'artist': info.get('channel') or info.get('uploader') or job['artist'] or '알 수 없음',
                                  'duration': int(info.get('duration') or job['duration'] or 0),
                                  'peaks': peaks,
                                  # 'aac' = YouTube's AAC stream copied as is; otherwise the codec we converted from.
                                  'source_codec': 'aac' if copy else (info.get('acodec') or 'unknown').split('.')[0][:20]})
    return size, parts


def main():
    if not SERVER.startswith('https://') and not SERVER.startswith('http://127.0.0.1'):
        sys.exit('agent/.env의 TUNELY_URL을 https://... 형식으로 설정하세요.')
    if len(TOKEN) < 32:
        sys.exit('agent/.env의 AGENT_TOKEN을 설정하세요.')
    log(f'Tunely 에이전트 시작 · {NAME} · {SERVER}')
    clean_tmp()
    log(f'yt-dlp {yt_dlp.version.__version__} · Deno {"있음" if deno() else "없음(설치 권장)"} · FFmpeg {ffmpeg()}')
    log(f'임시 폴더 {TMP_ROOT}')
    idle = False
    last_check = time.monotonic()      # the launcher just updated everything
    last_forced = 0.0
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
            if time.monotonic() - last_check > UPDATE_EVERY:
                last_check = time.monotonic()
                if code_update_available():
                    log('새 버전 코드가 있어 받으러 다시 시작합니다.')
                    sys.exit(EXIT_RELAUNCH)
                if update_ytdlp():
                    sys.exit(EXIT_RESTART)
            time.sleep(POLL)
            continue
        idle = False
        log(f'처리 시작: {job["title"]} ({job["url"]})')
        folder = Path(tempfile.mkdtemp(prefix='tunely-', dir=TMP_ROOT))
        try:
            size, parts = process(job, folder)
            log(f'  완료 · {size / 1024 / 1024:.1f} MB · {parts}개 조각 업로드')
        except Cancelled:
            log('  iPhone에서 취소된 작업입니다.')
        except Exception as e:
            # Never store signed URLs (they carry upload tokens) in logs or the DB.
            msg = re.sub(r'https?://\S+', '[URL]', str(e).replace('\x1b', ''))[-400:] or '처리 실패'
            log('  실패:', msg)
            # A download error is often YouTube changing something; a newer yt-dlp may fix it.
            if isinstance(e, yt_dlp.utils.DownloadError) and time.monotonic() - last_forced > FORCED_UPDATE_GAP:
                last_forced = time.monotonic()
                log('  yt-dlp 새 버전을 확인합니다…')
                if update_ytdlp():
                    try:
                        call(f'jobs/{job["id"]}/requeue')
                        log('  이 곡은 대기열로 되돌려 새 버전으로 다시 시도합니다.')
                    except Exception:
                        pass
                    shutil.rmtree(folder, ignore_errors=True)
                    sys.exit(EXIT_RESTART)
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
        clean_tmp()
        log('종료합니다.')
