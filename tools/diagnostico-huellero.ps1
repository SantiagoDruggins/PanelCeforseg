$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$instanceId = 'USB\VID_1B55&PID_0124'

Write-Host '=== Diagnostico ZK9500 / Panel CEFORSEG ===' -ForegroundColor Cyan
Write-Host "Equipo: $env:COMPUTERNAME"
Write-Host "Fecha:  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host ''

$device = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
  Where-Object { $_.InstanceId -like "$instanceId*" -or $_.FriendlyName -eq 'ZK9500' } |
  Select-Object -First 1

if ($device) {
  Write-Host "USB:    $($device.FriendlyName) [$($device.Status)]"
  $details = Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB\\VID_1B55&PID_0124%'" -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($details) {
    Write-Host "Driver: $($details.Status) / codigo $($details.ConfigManagerErrorCode)"
    if ($details.ConfigManagerErrorCode -eq 28) {
      Write-Host 'Accion: instala el driver incluido en ZKFinger SDK para Windows y reconecta el USB.' -ForegroundColor Yellow
    }
  }
} else {
  Write-Host 'USB:    no se encontro el ZK9500 conectado' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'SDK:'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'zkfinger-sdk.ps1') -Action health

Write-Host ''
Write-Host 'Agente local:'
try {
  (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:17778/health' -TimeoutSec 5).Content
} catch {
  Write-Host 'No responde en http://127.0.0.1:17778. Ejecuta npm run fingerprint-agent o instala la tarea de Windows.' -ForegroundColor Yellow
}
