$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $root "server.js"

$nodeProcesses = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "node.exe" -and
    $_.CommandLine -like "*$serverPath*"
  }

foreach ($process in $nodeProcesses) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

$cmdProcesses = Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "cmd.exe" -and
    $_.CommandLine -like "*BROAGENTS server*" -and
    (
      $_.CommandLine -like "*$serverPath*" -or
      $_.CommandLine -like "*node server.js*"
    )
  }

foreach ($process in $cmdProcesses) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Requested stop for BROAGENTS server and wrapper console processes."
