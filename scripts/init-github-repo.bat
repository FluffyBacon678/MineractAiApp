@echo off
echo Initializing local Git repository for Minecraft AI Companion...
where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not in PATH.
  echo Install Git for Windows or use GitHub Desktop.
  pause
  exit /b 1
)

git init
git add .
git commit -m "Initial Minecraft AI Companion project"

echo.
echo Local repo created.
echo Next:
echo 1. Create an empty GitHub repo named minecraft-ai-companion.
echo 2. Copy the repo URL.
echo 3. Run:
echo    git remote add origin YOUR_REPO_URL
echo    git branch -M main
echo    git push -u origin main
echo.
pause
