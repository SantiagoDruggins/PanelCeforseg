param(
  [string]$AgentHost = "127.0.0.1",
  [int]$AgentPort = 17778,
  [string]$DeviceName = "ZK9500",
  [string]$SdkRoot = "",
  [string]$CaptureCommand = "",
  [string]$CaptureArgs = "",
  [string]$MatchCommand = "",
  [string]$MatchArgs = ""
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "fingerprint-agent.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $Root

$env:FINGERPRINT_AGENT_HOST = $AgentHost
$env:FINGERPRINT_AGENT_PORT = [string]$AgentPort
$env:FINGERPRINT_DEVICE_NAME = $DeviceName
if ($SdkRoot) { $env:FINGERPRINT_SDK_ROOT = $SdkRoot }
if ($CaptureCommand) { $env:FINGERPRINT_CAPTURE_COMMAND = $CaptureCommand }
if ($CaptureArgs) { $env:FINGERPRINT_CAPTURE_ARGS = $CaptureArgs }
if ($MatchCommand) { $env:FINGERPRINT_MATCH_COMMAND = $MatchCommand }
if ($MatchArgs) { $env:FINGERPRINT_MATCH_ARGS = $MatchArgs }

function Write-LogLine([string]$Message) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogFile -Value "[$stamp] $Message"
}

Write-LogLine "Iniciando agente de huella. Dispositivo=$DeviceName Agente=http://$AgentHost`:$AgentPort"

while ($true) {
  try {
    Write-LogLine "Levantando node tools\fingerprint-local-agent.js"
    & node tools\fingerprint-local-agent.js *>> $LogFile
    $exit = $LASTEXITCODE
    Write-LogLine "El agente de huella termino con codigo $exit. Reiniciando en 5 segundos."
  } catch {
    Write-LogLine "Error del agente de huella: $($_.Exception.Message). Reiniciando en 5 segundos."
  }
  Start-Sleep -Seconds 5
}
