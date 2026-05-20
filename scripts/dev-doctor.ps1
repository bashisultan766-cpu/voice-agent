$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot "..")

function Get-EnvValueFromFiles {
  param([string]$Key, [string[]]$Files)
  foreach ($file in $Files) {
    if (-not (Test-Path $file)) { continue }
    $line = Get-Content $file | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
    if ($line) {
      return (($line -replace "^\s*$Key\s*=\s*", "") -replace "^\s*['""]|['""]\s*$", "").Trim()
    }
  }
  return $null
}

function Check($Name, [scriptblock]$Action) {
  try {
    & $Action
    Write-Host "[OK] $Name" -ForegroundColor Green
    return $true
  } catch {
    Write-Host "[FAIL] $Name - $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}

function Assert-PortFree([int]$Port, [string]$Label) {
  $conn = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) {
    throw "$Label port $Port is in use by PID $($conn.OwningProcess)."
  }
}

function Test-Http([string]$Url) {
  try {
    $res = Invoke-WebRequest -UseBasicParsing -Uri $Url -Method GET -TimeoutSec 3
    return $res.StatusCode
  } catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode) { return [int]$statusCode }
    return $null
  }
}

$apiEnvFiles = @(
  (Join-Path $root "apps/api/.env"),
  (Join-Path $root ".env"),
  (Join-Path $root "apps/api/.env.local")
)

$allOk = $true
$allOk = (Check "API port availability (3001)" { Assert-PortFree 3001 "API" }) -and $allOk
$allOk = (Check "Web port availability (3000)" { Assert-PortFree 3000 "Web" }) -and $allOk

$db = Get-EnvValueFromFiles -Key "DATABASE_URL" -Files $apiEnvFiles
$jwt = Get-EnvValueFromFiles -Key "JWT_SECRET" -Files $apiEnvFiles
$enc = Get-EnvValueFromFiles -Key "ENCRYPTION_KEY" -Files $apiEnvFiles

$allOk = (Check "DATABASE_URL exists" {
  if (-not $db) { throw "DATABASE_URL missing in apps/api/.env (or root .env)." }
}) -and $allOk

$allOk = (Check "DATABASE_URL points to app database" {
  if ($db -match '/(postgres|template0|template1)(\?|$)') {
    throw "DATABASE_URL points to a system database. Use the app database (for local: voice_agent_db)."
  }
}) -and $allOk

$allOk = (Check "JWT_SECRET exists" {
  if (-not $jwt) { throw "JWT_SECRET missing in apps/api/.env (or root .env)." }
}) -and $allOk

$allOk = (Check "ENCRYPTION_KEY exists and is valid" {
  if (-not $enc) { throw "ENCRYPTION_KEY missing." }
  if ($enc.Length -ne 64 -or $enc -notmatch '^[0-9a-fA-F]{64}$') {
    throw "ENCRYPTION_KEY must be 64 hex chars (32-byte key for AES-256-GCM)."
  }
}) -and $allOk

$allOk = (Check "Prisma client generated" {
  Push-Location (Join-Path $root "apps/api")
  try {
    node -e "const m=require('@prisma/client'); if(!m.PrismaClient){process.exit(1)}"
    if ($LASTEXITCODE -ne 0) {
      throw "Cannot load Prisma client from apps/api. Run: pnpm --filter api exec prisma generate"
    }
  } finally {
    Pop-Location
  }
}) -and $allOk

$allOk = (Check "Migrations applied (prisma migrate status)" {
  $out = pnpm --filter api exec prisma migrate status 2>&1 | Out-String
  if ($out -notmatch 'Database schema is up to date' -and $out -notmatch 'No pending migrations') {
    throw ("Unexpected migrate status output: " + $out.Trim())
  }
}) -and $allOk

$allOk = (Check "_prisma_migrations table exists and schema is synced" {
  $schemaPath = Join-Path $root "apps/api/prisma/schema.prisma"
  $drift = pnpm --filter api exec prisma migrate diff --from-url $db --to-schema-datamodel $schemaPath --script 2>&1 | Out-String
  if ($drift -match 'ALTER TABLE "_prisma_migrations"' -or $drift -match 'CREATE TABLE "_prisma_migrations"') {
    throw "_prisma_migrations table missing or unexpected."
  }
  if ($drift -and $drift -notmatch 'No difference detected') {
    throw ("Schema drift detected. Run migrations. Diff: " + $drift.Trim())
  }
}) -and $allOk

$allOk = (Check "TenantIntegration table and required columns exist" {
  $schemaPath = Join-Path $root "apps/api/prisma/schema.prisma"
  $diff = pnpm --filter api exec prisma migrate diff --from-url $db --to-schema-datamodel $schemaPath --script 2>&1 | Out-String
  if ($diff -match 'CREATE TABLE "TenantIntegration"' -or $diff -match 'ALTER TABLE "TenantIntegration"') {
    throw ("TenantIntegration drift detected. Apply migrations. Diff: " + $diff.Trim())
  }
}) -and $allOk

$allOk = (Check "API health endpoint reachable" {
  $status = Test-Http "http://127.0.0.1:3001/api/health"
  if ($status -ne 200) { throw "Expected HTTP 200 from /api/health, got $status. Start API with: pnpm dev:api" }
}) -and $allOk

$allOk = (Check "Web proxy can reach API" {
  $status = Test-Http "http://127.0.0.1:3000/api/health"
  if ($status -ne 200) { throw "Expected HTTP 200 from web proxy /api/health, got $status. Start web with: pnpm dev:web" }
}) -and $allOk

if ($allOk) {
  Write-Host "`nDoctor checks passed." -ForegroundColor Green
  exit 0
}

Write-Host "`nDoctor found issues. Fix the failed checks above." -ForegroundColor Red
exit 1
