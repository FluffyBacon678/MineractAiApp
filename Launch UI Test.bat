@echo off
cd /d "%~dp0"
echo Starting UI test server on http://127.0.0.1:3847 ...
start "" "http://127.0.0.1:3847"
node .claude/ui-test-server.js
