@echo off
title ClipCut for YouTube - Uninstall
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Uninstall
echo.
pause
