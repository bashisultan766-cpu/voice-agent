$ErrorActionPreference = 'Stop'

function Stop-ByPort {
  param([int]$Port)
  $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
  if (-not $connections) {
    Write-Host "Port $Port is already free."
    return
  }
  $portPids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($procId in $portPids) {
    if ($procId -and $procId -gt 0) {
      try {
        $proc = Get-Process -Id $procId -ErrorAction Stop
        Write-Host "Stopping PID $procId ($($proc.ProcessName)) on port $Port..."
        Stop-Process -Id $procId -Force -ErrorAction Stop
      } catch {
        Write-Host ("Could not stop PID {0} on port {1}: {2}" -f $procId, $Port, $_.Exception.Message) -ForegroundColor Yellow
      }
    }
  }
}

Stop-ByPort -Port 3001
Stop-ByPort -Port 3000

Write-Host "Port reset complete."
