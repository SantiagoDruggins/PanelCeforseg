param(
  [string]$TaskName = "DenverPOSAgent"
)

$ErrorActionPreference = "Stop"

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "Agente POS desinstalado: $TaskName" -ForegroundColor Green
