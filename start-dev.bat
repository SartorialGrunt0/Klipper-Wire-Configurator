@echo off
REM Klipper Wire Configurator - Development Server Startup Script (Batch)
REM Starts both backend (FastAPI) and frontend (Vite) servers in parallel

setlocal enabledelayedexpansion

REM KWC only runs on the Linux printer host: off Linux the backend exits at
REM startup unless KWC_FAKE_NATIVE is set (see backend\main.py). Fake-native is
REM the dev override, not a deployment mode; on Linux it is already a no-op.
set KWC_FAKE_NATIVE=1

echo.
echo Starting Klipper Wire Configurator...
echo.

set ROOT_DIR=%~dp0
set BACKEND_DIR=%ROOT_DIR%backend
set FRONTEND_DIR=%ROOT_DIR%frontend

REM Start Backend (FastAPI on port 8099)
echo Starting backend (FastAPI on port 8099)...
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
powershell -NoProfile -Command "$deadline=(Get-Date).AddSeconds(60); $ok=$false; while ((Get-Date) -lt $deadline) { try { $r=Invoke-WebRequest -Uri 'http://127.0.0.1:8099/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { $ok=$true; break } } catch {} ; Start-Sleep -Milliseconds 500 }; if (-not $ok) { exit 1 }"
if errorlevel 1 (
    echo.
    echo ERROR: the backend did not answer http://127.0.0.1:8099/health within 60s.
    echo Check the "Klipper Wire Configurator - Backend" window for the error.
    exit /b 1
)

REM Start Frontend (Vite on port 5173)
echo Starting frontend (Vite on port 5173)...
echo Installing frontend dependencies...
cd /d "%FRONTEND_DIR%"
npm install
start "Klipper Wire Configurator - Frontend" cmd /k cd /d "%FRONTEND_DIR%" ^&^& npm run dev

REM Wait a moment for frontend to start
timeout /t 3 /nobreak

echo.
echo Both servers started successfully!
echo.
echo Backend:  http://localhost:8099
echo Frontend: http://localhost:5173
echo.
echo Opening browser...
start http://localhost:5173

echo.
echo Close the above windows to stop the servers.
echo.

pause
