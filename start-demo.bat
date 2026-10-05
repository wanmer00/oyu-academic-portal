@echo off
title Odlar Yurdu University - Portal
setlocal
cd /d "%~dp0"

echo ===============================================
echo   Odlar Yurdu University - Academic Management Portal (Docker Compose)
echo ===============================================
echo.

docker version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker Desktop is not running. Start it and try again.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [setup] Creating .env with random secrets...
    powershell -NoProfile -Command "$r={-join((1..48)|%%{'0123456789abcdef'[(Get-Random -Maximum 16)]})}; \"POSTGRES_PASSWORD=$(& $r)`nJWT_ACCESS_SECRET=$(& $r)`nJWT_REFRESH_SECRET=$(& $r)`nDEMO_MODE=true`nALLOW_DEMO_IN_PRODUCTION=true`nCOOKIE_SECURE=false`nALLOW_INSECURE_COOKIES=true`nDEMO_RESET_TOKEN=$(& $r)`n\" | Set-Content -Encoding ascii .env"
)

echo [1/3] Building and starting database, API and web...
docker compose up -d --build
if errorlevel 1 (
    echo [ERROR] docker compose failed.
    pause
    exit /b 1
)

echo [2/3] Waiting for the API (first start also fills the demo database)...
set /a tries=0
:wait
powershell -NoProfile -Command "try { (Invoke-WebRequest http://localhost:3001/api/v1/health/ready -UseBasicParsing -TimeoutSec 3).StatusCode } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% GEQ 60 (
    echo [ERROR] The API did not respond in time. See: docker compose logs portal-api
    pause
    exit /b 1
)
timeout /t 2 /nobreak >nul
goto wait

:ready
echo [3/3] Opening the browser...
start "" "http://localhost:3000"

echo.
echo   Web: http://localhost:3000   API: http://localhost:3001/api/v1
echo   Sign in with a test account (e.g. superadmin.demo, student1.demo). Password for all test accounts: Demo@Portal2026
echo   Restore the demo database (owner only): docker compose exec portal-api node dist/demo/reset.cli.js
echo   Stop: stop-demo.bat
echo.
pause