@echo off
cd /d "%~dp0"
title Qwen3-ASR-1.7B Stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\serve.ps1" -Stop %*
echo.
pause >nul