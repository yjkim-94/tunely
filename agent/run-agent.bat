@echo off
chcp 65001 >nul
rem All setup and the agent itself live in start-agent.ps1 (it may update this folder while running).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-agent.ps1" & pause & exit /b
