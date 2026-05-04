@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\start-broagents.ps1" -SkipOpen
if errorlevel 1 exit /b 1
call "%~dp0launch-desktop-app.cmd"
