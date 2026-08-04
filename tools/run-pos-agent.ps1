param(
  [string]$PrinterHost = "192.168.1.5",
  [int]$PrinterPort = 9100,
  [string]$AgentHost = "127.0.0.1",
  [int]$AgentPort = 17777
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogDir = Join-Path $Root "logs"
$LogFile = Join-Path $LogDir "pos-agent.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $Root

$env:POS_PRINTER_HOST = $PrinterHost
$env:POS_PRINTER_PORT = [string]$PrinterPort
$env:POS_AGENT_HOST = $AgentHost
$env:POS_AGENT_PORT = [string]$AgentPort

function Write-LogLine([string]$Message) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $LogFile -Value "[$stamp] $Message"
}

Write-LogLine "Iniciando agente POS. Impresora=$PrinterHost`:$PrinterPort Agente=http://$AgentHost`:$AgentPort"

while ($true) {
  try {
    Write-LogLine "Levantando node tools\pos-local-agent.js"
    & node tools\pos-local-agent.js *>> $LogFile
    $exit = $LASTEXITCODE
    Write-LogLine "El agente POS termino con codigo $exit. Reiniciando en 5 segundos."
  } catch {
    Write-LogLine "Error del agente POS: $($_.Exception.Message). Reiniciando en 5 segundos."
  }
  Start-Sleep -Seconds 5
}
