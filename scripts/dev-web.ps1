$ErrorActionPreference = 'Stop'

# Avoid stale Next dev artifacts causing MODULE_NOT_FOUND on generated chunks.
$webRoot = Join-Path $PSScriptRoot "..\apps\web"
$nextDir = Join-Path $webRoot ".next"

if (Test-Path $nextDir) {
  Write-Host "Clearing stale Next build cache: $nextDir"
  try {
    Remove-Item -Path $nextDir -Recurse -Force -ErrorAction Stop
  } catch {
    Write-Host ("Could not fully clear .next with PowerShell: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
    cmd /c rmdir /s /q "$nextDir" | Out-Null
  }
}

pnpm --filter web run dev
