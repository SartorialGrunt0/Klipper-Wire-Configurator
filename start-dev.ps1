# Klipper Wire Configurator - Development Server Startup Script
# Starts both backend (FastAPI) and frontend (Vite) servers in parallel

param(
    [switch]$StopExisting
)

Write-Host 'Starting Klipper Wire Configurator...' -ForegroundColor Cyan

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = Get-Location }
$backendDir = Join-Path $rootDir 'backend'
$frontendDir = Join-Path $rootDir 'frontend'

function Get-ProcessDetails {
    param([int]$ProcessId)

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue | Select-Object -First 1
    $processCim = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue

    if (-not $process -and -not $processCim) {
        return $null
    }

    return [PSCustomObject]@{
        Id = $ProcessId
        Name = if ($process) { $process.ProcessName } elseif ($processCim) { $processCim.Name } else { 'unknown' }
        CommandLine = if ($processCim) { $processCim.CommandLine } else { $null }
    }
}

function Get-OrphanedWorkerCandidates {
    param([int]$ParentProcessId)

    $parentHint = "parent_pid=$ParentProcessId"
    return @(
        Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like "*$parentHint*" } |
            Select-Object @{Name = 'Id'; Expression = { $_.ProcessId } },
                          @{Name = 'Name'; Expression = { $_.Name } },
                          @{Name = 'CommandLine'; Expression = { $_.CommandLine } }
    )
}

function Get-PortListenerInfo {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { return $null }

    $processDetails = Get-ProcessDetails -ProcessId $listener.OwningProcess
    $orphanedWorkers = @()
    if (-not $processDetails) {
        $orphanedWorkers = Get-OrphanedWorkerCandidates -ParentProcessId $listener.OwningProcess
    }

    return [PSCustomObject]@{
        Port = $Port
        ProcessId = $listener.OwningProcess
        ProcessName = if ($processDetails) { $processDetails.Name } else { 'unknown' }
        CommandLine = if ($processDetails) { $processDetails.CommandLine } else { $null }
        OrphanedWorkers = @($orphanedWorkers)
    }
}

function Stop-ProcessTree {
    param([int]$ProcessId)

    & taskkill.exe /PID $ProcessId /T /F 1>$null 2>$null
}

function Wait-ForPortState {
    param(
        [int]$Port,
        [bool]$Listening,
        [int]$TimeoutSeconds = 10
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $listener = Get-PortListenerInfo -Port $Port
        if ($Listening -and $listener) { return $true }
        if (-not $Listening -and -not $listener) { return $true }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Try-StopPortListener {
    param($ListenerInfo)

    $currentListener = $ListenerInfo

    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        if (-not $currentListener) {
            return $true
        }

        $orphanedWorkers = @($currentListener.OrphanedWorkers)
        if ($currentListener.ProcessName -ne 'unknown') {
            Stop-ProcessTree -ProcessId $currentListener.ProcessId
        } elseif ($orphanedWorkers.Count -gt 0) {
            foreach ($worker in $orphanedWorkers) {
                Stop-ProcessTree -ProcessId $worker.Id
            }
        } else {
            return $false
        }

        Start-Sleep -Milliseconds 500
        $currentListener = Get-PortListenerInfo -Port $ListenerInfo.Port
    }

    return -not (Get-PortListenerInfo -Port $ListenerInfo.Port)
}

function Write-PortConflict {
    param($ListenerInfo)

    $orphanedWorkers = @($ListenerInfo.OrphanedWorkers)

    Write-Host "Port $($ListenerInfo.Port) is already in use by PID $($ListenerInfo.ProcessId) ($($ListenerInfo.ProcessName))." -ForegroundColor Red

    if ($ListenerInfo.CommandLine) {
        Write-Host "Command line: $($ListenerInfo.CommandLine)" -ForegroundColor DarkYellow
    }

    if ($orphanedWorkers.Count -gt 0) {
        Write-Host 'The listener PID is no longer visible, but these orphaned Python workers still reference it:' -ForegroundColor Yellow
        foreach ($worker in $orphanedWorkers) {
            Write-Host "  PID $($worker.Id): $($worker.CommandLine)" -ForegroundColor Yellow
        }
        Write-Host 'Stopping those worker PIDs will usually clear the stale backend left behind by a previous run.' -ForegroundColor Yellow
    }

    if (-not $StopExisting) {
        Write-Host 'Run .\start-dev.ps1 -StopExisting to try to clear an old dev server before starting a new one.' -ForegroundColor Yellow
    }

    Write-Host 'Stop the existing process before starting the dev stack so you do not end up talking to a stale backend.' -ForegroundColor Yellow
}

function Resolve-CommandPath {
    param([string[]]$CommandNames)

    foreach ($commandName in $CommandNames) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            return $command.Source
        }
    }

    throw "Unable to resolve any of these commands: $($CommandNames -join ', ')"
}

foreach ($port in 8099, 5173) {
    $listener = Get-PortListenerInfo -Port $port
    if (-not $listener) {
        continue
    }

    if ($StopExisting -and (Try-StopPortListener -ListenerInfo $listener)) {
        Write-Host "Stopped the existing listener on port $port." -ForegroundColor Yellow
        continue
    }

    Write-PortConflict -ListenerInfo (Get-PortListenerInfo -Port $port)
    exit 1
}

$backendProcess = $null
$frontendProcess = $null

try {
    # Start Backend (FastAPI on port 8099)
    Write-Host 'Starting backend (FastAPI on port 8099)...' -ForegroundColor Green
    $venvPython = Join-Path $backendDir 'venv\Scripts\python.exe'
    if (-not (Test-Path $venvPython)) {
        Write-Host 'Creating backend venv...' -ForegroundColor Yellow
        Push-Location $backendDir
        try {
            python -m venv venv
            & $venvPython -m pip install -r requirements.txt
        }
        finally {
            Pop-Location
        }
    }
    $backendProcess = Start-Process -FilePath $venvPython -ArgumentList 'main.py' -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru

    # Give backend a moment to start
    Start-Sleep -Seconds 2

    # Start Frontend (Vite on port 5173)
    Write-Host 'Starting frontend (Vite on port 5173)...' -ForegroundColor Green
    $nodeModules = Join-Path $frontendDir 'node_modules'
    $npmPath = Resolve-CommandPath -CommandNames @('npm.cmd', 'npm')
    Write-Host 'Installing frontend dependencies...' -ForegroundColor Yellow
    Push-Location $frontendDir
    try {
        & $npmPath install
    }
    finally {
        Pop-Location
    }
    $frontendProcess = Start-Process -FilePath $npmPath -ArgumentList 'run', 'dev' -WorkingDirectory $frontendDir -WindowStyle Hidden -PassThru

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
}
finally {
    Write-Host 'Stopping servers...' -ForegroundColor Yellow
    if ($frontendProcess) {
        Stop-ProcessTree -ProcessId $frontendProcess.Id
    }
    if ($backendProcess) {
        Stop-ProcessTree -ProcessId $backendProcess.Id
    }
    Write-Host 'Servers stopped.' -ForegroundColor Yellow
}
