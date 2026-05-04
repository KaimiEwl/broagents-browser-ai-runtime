param(
  [switch]$SkipOpen,
  [switch]$ResetState,
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-ListenPort {
  param(
    [int]$Port
  )

  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

  return $null -ne $listener
}

function Start-ServerWindow {
  param(
    [string]$Title,
    [string]$Command
  )

  Start-Process -FilePath "cmd.exe" -WorkingDirectory $root -ArgumentList "/k", "title $Title && $Command" | Out-Null
}

function Get-HealthPayload {
  param(
    [int]$Port
  )

  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2

    if (-not $response.Content) {
      return $null
    }

    return $response.Content | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Reset-BroagentsState {
  $dataDir = Join-Path $root "data"
  $logsDir = Join-Path $dataDir "logs"
  $agentStatePath = Join-Path $dataDir "agent-state.json"

  if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  }

  Set-Content -Path $agentStatePath -Value "[]" -Encoding UTF8

  if (Test-Path $logsDir) {
    Get-ChildItem $logsDir -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host "Node.js not found in PATH."
  Write-Host "Install Node.js, then run start-broagents.cmd again."
  Write-Host ""
  exit 1
}

if (-not (Test-Path (Join-Path $root "node_modules\\ws"))) {
  Write-Host ""
  Write-Host "Dependency ws is missing."
  Write-Host "Run: npm install"
  Write-Host ""
  exit 1
}

if ($ResetState) {
  Reset-BroagentsState
}

$existingPayload = Get-HealthPayload -Port $Port

if (Test-ListenPort -Port $Port) {
  if ($null -eq $existingPayload -or -not $existingPayload.ok) {
    Write-Host ""
    Write-Host "Port $Port is already occupied by another process."
    Write-Host "BROAGENTS will not start over an unknown service."
    Write-Host ""
    exit 1
  }
} else {
  $serverScriptPath = Join-Path $root "server.js"
  Start-ServerWindow -Title "BROAGENTS server" -Command "set BROAGENTS_PORT=$Port && node `"$serverScriptPath`""
}

$ready = $false
 
if ($null -ne $existingPayload -and $existingPayload.ok) {
  $ready = $true
}

for ($index = 0; (-not $ready) -and $index -lt 30; $index += 1) {
  Start-Sleep -Seconds 1

  $payload = Get-HealthPayload -Port $Port

  if ($null -ne $payload -and $payload.ok) {
    $ready = $true
  }
}

if ($ready) {
  if (-not $SkipOpen) {
    Start-Process "http://127.0.0.1:$Port" | Out-Null
  }
  exit 0
}

Write-Host ""
Write-Host "BROAGENTS server did not become ready on http://127.0.0.1:$Port"
Write-Host "Open the server window and check the error."
Write-Host ""
exit 1
