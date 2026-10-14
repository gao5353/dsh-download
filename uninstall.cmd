@echo off
REM dsh-download uninstaller - double-click to run.
REM
REM This file MUST keep CRLF line endings and ASCII-only text: cmd.exe misparses an
REM LF-only batch file and starts executing comment text as commands.
REM
REM -Purge also deletes the plugin's settings and download history. Pass it explicitly:
REM   uninstall.cmd -Purge

chcp 65001 >nul 2>&1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
