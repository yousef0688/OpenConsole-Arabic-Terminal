@echo off
rem Double-click to add the OpenConsole terminal to Visual Studio Code (a tab in the panel with correct Arabic and Hebrew).
rem Extra arguments are passed on to install-vscode.ps1 (for example -Uninstall).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-vscode.ps1" %*
if errorlevel 1 (
    echo.
    echo The installation failed. Read the messages above.
    pause
    exit /b 1
)
if "%~1"=="" pause
