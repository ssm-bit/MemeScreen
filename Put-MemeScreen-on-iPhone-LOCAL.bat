@echo off
rem Same as Put-MemeScreen-on-iPhone.bat but serves the website from this laptop (for working on the code before it is pushed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0iphone-setup.ps1" -Local
pause
