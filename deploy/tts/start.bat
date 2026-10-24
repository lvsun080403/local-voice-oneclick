@echo off
cd /d "%~dp0"
title Qwen3-TTS-1.7B Server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1" -Background %*
echo.
echo [i] This window can be closed. The server keeps running in background.
echo [i] Use stop.bat to shut it down, status.bat to check.
pause >nul