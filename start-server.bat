@echo off
title Versend Signaling Server

echo ============================================================
echo   Versend Signaling & Relay Server (Port 3000)
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    pause
    exit /b 1
)

if not exist "node_modules\.bin\vite.cmd" (
    echo Installing dependencies...
    call npm install --legacy-peer-deps
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

echo Starting Versend server on http://localhost:3000 ...
echo Keep this window open while transferring files.
echo.
call npx tsx server.ts
pause
