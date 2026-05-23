@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the Node.js LTS version from https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo Dependencies are missing. Running npm install first...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
call npm start
