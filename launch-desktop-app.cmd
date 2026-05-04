@echo off
cd /d "%~dp0"
if exist "%~dp0desktop-app\win-unpacked\AGENT SREDA.exe" (
  start "" "%~dp0desktop-app\win-unpacked\AGENT SREDA.exe"
  exit /b 0
)

echo Desktop app was not found in desktop-app\win-unpacked\AGENT SREDA.exe
exit /b 1
