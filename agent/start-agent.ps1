#Requires -Version 5.1
<#
  Tunely PC agent launcher (called by run-agent.bat).

  Everything is installed inside the repository folder; nothing is installed
  system-wide and PATH is not changed. Delete the folder to remove all of it.

    tools\uv\uv.exe        uv (from PyPI, hash-checked)
    tools\python\          Python 3.12 managed by uv (no registry, no PATH entry)
    tools\venv\            agent virtualenv (yt-dlp, FFmpeg, Deno, ...)
    tools\cache\           uv / yt-dlp / Deno caches
    tmp\                   per-song work folders, emptied on start and exit
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Root 'tools'
$Tmp = Join-Path $Root 'tmp'
$Venv = Join-Path $Tools 'venv'
$Py = Join-Path $Venv 'Scripts\python.exe'
$UvDir = Join-Path $Tools 'uv'
$Uv = Join-Path $UvDir 'uv.exe'
$UvVersion = '0.13.6'
$PythonVersion = '3.12'
$Requirements = Join-Path $PSScriptRoot 'requirements.txt'

function Say([string]$Message) { Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message) }
function Fail([string]$Message) { Write-Host ''; Write-Host "[Tunely] $Message" -ForegroundColor Red; exit 1 }

# Keep uv, Python, Deno and temp files inside this folder.
$env:UV_CACHE_DIR = Join-Path $Tools 'cache\uv'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $Tools 'python'
$env:UV_PYTHON_PREFERENCE = 'only-managed'
$env:UV_NO_CONFIG = '1'
$env:DENO_DIR = Join-Path $Tools 'cache\deno'
$env:TUNELY_TMP = $Tmp
$env:TUNELY_CACHE = Join-Path $Tools 'cache'
$env:TEMP = $Tmp
$env:TMP = $Tmp
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONUTF8 = '1'
$env:GIT_TERMINAL_PROMPT = '0'
New-Item -ItemType Directory -Force -Path $Tools, $Tmp | Out-Null

# 1. Update the code from GitHub before anything else.
if ($env:TUNELY_UPDATED -ne '1') {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git -or -not (Test-Path (Join-Path $Root '.git'))) {
        Say '자동 업데이트 건너뜀: git이 없거나 ZIP으로 받은 폴더입니다.'
    } else {
        $dirty = & git -C $Root status --porcelain --untracked-files=no
        if ($dirty) {
            Say '자동 업데이트 건너뜀: 폴더 안 코드를 직접 고친 내용이 있습니다.'
        } else {
            $before = & git -C $Root rev-parse HEAD
            Say '최신 코드 확인 중…'
            & git -C $Root pull --ff-only --quiet
            if ($LASTEXITCODE -ne 0) {
                Say '자동 업데이트 실패(인터넷 연결 확인). 지금 코드로 계속합니다.'
            } else {
                $after = & git -C $Root rev-parse HEAD
                if ($after -ne $before) {
                    Say "새 버전으로 업데이트했습니다 ($($before.Substring(0, 7)) → $($after.Substring(0, 7))). 다시 시작합니다."
                    $env:TUNELY_UPDATED = '1'
                    & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath
                    exit $LASTEXITCODE
                }
            }
        }
    }
}

# 2. uv (single exe, taken from the official PyPI wheel and checked against its SHA-256).
$haveUv = $false
if (Test-Path $Uv) { $haveUv = ((& $Uv --version) -match [regex]::Escape($UvVersion)) }
if (-not $haveUv) {
    Say "uv $UvVersion 설치 중…"
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win_arm64' } else { 'win_amd64' }
    try {
        $meta = Invoke-RestMethod -UseBasicParsing "https://pypi.org/pypi/uv/$UvVersion/json"
    } catch { Fail "uv 정보를 받지 못했습니다. 인터넷 연결을 확인하세요. ($($_.Exception.Message))" }
    $file = $meta.urls | Where-Object { $_.filename -like "*-$arch.whl" } | Select-Object -First 1
    if (-not $file) { Fail "이 PC($arch)용 uv를 찾지 못했습니다." }
    New-Item -ItemType Directory -Force -Path $UvDir | Out-Null
    $zip = Join-Path $Tmp 'uv-wheel.zip'
    $unpack = Join-Path $Tmp 'uv-wheel'
    Invoke-WebRequest -UseBasicParsing -Uri $file.url -OutFile $zip
    $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
    if ($hash -ne $file.digests.sha256) { Remove-Item -Force $zip; Fail 'uv 파일 검증(SHA-256)에 실패했습니다. 다시 실행해 주세요.' }
    if (Test-Path $unpack) { Remove-Item -Recurse -Force $unpack }
    Expand-Archive -Path $zip -DestinationPath $unpack
    Copy-Item -Force (Join-Path $unpack "uv-$UvVersion.data\scripts\uv.exe") $Uv
    Remove-Item -Recurse -Force $unpack, $zip
}

# 3. Python + virtualenv, only inside tools\.
if (-not (Test-Path $Py)) {
    Say "Python $PythonVersion 설치 중… (처음 한 번, 1~2분)"
    & $Uv python install $PythonVersion --no-bin --no-registry
    if ($LASTEXITCODE -ne 0) { Fail 'Python 설치에 실패했습니다. 인터넷 연결을 확인하세요.' }
    & $Uv venv $Venv --python $PythonVersion --quiet
    if ($LASTEXITCODE -ne 0) { Fail '가상환경을 만들지 못했습니다.' }
    Remove-Item -Force (Join-Path $Venv '.requirements-hash') -ErrorAction SilentlyContinue
}

# 4. Packages: full install when agent\requirements.txt changes, otherwise only refresh yt-dlp.
$reqHash = (Get-FileHash -Algorithm SHA256 $Requirements).Hash
$hashFile = Join-Path $Venv '.requirements-hash'
$installed = if (Test-Path $hashFile) { (Get-Content $hashFile -Raw).Trim() } else { '' }
if ($installed -ne $reqHash) {
    Say '패키지 설치 중… (yt-dlp, FFmpeg, Deno)'
    & $Uv pip install --python $Py --quiet -r $Requirements
    if ($LASTEXITCODE -ne 0) { Fail '패키지 설치에 실패했습니다. 인터넷 연결을 확인하세요.' }
    Set-Content -Path $hashFile -Value $reqHash -Encoding ASCII
}
Say 'yt-dlp 최신 버전 확인 중…'
& $Uv pip install --python $Py --quiet --upgrade yt-dlp yt-dlp-ejs
if ($LASTEXITCODE -ne 0) { Say 'yt-dlp 업데이트를 건너뜁니다(인터넷 연결 확인).' }

# 5. The previous launcher made a .venv from system Python in the repo root; it is no longer used.
$oldVenv = Join-Path $Root '.venv'
if (Test-Path (Join-Path $oldVenv 'Scripts\python.exe')) {
    Say '이전 방식의 .venv 폴더를 삭제합니다.'
    Remove-Item -Recurse -Force $oldVenv -ErrorAction SilentlyContinue
}

# 6. Run.
if (-not (Test-Path (Join-Path $PSScriptRoot '.env'))) {
    Fail 'agent\.env 파일이 없습니다. agent\.env.example을 복사해 TUNELY_URL과 AGENT_TOKEN을 채우세요.'
}
try {
    & $Py (Join-Path $PSScriptRoot 'tunely_agent.py')
} finally {
    Get-ChildItem -Force $Tmp -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
