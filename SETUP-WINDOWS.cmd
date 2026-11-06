@echo off
setlocal
cd /d "%~dp0"
set "PATH=%ProgramFiles%\nodejs;%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
echo FRAME setup for Windows
echo This installs missing Node.js LTS and FFmpeg using Windows Package Manager.
echo Internet access and Windows installation permission may be needed.
echo No video files are sent anywhere during setup.
echo.
where winget >nul 2>&1
if errorlevel 1 goto no_winget
choice /C YN /M "Install the required tools"
if errorlevel 2 exit /b 0
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>&1
if not errorlevel 1 goto node_ready
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto failed
:node_ready
where ffmpeg >nul 2>&1
if errorlevel 1 goto install_ffmpeg
where ffprobe >nul 2>&1
if not errorlevel 1 goto complete
:install_ffmpeg
winget install --id Gyan.FFmpeg --exact --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto failed
:complete
echo.
echo Setup complete. Close this window, then double-click START-FRAME.cmd.
echo If a tool is still not found, sign out of Windows and sign in again.
pause
exit /b 0
:no_winget
echo Windows Package Manager was not found.
echo Install or update App Installer from Microsoft Store, then try again.
echo You can also install Node.js and FFmpeg manually as described in WINDOWS.md.
pause
exit /b 1
:failed
echo.
echo Setup did not complete. Please read the error above and WINDOWS.md.
pause
exit /b 1
