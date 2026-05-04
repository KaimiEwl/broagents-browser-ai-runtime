$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
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

Write-Host "BROAGENTS state has been reset."
