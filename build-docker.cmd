@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-docker.ps1" %*
if errorlevel 1 echo Docker packaging failed. See the message above.
pause
