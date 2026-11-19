@echo off
setlocal EnableDelayedExpansion

title Versend - Windows .exe Builder

echo ============================================================
echo   Versend Windows .exe Builder
echo ============================================================
echo.

:: Verify Node.js and npm
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo Install Node.js LTS from https://nodejs.org/ and try again.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm is not available in PATH.
    pause
    exit /b 1
)

:: Ask for live signaling server URL (used by standalone .exe and synced to android/ assets)
set "DEFAULT_URL=https://ais-pre-lwrirw3pjjs2vliyzhza53-646622080348.asia-southeast1.run.app"
echo Enter your deployed Versend HTTPS server URL
echo (Press Enter to use: %DEFAULT_URL%^)
set /p "SERVER_URL=Server URL: "
if "!SERVER_URL!"=="" set "SERVER_URL=%DEFAULT_URL%"

:: Install root dependencies if needed and build frontend bundle
echo.
echo [1/2] Installing dependencies and building Versend frontend...
if not exist "node_modules\.bin\vite.cmd" (
    call npm install --legacy-peer-deps
    if errorlevel 1 goto :fail
)

set "VITE_SERVER_URL=!SERVER_URL!"
call npx vite build --base=./
if errorlevel 1 goto :fail

:: Also keep Android Studio project's bundled assets synced with this Server URL
if exist "android\app\src\main" (
    if exist "android\app\src\main\assets\public" rmdir /s /q "android\app\src\main\assets\public"
    xcopy /E /I /Y "dist" "android\app\src\main\assets\public" >nul
)

echo.
echo [2/2] Packaging Windows .exe via Electron...
if not exist "release" mkdir "release"
if not exist "packaging\windows" mkdir "packaging\windows"

:: Copy Windows & runtime app icons
if exist "assets\icons\icon.ico" copy /Y "assets\icons\icon.ico" "packaging\windows\icon.ico" >nul
if exist "assets\icons\icon.png" copy /Y "assets\icons\icon.png" "packaging\windows\icon.png" >nul

:: Write Electron main process
(
echo const { app, BrowserWindow, session } = require('electron'^);
echo const path = require('path'^);
echo.
echo function createWindow(^) {
echo   const win = new BrowserWindow({
echo     width: 1120,
echo     height: 760,
echo     minWidth: 420,
echo     minHeight: 600,
echo     autoHideMenuBar: true,
echo     title: 'Versend',
echo     icon: path.join(__dirname, 'icon.png'^),
echo     webPreferences: {
echo       contextIsolation: true,
echo       nodeIntegration: false,
echo     },
echo   }^);
echo   win.loadFile(path.join(__dirname, 'dist', 'index.html'^)^);
echo }
echo.
echo app.whenReady(^).then((^) =^> {
echo   session.defaultSession.setPermissionRequestHandler((_wc, permission, callback^) =^> {
echo     if (permission === 'media' ^|^| permission === 'clipboard-read' ^|^| permission === 'clipboard-sanitized-write'^) {
echo       callback(true^);
echo       return;
echo     }
echo     callback(false^);
echo   }^);
echo   createWindow(^);
echo }^);
echo.
echo app.on('window-all-closed', (^) =^> {
echo   if (process.platform !== 'darwin'^) app.quit(^);
echo }^);
) > "packaging\windows\main.cjs"

:: Write Electron package.json with Windows .ico configuration
(
echo {
echo   "name": "versend-desktop",
echo   "version": "1.0.0",
echo   "description": "Cross-platform peer-to-peer file transfer",
echo   "main": "main.cjs",
echo   "build": {
echo     "appId": "com.versend.app",
echo     "productName": "Versend",
echo     "directories": {
echo       "output": "../../release/windows"
echo     },
echo     "files": [
echo       "main.cjs",
echo       "icon.ico",
echo       "icon.png",
echo       "dist/**/*"
echo     ],
echo     "win": {
echo       "icon": "icon.ico",
echo       "target": [
echo         "nsis",
echo         "portable"
echo       ]
echo     },
echo     "nsis": {
echo       "installerIcon": "icon.ico",
echo       "uninstallerIcon": "icon.ico",
echo       "shortcutName": "Versend"
echo     }
echo   },
echo   "devDependencies": {
echo     "electron": "^35.0.0",
echo     "electron-builder": "^26.0.12"
echo   }
echo }
) > "packaging\windows\package.json"

:: Copy latest dist into packaging\windows\dist
if exist "packaging\windows\dist" rmdir /s /q "packaging\windows\dist"
xcopy /E /I /Y "dist" "packaging\windows\dist" >nul

pushd "packaging\windows"
if not exist "node_modules\electron" (
    echo Installing Electron and electron-builder (first run only^)...
    call npm install --legacy-peer-deps
    if errorlevel 1 (
        popd
        exit /b 1
    )
)

call npx electron-builder --win --x64
set "WIN_ERR=%errorlevel%"
popd
if not "%WIN_ERR%"=="0" goto :fail

echo.
echo ============================================================
echo   WINDOWS BUILD COMPLETE
echo   Output folder: release\windows\
echo     - Installer: release\windows\Versend Setup 1.0.0.exe
echo     - Portable:  release\windows\Versend 1.0.0.exe
echo ============================================================
echo.
pause
exit /b 0

:fail
echo.
echo [ERROR] Windows build failed. Review the error output above.
pause
exit /b 1
