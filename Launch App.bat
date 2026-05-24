@echo off
cd /d "%~dp0"
title MineractAI

echo.
echo  =============================================
echo   MineractAI Companion - Starting up
echo  =============================================
echo.

:: Create logs directory alongside data/
if not exist "data\logs\" mkdir "data\logs"

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
  echo  [SETUP] node_modules not found - running npm install...
  echo  (This only happens once, may take a minute)
  echo.
  call npm install 2>&1
  if errorlevel 1 (
    echo.
    echo  [ERROR] npm install failed. Make sure Node.js 18+ is installed.
    echo  Download from: https://nodejs.org
    pause
    exit /b 1
  )
  echo.
  echo  [OK] Dependencies installed.
  echo.
)

:: Stamp a launch header into the launch log
set LOGFILE=data\logs\launch.log
echo. >> %LOGFILE%
echo ================================================ >> %LOGFILE%
echo  LAUNCH  %DATE% %TIME% >> %LOGFILE%
echo ================================================ >> %LOGFILE%

echo  Launching Electron app...
echo  Console output is mirrored to: %LOGFILE%
echo  Full structured logs: data\logs\app.log  bot.log  llm.log  errors.log
echo.

:: Run electron — stdout+stderr go to launch log AND console
node_modules\.bin\electron.cmd . 2>&1 | tee -a %LOGFILE%
set EXIT_CODE=%ERRORLEVEL%

if %EXIT_CODE% neq 0 (
  echo. >> %LOGFILE%
  echo [EXIT CODE %EXIT_CODE%] >> %LOGFILE%
  echo.
  echo  -----------------------------------------------
  echo  App exited with code %EXIT_CODE%
  echo  See data\logs\launch.log for details
  echo  -----------------------------------------------
)

echo.
pause
