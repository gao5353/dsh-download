@echo off
REM dsh-download installer - double-click to run.
REM
REM This file MUST keep CRLF line endings and ASCII-only text: cmd.exe misparses an
REM LF-only batch file and starts executing comment text as commands.
REM
REM -ExecutionPolicy Bypass is passed explicitly because script execution is disabled
REM by policy on many Windows installs, which is why a plain .ps1 cannot be run by
REM double-clicking.

chcp 65001 >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo Install failed with exit code %CODE%
  pause
)
exit /b %CODE%