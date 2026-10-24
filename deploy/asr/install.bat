@echo off
cd /d "%~dp0"
title Qwen3-ASR-1.7B Install
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
echo [i] Install finished. Press any key to close this window.
pause >nul