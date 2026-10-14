@echo off
REM dsh-download settings wizard - double-click to run.
REM
REM This file MUST keep CRLF line endings and ASCII-only text. cmd.exe misparses an
REM LF-only batch file (it stops honouring @echo off and REM, then tries to execute
REM comment text as commands), and non-ASCII text here would be decoded with the OEM
REM code page. The Chinese menu therefore lives in settings.ps1, which is UTF-8 with a
REM BOM so PowerShell reads it correctly.
REM
REM Nothing here touches dsh. Deleting this file changes nothing at runtime.

chcp 65001 >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0settings.ps1"
set CODE=%ERRORLEVEL%
if not "%CODE%"=="0" (
  echo.
  echo Wizard exited with code %CODE%
  pause
)
exit /b %CODE%