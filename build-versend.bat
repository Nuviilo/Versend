@echo off
setlocal EnableDelayedExpansion

title Versend - Automated Windows & Android Builder

echo ============================================================
echo   Versend Automated Build Script (Windows .exe + Android .apk)
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

:: Determine build target (CLI arg or interactive menu)
set "TARGET=%~1"
if "%TARGET%"=="" (
    echo Choose what to build:
    echo   [1] Windows installer + portable (.exe^)
    echo   [2] Android package (.apk^)
    echo   [3] Both Windows (.exe^) and Android (.apk^)
    echo.
    set /p "CHOICE=Enter choice (1, 2, or 3): "
    if "!CHOICE!"=="1" set "TARGET=win"
    if "!CHOICE!"=="2" set "TARGET=android"
    if "!CHOICE!"=="3" set "TARGET=all"
)

if not "%TARGET%"=="win" if not "%TARGET%"=="android" if not "%TARGET%"=="all" (
    echo [ERROR] Invalid selection. Use 1, 2, or 3.
    pause
    exit /b 1
)

:: Ask for live signaling server URL (used by standalone .exe / .apk)
set "DEFAULT_URL=https://ais-pre-lwrirw3pjjs2vliyzhza53-646622080348.asia-southeast1.run.app"
echo.
echo Enter your deployed Versend HTTPS server URL
echo (Press Enter to use: %DEFAULT_URL%^)
set /p "SERVER_URL=Server URL: "
if "!SERVER_URL!"=="" set "SERVER_URL=%DEFAULT_URL%"

:: Install root dependencies if needed and build frontend bundle
echo.
echo [1/3] Installing dependencies and building Versend frontend...
if not exist "node_modules" (
    call npm install
    if errorlevel 1 goto :fail
)

set "VITE_SERVER_URL=!SERVER_URL!"
call npx vite build --base=./
if errorlevel 1 goto :fail

if not exist "release" mkdir "release"

if "%TARGET%"=="win" call :build_windows
if errorlevel 1 goto :fail

if "%TARGET%"=="android" call :build_android
if errorlevel 1 goto :fail

if "%TARGET%"=="all" (
    call :build_windows
    if errorlevel 1 goto :fail
    call :build_android
    if errorlevel 1 goto :fail
)

echo.
echo ============================================================
echo   BUILD COMPLETE
echo   Check the "release" folder for your installers:
if exist "release\windows" echo     - Windows: release\windows\
if exist "release\android\Versend.apk" echo     - Android: release\android\Versend.apk
echo ============================================================
echo.
pause
exit /b 0

:: ------------------------------------------------------------
:build_windows
echo.
echo [2/3] Packaging Windows .exe via Electron...
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
    call npm install
    if errorlevel 1 (
        popd
        exit /b 1
    )
)

call npx electron-builder --win --x64
set "WIN_ERR=%errorlevel%"
popd
exit /b %WIN_ERR%

:: ------------------------------------------------------------
:build_android
echo.
echo [3/3] Packaging Android .apk via Capacitor + Gradle...

where java >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Java JDK 17+ is required for Android builds.
    echo Install Android Studio or JDK 17 and ensure "java" is in PATH.
    exit /b 1
)

if "%ANDROID_HOME%"=="" (
    if not "%ANDROID_SDK_ROOT%"=="" (
        set "ANDROID_HOME=%ANDROID_SDK_ROOT%"
    ) else if exist "%LOCALAPPDATA%\Android\Sdk" (
        set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
    )
)

if "%ANDROID_HOME%"=="" (
    echo [ERROR] Android SDK not found. Install Android Studio SDK or set ANDROID_HOME.
    exit /b 1
)
set "ANDROID_SDK_ROOT=%ANDROID_HOME%"

if not exist "packaging\android" mkdir "packaging\android"
if not exist "packaging\android\www" mkdir "packaging\android\www"

:: Copy latest dist into packaging\android\www
rmdir /s /q "packaging\android\www"
xcopy /E /I /Y "dist" "packaging\android\www" >nul

:: Write Capacitor wrapper package.json & config if missing
if not exist "packaging\android\package.json" (
    (
    echo {
    echo   "name": "versend-android",
    echo   "version": "1.0.0",
    echo   "private": true,
    echo   "dependencies": {
    echo     "@capacitor/core": "^7.0.0",
    echo     "@capacitor/android": "^7.0.0"
    echo   },
    echo   "devDependencies": {
    echo     "@capacitor/cli": "^7.0.0"
    echo   }
    echo }
    ) > "packaging\android\package.json"
)

(
echo {
echo   "appId": "com.versend.app",
echo   "appName": "Versend",
echo   "webDir": "www",
echo   "android": {
echo     "allowMixedContent": false
echo   }
echo }
) > "packaging\android\capacitor.config.json"

pushd "packaging\android"
if not exist "node_modules\@capacitor\android" (
    echo Installing Capacitor Android dependencies (first run only^)...
    call npm install
    if errorlevel 1 (
        popd
        exit /b 1
    )
)

if not exist "android" (
    call npx cap add android
    if errorlevel 1 (
        popd
        exit /b 1
    )
)

call npx cap sync android
if errorlevel 1 (
    popd
    exit /b 1
)

:: Copy Versend adaptive & legacy Android launcher icons into res\
if exist "..\..\assets\icons\android" (
    xcopy /E /I /Y "..\..\assets\icons\android\*" "android\app\src\main\res\" >nul
)

:: Ensure CAMERA and INTERNET permissions are present in AndroidManifest.xml
node -e "const fs=require('fs');const p='android/app/src/main/AndroidManifest.xml';let x=fs.readFileSync(p,'utf8');if(!x.includes('android.permission.CAMERA')){x=x.replace('<application','<uses-permission android:name=\"android.permission.CAMERA\" />\n    <application');}if(!x.includes('android.permission.INTERNET')){x=x.replace('<application','<uses-permission android:name=\"android.permission.INTERNET\" />\n    <application');}fs.writeFileSync(p,x);"

pushd "android"
call gradlew.bat assembleDebug
set "GRADLE_ERR=%errorlevel%"
popd

if not "%GRADLE_ERR%"=="0" (
    popd
    exit /b %GRADLE_ERR%
)

if not exist "..\..\release\android" mkdir "..\..\release\android"
copy /Y "android\app\build\outputs\apk\debug\app-debug.apk" "..\..\release\android\Versend.apk" >nul
popd
exit /b 0

:: ------------------------------------------------------------
:fail
echo.
echo [ERROR] Build failed. Review the error output above.
pause
exit /b 1
