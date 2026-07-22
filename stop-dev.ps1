<# .SYNOPSIS
  Stop development servers for Klipper Wire Configurator on ports 8099 and 5173.
.DESCRIPTION
  Finds and forcefully kills any process trees listening on ports 8099 (FastAPI backend)
  and 5173 (Vite frontend). Handles orphaned uvicorn workers whose parent process died.
  Has no interactive prompts -- safe to run from automation (pi, CI, etc.).
.EXAMPLE
  .\stop-dev.ps1
  Stops both servers, reports success/failure per port.
#>

param()

$ErrorActionPreference = 'Stop'

$ports = @(8099, 5173)

function Get-OrphanedWorkers {
    $parentHint = 'parent_pid='
    return Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$parentHint*" } |
        Select-Object @{N='Id';E={$_.ProcessId}}, @{N='Name';E={$_.Name}}, @{N='CommandLine';E={$_.CommandLine}}
}

function Stop-PortListener {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) {
        Write-Host "Port $Port -- nothing listening." -ForegroundColor Green
        return $true
    }

    $processId = $listener.OwningProcess
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    $processCim = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    $name = if ($process) { $process.ProcessName } elseif ($processCim) { $processCim.Name } else { 'unknown' }

    Write-Host "Port $Port -- PID $processId ($name) listening." -ForegroundColor Yellow

    if (-not $process -and -not $processCim) {
        # Orphaned -- try to find workers
        $orphans = Get-OrphanedWorkers | Where-Object { $_.CommandLine -like "*parent_pid=$processId*" }
        if ($orphans) {
            Write-Host "  Parent PID $processId is gone. Killing orphaned workers..." -ForegroundColor Yellow
            foreach ($o in $orphans) {
                Write-Host "  -> Killing orphan worker PID $($o.Id)" -ForegroundColor DarkYellow
                taskkill.exe /PID $o.Id /T /F 2>$null | Out-Null
            }
        }
        Write-Host "  Port $Port no longer occupied." -ForegroundColor Green
        return $true
    }

    # Kill the process tree
    Write-Host "  Killing process tree (PID $processId)..." -ForegroundColor DarkYellow
    taskkill.exe /PID $processId /T /F 2>$null | Out-Null

    # Wait for port to be released
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        Start-Sleep -Milliseconds 500
        $check = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $check) {
            Write-Host "  Port $Port released." -ForegroundColor Green
            return $true
        }
    }

    Write-Host "  WARNING Port $Port still in use after 5 attempts." -ForegroundColor Red
    return $false
}

Write-Host 'Stopping Klipper Wire Configurator dev servers...' -ForegroundColor Cyan
Write-Host ''

$allStopped = $true
foreach ($port in $ports) {
    if (-not (Stop-PortListener -Port $port)) {
        $allStopped = $false
    }
}

Write-Host ''
if ($allStopped) {
    Write-Host 'All servers stopped.' -ForegroundColor Green
}
else {
    Write-Host 'Some ports could not be freed. Try running as Administrator.' -ForegroundColor Red
    exit 1
}
