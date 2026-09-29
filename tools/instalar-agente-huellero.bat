@echo off
setlocal
cd /d "%~dp0.."

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-fingerprint-agent-windows.ps1" -AgentPort 17778 -DeviceName "ZK9500"

echo.
echo Si no hubo errores, el agente del huellero quedo instalado y arrancara solo al iniciar sesion.
echo IMPORTANTE: instala primero el ZKFinger SDK para Windows y su driver del ZK9500.
echo Si el SDK no esta en una ruta estandar, reinstala pasando -SdkRoot "C:\ruta\del\sdk".
echo Puedes cerrar esta ventana.
pause
