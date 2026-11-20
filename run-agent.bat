@echo off
chcp 65001 >nul
rem Tunely PC agent. Setup and the agent itself live in agent\start-agent.ps1 (it may update this folder while running).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agent\start-agent.ps1" & pause & exit /b
