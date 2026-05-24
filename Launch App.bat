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

:: Create data directory if needed
if not exist "data\" mkdir data

echo  Launching Electron app...
echo  If you see an error below, it will also be saved to: launch-error.log
echo.

:: Run and tee output to log file, always pause at end
node_modules\.bin\electron.cmd . > launch-error.log 2>&1
set EXIT_CODE=%errorlevel%

type launch-error.log

if %EXIT_CODE% neq 0 (
  echo.
  echo  -----------------------------------------------
  echo  [ERROR] App exited with code %EXIT_CODE%
  echo  Full log saved to: launch-error.log
  echo  -----------------------------------------------
)

echo.
pause
