@echo off
title Build MemeScreen for hosting
cd /d "%~dp0memescreen"
echo Building the site...
call npm install
call npm run build
if not exist "dist\index.html" (echo Build failed. Scroll up for the error. & pause & exit /b 1)
echo.
echo Done. A folder window and the Netlify Drop page will open.
echo Drag the "dist" folder onto the Netlify page. It gives you a link like https://something.netlify.app
echo Paste that link into a new text file named hosted-url.txt in the memescreen-project folder.
start "" explorer "%~dp0memescreen"
start "" https://app.netlify.com/drop
echo.
pause
