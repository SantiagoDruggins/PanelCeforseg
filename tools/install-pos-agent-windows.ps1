param(
  [string]$PrinterHost = "192.168.1.5",
  [int]$PrinterPort = 9100,
  [int]$AgentPort = 17777,
  [string]$TaskName = "DenverPOSAgent"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Runner = Join-Path $PSScriptRoot "run-pos-agent.ps1"
$Node = Get-Command node -ErrorAction SilentlyContinue

if (-not $Node) {
  throw "Node.js no esta instalado o no esta en PATH. Instala Node.js antes de instalar el agente POS."
}

$Args = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", "`"$Runner`"",
  "-PrinterHost", "`"$PrinterHost`"",
  "-PrinterPort", $PrinterPort,
  "-AgentPort", $AgentPort
) -join " "

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Args -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Days 365) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$UserId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel LeastPrivilege

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Agente POS instalado y arrancado." -ForegroundColor Green
Write-Host "Tarea: $TaskName"
Write-Host "Impresora: $PrinterHost`:$PrinterPort"
Write-Host "Agente local: http://127.0.0.1:$AgentPort"
Write-Host "Log: $(Join-Path $Root 'logs\pos-agent.log')"
