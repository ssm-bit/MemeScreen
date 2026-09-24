@echo off
title MemeScreen on phones (any network)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iphone-setup.ps1" -Anywhere
echo.
pause
