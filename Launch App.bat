@echo off
cd /d "%~dp0"
title MineractAI

echo.
echo  =============================================
echo   MineractAI Companion - Starting up
echo  =============================================
echo.

:: Create logs directory
if not exist "data\logs\" mkdir "data\logs"

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
  echo  [SETUP] node_modules not found - running npm install...
  echo  (This only happens once, may take a minute)
  echo.
  call npm install
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

:: Stamp launch header into launch log
echo. >> data\logs\launch.log
echo ================================================ >> data\logs\launch.log
echo  LAUNCH  %DATE% %TIME% >> data\logs\launch.log
echo ================================================ >> data\logs\launch.log

echo  Starting Electron...
echo  Structured logs will appear in: data\logs\
echo    app.log    ^<^- everything
echo    bot.log    ^<^- connection and chat
echo    llm.log    ^<^- AI calls with timing
echo    errors.log ^<^- warnings and errors only
echo    launch.log ^<^- startup / crash output
echo.

:: Run Electron — redirect stderr to launch log so pre-logger crashes are captured
:: stdout stays visible in this window; the app itself writes structured logs directly
node_modules\.bin\electron.cmd . 2>> data\logs\launch.log
set APP_EXIT=%ERRORLEVEL%

:: If it crashed before the app wrote anything, show the launch log
if %APP_EXIT% neq 0 (
  echo.
  echo  -----------------------------------------------
  echo  [ERROR] Electron exited with code %APP_EXIT%
  echo  -----------------------------------------------
  echo.
  echo  --- data\logs\launch.log ---
  type data\logs\launch.log
  echo.
  echo  --- data\logs\errors.log ---
  if exist data\logs\errors.log type data\logs\errors.log
  echo.
  echo  -----------------------------------------------
)

echo.
pause
