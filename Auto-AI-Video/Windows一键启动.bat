@echo off
setlocal
chcp 65001 >nul
title Pixelle Video - Windows Launcher

rem Resolve the folder containing this batch file; the clone/download folder
rem can have any name and does not need to match the GitHub repository name.
for %%I in ("%~dp0.") do set "PROJECT_DIR=%%~fI\"
set "SETUP_SCRIPT=%PROJECT_DIR%scripts\windows_setup_start.ps1"

if not exist "%SETUP_SCRIPT%" (
  echo [ERROR] Missing setup script:
  echo %SETUP_SCRIPT%
  echo.
  echo This window will close automatically in 15 seconds.
  timeout /t 15 /nobreak >nul
  exit /b 1
)

echo Starting Pixelle Video setup and launcher...
echo The first run can take 10-30 minutes. Please keep this window open.
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SETUP_SCRIPT%" %*
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
  echo.
  echo Setup or startup failed. Read the error above or windows-startup.log.
  echo This window will close automatically in 30 seconds.
  timeout /t 30 /nobreak >nul
)

exit /b %RESULT%
