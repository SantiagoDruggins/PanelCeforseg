param(
  [ValidateSet('health', 'capture', 'match')]
  [string]$Action = 'health',
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

function Emit-Json([hashtable]$Payload) {
  [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 8))
}

function Get-SdkManagedDll {
  $explicit = [Environment]::GetEnvironmentVariable('FINGERPRINT_SDK_DLL')
  if ($explicit -and (Test-Path -LiteralPath $explicit)) {
    return (Resolve-Path -LiteralPath $explicit).Path
  }

  $roots = @()
  $configuredRoot = [Environment]::GetEnvironmentVariable('FINGERPRINT_SDK_ROOT')
  if ($configuredRoot) { $roots += $configuredRoot }
  $roots += @(
    (Join-Path $ScriptRoot '..\vendor\zkfinger-sdk'),
    'C:\Program Files\ZKTeco',
    'C:\Program Files (x86)\ZKTeco',
    'C:\Program Files\FPSensor',
    'C:\Program Files (x86)\FPSensor'
  )

  foreach ($root in ($roots | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $candidate = Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ieq 'Libzkfpcsharp.dll' } |
      Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
  }
  return $null
}

function Initialize-Sdk {
  $managedDll = Get-SdkManagedDll
  if (-not $managedDll) {
    return @{
      ok = $false
      codigo = 'SDK_MISSING'
      mensaje = 'No se encontro Libzkfpcsharp.dll. Instala el ZKFinger SDK para Windows y configura FINGERPRINT_SDK_ROOT.'
    }
  }

  $sdkDir = Split-Path -Parent $managedDll
  $nativeDirs = @($sdkDir)
  $nativeDirs += Get-ChildItem -LiteralPath (Split-Path -Parent $managedDll) -Recurse -Directory -ErrorAction SilentlyContinue |
    Where-Object {
      Get-ChildItem -LiteralPath $_.FullName -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(zkfp|libzk|zkfinger).*\.dll$' } |
        Select-Object -First 1
    } |
    Select-Object -ExpandProperty FullName
  $env:Path = (($nativeDirs | Select-Object -Unique) -join ';') + ';' + $env:Path

  try {
    Add-Type -Path $managedDll -ErrorAction Stop | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch 'already loaded|duplicate') {
      return @{
        ok = $false
        codigo = 'SDK_LOAD_FAILED'
        mensaje = "No se pudo cargar el SDK ZKFinger: $($_.Exception.Message)"
      }
    }
  }

  $sdkType = [AppDomain]::CurrentDomain.GetAssemblies() |
    ForEach-Object { $_.GetType('libzkfpcsharp.zkfp2', $false, $true) } |
    Where-Object { $_ } |
    Select-Object -First 1

  if (-not $sdkType) {
    return @{
      ok = $false
      codigo = 'SDK_TYPE_MISSING'
      mensaje = 'El SDK fue encontrado, pero no contiene la clase libzkfpcsharp.zkfp2.'
    }
  }

  return @{ ok = $true; sdkType = $sdkType; sdkDir = $sdkDir; managedDll = $managedDll }
}

function Invoke-SdkMethod($SdkType, [string]$Name, [object[]]$Arguments = @()) {
  $method = $SdkType.GetMethods() |
    Where-Object { $_.Name -eq $Name -and $_.IsStatic } |
    Sort-Object { $_.GetParameters().Count } |
    Select-Object -First 1
  if (-not $method) { throw "El SDK no expone el metodo $Name" }
  return $method.Invoke($null, $Arguments)
}

function Get-DeviceInfo($SdkType) {
  $initCode = [int](Invoke-SdkMethod $SdkType 'Init')
  if ($initCode -ne 0 -and $initCode -ne 1) {
    return @{ ok = $false; codigo = 'SDK_INIT_FAILED'; sdkCode = $initCode; mensaje = "El SDK no pudo inicializarse (codigo $initCode). Revisa el driver del ZK9500." }
  }

  try {
    $count = [int](Invoke-SdkMethod $SdkType 'GetDeviceCount')
    return @{
      ok = ($count -gt 0)
      deviceCount = $count
      codigo = if ($count -gt 0) { 'READY' } else { 'DEVICE_NOT_FOUND' }
      mensaje = if ($count -gt 0) { 'ZK9500 listo' } else { 'El SDK esta instalado, pero no detecta el ZK9500. Instala el driver y reconecta el USB.' }
    }
  } finally {
    try { [void](Invoke-SdkMethod $SdkType 'Terminate') } catch {}
  }
}

function Open-Device($SdkType) {
  $initCode = [int](Invoke-SdkMethod $SdkType 'Init')
  if ($initCode -ne 0 -and $initCode -ne 1) { throw "SDK_INIT_FAILED:$initCode" }
  $count = [int](Invoke-SdkMethod $SdkType 'GetDeviceCount')
  if ($count -lt 1) { throw 'DEVICE_NOT_FOUND:No se detecto el ZK9500' }
  $device = Invoke-SdkMethod $SdkType 'OpenDevice' @([int]0)
  if (-not $device -or $device -eq [IntPtr]::Zero) { throw 'DEVICE_OPEN_FAILED:No se pudo abrir el ZK9500' }
  return $device
}

function Close-SdkDevice($SdkType, $Device) {
  try { [void](Invoke-SdkMethod $SdkType 'CloseDevice' @($Device)) } catch {}
  try { [void](Invoke-SdkMethod $SdkType 'Terminate') } catch {}
}

function Capture-One($SdkType, $Device, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    $image = New-Object byte[] 120000
    $template = New-Object byte[] 2048
    $templateSize = 2048
    $args = @($Device, $image, $template, [ref]$templateSize)
    $code = [int](Invoke-SdkMethod $SdkType 'AcquireFingerprint' $args)
    if ($code -eq 0 -and $templateSize -gt 0) {
      return ,$template[0..($templateSize - 1)]
    }
    Start-Sleep -Milliseconds 180
  } while ((Get-Date) -lt $deadline)
  throw "CAPTURE_TIMEOUT:No se obtuvo una huella dentro de $Seconds segundos"
}

function Read-Payload([string]$Name) {
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if (-not $raw) { return @{} }
  return ($raw | ConvertFrom-Json)
}

try {
  $loaded = Initialize-Sdk
  if (-not $loaded.ok) {
    Emit-Json $loaded
    exit 0
  }
  $sdkType = $loaded.sdkType

  if ($Action -eq 'health') {
    $health = Get-DeviceInfo $sdkType
    $health.sdk = $loaded.managedDll
    $health.device = 'ZK9500'
    Emit-Json $health
    exit 0
  }

  if ($Action -eq 'capture') {
    $payload = Read-Payload 'FINGERPRINT_CAPTURE_PAYLOAD'
    $device = $null
    try {
      $device = Open-Device $sdkType
      $purpose = [string]$payload.purpose
      $samples = if ($purpose -eq 'enroll') { 3 } else { 1 }
      $captured = @()
      for ($i = 1; $i -le $samples; $i++) {
        $captured += ,(Capture-One $sdkType $device $TimeoutSeconds)
        if ($i -lt $samples) { Start-Sleep -Milliseconds 700 }
      }

      $output = $captured[0]
      if ($samples -eq 3) {
        $db = Invoke-SdkMethod $sdkType 'DBInit'
        if (-not $db -or $db -eq [IntPtr]::Zero) { throw 'DB_INIT_FAILED:No se pudo iniciar el algoritmo de huella' }
        try {
          $merged = New-Object byte[] 2048
          $mergedSize = 2048
          $mergeArgs = @($db, $captured[0], $captured[1], $captured[2], $merged, [ref]$mergedSize)
          $mergeCode = [int](Invoke-SdkMethod $sdkType 'DBMerge' $mergeArgs)
          if ($mergeCode -ne 0 -or $mergedSize -le 0) { throw "ENROLL_MERGE_FAILED:No se pudieron combinar las tres lecturas (codigo $mergeCode)" }
          $output = $merged[0..($mergedSize - 1)]
        } finally {
          try { [void](Invoke-SdkMethod $sdkType 'DBFree' @($db)) } catch {}
        }
      }

      Emit-Json @{
        ok = $true
        template = [Convert]::ToBase64String([byte[]]$output)
        quality = $null
        device = 'ZK9500'
        muestras = $samples
        mensaje = if ($samples -eq 3) { 'Huella registrada con tres lecturas' } else { 'Huella capturada' }
      }
    } finally {
      if ($device) { Close-SdkDevice $sdkType $device }
    }
    exit 0
  }

  if ($Action -eq 'match') {
    $payload = Read-Payload 'FINGERPRINT_MATCH_PAYLOAD'
    $probe = [Convert]::FromBase64String([string]$payload.probe)
    $candidates = @($payload.candidates)
    $threshold = [int]($payload.threshold)
    if ($threshold -le 0) { $threshold = 60 }
    $device = $null
    try {
      $device = Open-Device $sdkType
      $db = Invoke-SdkMethod $sdkType 'DBInit'
      if (-not $db -or $db -eq [IntPtr]::Zero) { throw 'DB_INIT_FAILED:No se pudo iniciar el algoritmo de huella' }
      try {
        $best = $null
        foreach ($candidate in $candidates) {
          if (-not $candidate.template) { continue }
          try { $candidateTemplate = [Convert]::FromBase64String([string]$candidate.template) } catch { continue }
          $score = [int](Invoke-SdkMethod $sdkType 'DBMatch' @($db, $probe, $candidateTemplate))
          if ($score -ge $threshold -and (-not $best -or $score -gt $best.score)) {
            $best = @{ id = $candidate.id; score = $score }
          }
        }
        if ($best) {
          Emit-Json @{ ok = $true; matched = $true; candidateId = $best.id; score = $best.score; mode = 'zkfinger-sdk' }
        } else {
          Emit-Json @{ ok = $true; matched = $false; score = 0; mode = 'zkfinger-sdk' }
        }
      } finally {
        try { [void](Invoke-SdkMethod $sdkType 'DBFree' @($db)) } catch {}
      }
    } finally {
      if ($device) { Close-SdkDevice $sdkType $device }
    }
    exit 0
  }
} catch {
  $message = $_.Exception.Message
  Emit-Json @{ ok = $false; codigo = 'SDK_ERROR'; mensaje = $message }
  exit 0
}
