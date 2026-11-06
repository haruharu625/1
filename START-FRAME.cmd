@echo off
setlocal
cd /d "%~dp0"
set "PATH=%ProgramFiles%\nodejs;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
where node >nul 2>&1
if errorlevel 1 goto missing
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>&1
if errorlevel 1 goto missing
where ffmpeg >nul 2>&1
if errorlevel 1 goto missing
where ffprobe >nul 2>&1
if errorlevel 1 goto missing
node tools\start-frame.mjs
if errorlevel 1 pause
exit /b
:missing
echo FRAME needs Node.js 20+ and FFmpeg.
echo Please run SETUP-WINDOWS.cmd first, then open START-FRAME.cmd again.
echo See WINDOWS.md for the Japanese instructions.
pause
exit /b 1
