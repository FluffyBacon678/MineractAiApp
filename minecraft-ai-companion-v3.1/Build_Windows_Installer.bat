@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js LTS first: https://nodejs.org/
  pause
  exit /b 1
)
call npm install
if errorlevel 1 pause & exit /b 1
call npm run dist:win
if errorlevel 1 pause & exit /b 1
echo.
echo Build complete. Check the dist folder for the installer and portable EXE.
pause
