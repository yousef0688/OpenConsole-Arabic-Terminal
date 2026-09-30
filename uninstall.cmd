@echo off
rem Double-click to remove OpenConsole (shortcuts, right-click entries, settings and the installed program).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" -Uninstall %*
pause
