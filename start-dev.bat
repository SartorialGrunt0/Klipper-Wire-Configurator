@echo off
REM Klipper Wire Configurator - Development Server Startup Script (Batch)
REM Starts both backend (FastAPI) and frontend (Vite) servers in parallel

setlocal enabledelayedexpansion

if "%KWC_PORT%"=="" set KWC_PORT=8099

echo.
echo Starting Klipper Wire Configurator...
echo.

set ROOT_DIR=%~dp0
set BACKEND_DIR=%ROOT_DIR%backend
set FRONTEND_DIR=%ROOT_DIR%frontend

REM Pre-flight: a backend orphaned by a previous failed run answers the health
REM check below, so this script could report "success" while its own child
REM died of "address in use". Refuse to start against an occupied port instead.
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %KWC_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 1 }"
if errorlevel 1 (
    echo ERROR: port %KWC_PORT% is already in use - a backend from a previous run is probably still listening.
    echo Close it, or use start-dev.ps1 -StopExisting, then run this script again.
    exit /b 1
)

REM Start Backend (FastAPI on the dev port)
echo Starting backend (FastAPI on port %KWC_PORT%)...
if not exist "%BACKEND_DIR%\venv\Scripts\python.exe" (
    echo Creating backend venv...
    cd /d "%BACKEND_DIR%"
    python -m venv venv
)
cd /d "%BACKEND_DIR%"
REM Refresh Python dependencies on every start so pulls that add new
REM requirements (e.g. jinja2) work without manually reinstalling.
echo Refreshing backend Python dependencies...
venv\Scripts\pip.exe install -r requirements.txt
start "Klipper Wire Configurator - Backend" cmd /k cd /d "%BACKEND_DIR%" ^&^& venv\Scripts\python.exe main.py

REM Wait for the backend to actually answer. A fixed timeout only pretends to:
REM the process can be dead and this script used to announce success anyway.
echo Waiting for the backend to answer...
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(60); $ok=$false; while ((Get-Date) -lt $deadline) { try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:%KWC_PORT%/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok=$true; break } } catch {} ; Start-Sleep -Milliseconds 500 }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
    echo.
    echo ERROR: the backend did not answer http://127.0.0.1:%KWC_PORT%/health within 60s.
    echo Check the "Klipper Wire Configurator - Backend" window for the error.
    REM Don't leave that window's python holding the port for the next run.
    taskkill /FI "WINDOWTITLE eq Klipper Wire Configurator - Backend*" /T /F >nul 2>&1
    exit /b 1
)

REM Start Frontend (Vite on port 5173)
echo Starting frontend (Vite on port 5173)...
echo Installing frontend dependencies...
cd /d "%FRONTEND_DIR%"
npm install
if errorlevel 1 (
    echo ERROR: npm install failed - fix it and run this script again.
    exit /b 1
)
start "Klipper Wire Configurator - Frontend" cmd /k cd /d "%FRONTEND_DIR%" ^&^& npm run dev

REM Wait a moment for frontend to start
timeout /t 3 /nobreak

echo.
echo Backend verified on port %KWC_PORT%; frontend launched - watch the Vite window until it serves.
echo.
echo Backend:  http://localhost:%KWC_PORT%
echo Frontend: http://localhost:5173
echo.
echo Opening browser...
start http://localhost:5173

echo.
echo Close the above windows to stop the servers.
echo.

pause
