@echo off
setlocal
cd /d "%~dp0.."

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-pos-agent-windows.ps1" -PrinterHost "192.168.1.5" -PrinterPort 9100 -AgentPort 17777

echo.
echo Si no hubo errores, el agente POS ya quedo instalado y arrancara solo al iniciar sesion.
echo Puedes cerrar esta ventana.
pause
