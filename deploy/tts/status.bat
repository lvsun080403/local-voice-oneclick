@echo off
cd /d "%~dp0"
title Qwen3-TTS-1.7B Status
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1" -Status %*
echo.
pause >nul