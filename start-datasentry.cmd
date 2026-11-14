@echo off
title DataSentry Development Launcher

echo.
echo ======================================
echo       DATASENTRY DEVELOPMENT
echo ======================================
echo.

echo [1/3] Checking ADB...
adb get-state
if errorlevel 1 (
    echo.
    echo ERROR: Phone not connected or USB debugging unavailable.
    echo Connect your phone and authorize this computer.
    pause
    exit /b 1
)

echo.
echo [2/3] Configuring Metro port forwarding...
adb reverse tcp:8081 tcp:8081
if errorlevel 1 (
    echo ERROR: Could not configure port forwarding.
    pause
    exit /b 1
)

echo.
echo [3/3] Starting Metro...
echo Keep this window open while testing DataSentry.
echo.

call npm.cmd start
