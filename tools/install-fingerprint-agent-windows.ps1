param(
  [int]$AgentPort = 17778,
  [string]$DeviceName = "ZK9500",
  [string]$SdkRoot = "",
  [string]$CaptureCommand = "",
  [string]$CaptureArgs = "",
  [string]$MatchCommand = "",
  [string]$MatchArgs = "",
  [string]$TaskName = "DenverFingerprintAgent"
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Runner = Join-Path $PSScriptRoot "run-fingerprint-agent.ps1"
$Node = Get-Command node -ErrorAction SilentlyContinue

$ResolvedSdkRoot = $SdkRoot
if ($SdkRoot) {
  if (-not (Test-Path -LiteralPath $SdkRoot)) {
    throw "No se encontro la carpeta del SDK: $SdkRoot"
  }
  $ResolvedSdkRoot = (Resolve-Path -LiteralPath $SdkRoot).Path
  [Environment]::SetEnvironmentVariable('FINGERPRINT_SDK_ROOT', $ResolvedSdkRoot, 'User')
  $env:FINGERPRINT_SDK_ROOT = $ResolvedSdkRoot
}

if (-not $Node) {
  throw "Node.js no esta instalado o no esta en PATH. Instala Node.js antes de instalar el agente del huellero."
}

$Args = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", "`"$Runner`"",
  "-AgentPort", $AgentPort,
  "-DeviceName", "`"$DeviceName`"",
  "-SdkRoot", "`"$ResolvedSdkRoot`"",
  "-CaptureCommand", "`"$CaptureCommand`"",
  "-CaptureArgs", "`"$CaptureArgs`"",
  "-MatchCommand", "`"$MatchCommand`"",
  "-MatchArgs", "`"$MatchArgs`""
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
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
$installedAs = 'scheduled-task'
try {
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal | Out-Null
  Start-ScheduledTask -TaskName $TaskName
} catch {
  $installedAs = 'user-startup'
  $startupDir = [Environment]::GetFolderPath('Startup')
  $startupFile = Join-Path $startupDir "$TaskName.cmd"
  $startupLine = "@echo off`r`npowershell.exe $Args`r`n"
  [IO.File]::WriteAllText($startupFile, $startupLine, [Text.Encoding]::ASCII)
  Start-Process -FilePath 'powershell.exe' -ArgumentList $Args -WorkingDirectory $Root -WindowStyle Hidden
  Write-Host "No se pudo registrar la tarea programada sin permisos de administrador; se uso el inicio del usuario." -ForegroundColor Yellow
  Write-Host "Detalle: $($_.Exception.Message)" -ForegroundColor DarkYellow
}

Write-Host "Agente de huella instalado y arrancado." -ForegroundColor Green
Write-Host "Modo de arranque: $installedAs"
Write-Host "Tarea: $TaskName"
Write-Host "Dispositivo: $DeviceName"
Write-Host "Agente local: http://127.0.0.1:$AgentPort"
Write-Host "Capturador SDK: $CaptureCommand"
Write-Host "Comparador SDK: $MatchCommand"
Write-Host "Log: $(Join-Path $Root 'logs\fingerprint-agent.log')"
