@echo off
setlocal
cd /d "%~dp0"
echo Minecraft AI Companion - first-time setup
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found. Please install the LTS version from https://nodejs.org/ and run this again.
  pause
  exit /b 1
)
if not exist .env if exist .env.example copy .env.example .env >nul
call npm install
if errorlevel 1 pause & exit /b 1
call npm start
