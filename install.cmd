@echo off
rem Double-click to build and install OpenConsole. Extra arguments are passed on to install.ps1 (for example -Uninstall).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
    echo.
    echo The installation failed. Read the messages above.
    pause
    exit /b 1
)
if "%~1"=="" pause
