# Klipper Wire Configurator - Development Server Startup Script
# Starts both backend (FastAPI) and frontend (Vite) servers in parallel

Write-Host 'Starting Klipper Wire Configurator...' -ForegroundColor Cyan

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = Get-Location }
$backendDir = Join-Path $rootDir 'backend'
$frontendDir = Join-Path $rootDir 'frontend'

function Get-PortListenerInfo {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return $null }

    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    return [PSCustomObject]@{
        Port = $Port
        ProcessId = $listener.OwningProcess
        ProcessName = if ($process) { $process.ProcessName } else { 'unknown' }
    }
}

foreach ($port in 8099, 5173) {
    $listener = Get-PortListenerInfo -Port $port
    if ($listener) {
        Write-Host "Port $($listener.Port) is already in use by PID $($listener.ProcessId) ($($listener.ProcessName))." -ForegroundColor Red
        Write-Host 'Stop the existing process before starting the dev stack so you do not end up talking to a stale backend.' -ForegroundColor Yellow
        exit 1
    }
}

# Start Backend (FastAPI on port 8099)
Write-Host 'Starting backend (FastAPI on port 8099)...' -ForegroundColor Green
$venvPython = Join-Path $backendDir 'venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    Write-Host 'Creating backend venv...' -ForegroundColor Yellow
    Push-Location $backendDir
    python -m venv venv
    & $venvPython -m pip install -r requirements.txt
    Pop-Location
}
$backendJob = Start-Job -ScriptBlock {
    Set-Location $using:backendDir
    & $using:venvPython main.py
}

# Give backend a moment to start
Start-Sleep -Seconds 2

# Start Frontend (Vite on port 5173)
Write-Host 'Starting frontend (Vite on port 5173)...' -ForegroundColor Green
$nodeModules = Join-Path $frontendDir 'node_modules'
Write-Host 'Installing frontend dependencies...' -ForegroundColor Yellow
Push-Location $frontendDir
npm install
Pop-Location
$frontendJob = Start-Job -ScriptBlock {
    Set-Location $using:frontendDir
    npm run dev
}

# Give frontend a moment to start
Start-Sleep -Seconds 3

Write-Host ''
Write-Host 'Both servers started successfully!' -ForegroundColor Green
Write-Host ''
Write-Host 'Backend:  http://localhost:8099' -ForegroundColor Cyan
Write-Host 'Frontend: http://localhost:5173' -ForegroundColor Cyan
Write-Host ''
Write-Host 'Opening browser...' -ForegroundColor Green
Start-Process 'http://localhost:5173'

Write-Host ''
Write-Host 'Press any key to stop both servers...' -ForegroundColor Yellow
Write-Host ''

$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')

# Clean up
Write-Host 'Stopping servers...' -ForegroundColor Yellow
Stop-Job $backendJob, $frontendJob -ErrorAction SilentlyContinue
Remove-Job $backendJob, $frontendJob -Force -ErrorAction SilentlyContinue
Write-Host 'Servers stopped.' -ForegroundColor Yellow
