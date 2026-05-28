param(
  [string]$ApiBaseUrl = "http://127.0.0.1:3001",
  [string]$AgentId = "cmplg2vx90001laemr990b6ih",
  [Parameter(Mandatory = $true)]
  [string]$BearerToken
)

$ErrorActionPreference = "Stop"

$base = $ApiBaseUrl.TrimEnd("/")
$patchUrl = "$base/api/agents/$AgentId"
$diagUrl = "$base/api/agents/$AgentId/persistence-diagnostics"

$headers = @{
  "Authorization" = "Bearer $BearerToken"
  "Content-Type"  = "application/json"
}

$body = @{
  useWorkspaceOpenai = $true
  useWorkspaceTwilio = $true
} | ConvertTo-Json -Compress

Write-Host "PATCH $patchUrl"
Write-Host "Body: $body"

$patchResponse = Invoke-RestMethod -Method Patch -Uri $patchUrl -Headers $headers -Body $body
Write-Host "Patch applied."

Write-Host "GET $diagUrl"
$diagResponse = Invoke-RestMethod -Method Get -Uri $diagUrl -Headers $headers

$openaiSource = $diagResponse.runtimeCredentialSource.openai
$twilioSource = $diagResponse.runtimeCredentialSource.twilio

Write-Host "openai source = $openaiSource"
Write-Host "twilio source = $twilioSource"

if ($openaiSource -ne "workspace" -or $twilioSource -ne "workspace") {
  throw "Verification failed. Expected openai/twilio source to be workspace."
}

Write-Host "Verification OK: workspace credentials enabled for this agent."
