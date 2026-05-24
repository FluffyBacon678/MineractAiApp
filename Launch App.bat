@echo off
cd /d "%~dp0"
title MineractAI

echo.
echo  =============================================
echo   MineractAI Companion - Starting up
echo  =============================================
echo.

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
  echo  [SETUP] node_modules not found - running npm install...
  echo  (This only happens once, may take a minute)
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  [ERROR] npm install failed. Make sure Node.js is installed.
    echo  Download from: https://nodejs.org
    pause
    exit /b 1
  )
  echo.
  echo  [OK] Dependencies installed.
  echo.
)

echo  Launching Electron app...
echo.
npm start

if errorlevel 1 (
  echo.
  echo  [ERROR] App exited with an error. See above for details.
  pause
)
