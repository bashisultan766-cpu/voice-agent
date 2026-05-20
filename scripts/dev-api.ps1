$ErrorActionPreference = 'Stop'

function Get-PortProcessId {
  param([int]$Port)
  try {
    $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
  } catch {}
  return $null
}

$pidUsingPort = Get-PortProcessId -Port 3001
if ($pidUsingPort) {
  Write-Host "ERROR: Port 3001 is already in use by PID $pidUsingPort." -ForegroundColor Red
  Write-Host "Run 'pnpm dev:reset-ports' (safe helper) or stop that process manually, then retry." -ForegroundColor Yellow
  exit 1
}

pnpm --filter api run dev
