@echo off
setlocal
chcp 65001 >nul
title Pixelle Video - Windows Stop

rem Resolve the project from this batch file so the folder name can be arbitrary.
for %%I in ("%~dp0.") do set "PROJECT_DIR=%%~fI\"
set "STOP_SCRIPT=%PROJECT_DIR%scripts\windows_stop.ps1"

if not exist "%STOP_SCRIPT%" (
  echo [ERROR] Missing stop script:
  echo %STOP_SCRIPT%
  timeout /t 10 /nobreak >nul
  exit /b 1
)

echo Stopping Pixelle Video services...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%STOP_SCRIPT%"
set "RESULT=%ERRORLEVEL%"

echo.
if "%RESULT%"=="0" (
  echo This window will close automatically in 5 seconds.
  timeout /t 5 /nobreak >nul
) else (
  echo Stop failed. This window will close automatically in 20 seconds.
  timeout /t 20 /nobreak >nul
)

exit /b %RESULT%
