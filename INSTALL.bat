@echo off
REM RespireeClaw Gateway Installer
REM Run this after extracting the zip file

echo ==========================================
echo  RespireeClaw Gateway Installation
echo ==========================================
echo.

REM Check Node.js
echo Checking Node.js version...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed or not in PATH
    echo Please install Node.js 20+ from https://nodejs.org/
    pause
    exit /b 1
)

for /f "tokens=1" %%a in ('node --version') do (
    set NODE_VERSION=%%a
)
echo Found: %NODE_VERSION%

REM Check version is 20+
echo %NODE_VERSION% | findstr /B /C:"v20." /C:"v21." /C:"v22." >nul
if %errorlevel% neq 0 (
    echo WARNING: Node.js 20+ recommended. Current: %NODE_VERSION%
)

REM Install dependencies
echo.
echo Installing dependencies (this may take a few minutes)...
call npm install --ignore-scripts
if %errorlevel% neq 0 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

REM Run onboard wizard
echo.
echo ==========================================
echo  Setup complete! Starting onboard wizard...
echo ==========================================
pause
node agent.js onboard

echo.
echo To start the gateway:
echo   node agent.js --daemon
echo.
pause
