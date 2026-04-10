@echo off
REM Klipper Wire Configurator - Development Server Startup Script (Batch)
REM Starts both backend (FastAPI) and frontend (Vite) servers in parallel

setlocal enabledelayedexpansion

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
    venv\Scripts\pip.exe install -r requirements.txt
)
start "Klipper Wire Configurator - Backend" cmd /k cd /d "%BACKEND_DIR%" ^&^& venv\Scripts\python.exe main.py

REM Wait a moment for backend to start
timeout /t 2 /nobreak

REM Start Frontend (Vite on port 5173)
echo Starting frontend (Vite on port 5173)...
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
