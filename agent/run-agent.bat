@echo off
chcp 65001 >nul
cd /d "%~dp0\.."
if not exist ".venv\Scripts\python.exe" (
  echo [Tunely] Python 가상환경을 만듭니다...
  py -3.12 -m venv .venv || goto :error
  ".venv\Scripts\python.exe" -m pip install -r agent\requirements.txt || goto :error
)
if not exist "agent\.env" (
  echo [Tunely] agent\.env 파일이 없습니다. agent\.env.example을 복사해 값을 채우세요.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install -q -U yt-dlp yt-dlp-ejs
".venv\Scripts\python.exe" agent\tunely_agent.py
pause
exit /b 0
:error
echo [Tunely] 설치에 실패했습니다. Python 3.12 설치 여부를 확인하세요.
pause
exit /b 1
