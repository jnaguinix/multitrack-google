param(
    [switch]$Completo
)

$ErrorActionPreference = "Continue"

# Asegurar toolchain de Rust si no se encuentra en el PATH actual
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $customCargo = "C:\Users\jpuerta\.codex\visualizations\2026\11\09\01a1be2f-be92-7153-bd62-a2684be8afbf\cargo"
    $customRustup = "C:\Users\jpuerta\.codex\visualizations\2026\11\09\01a1be2f-be92-7153-bd62-a2684be8afbf\rustup"
    if (Test-Path "$customCargo\bin\cargo.exe") {
        $env:CARGO_HOME = $customCargo
        $env:RUSTUP_HOME = $customRustup
        $env:PATH = "$customCargo\bin;$env:PATH"
    }
}

$steps = @(
    [PSCustomObject]@{ Name = 'npm run lint'; Command = 'npm run lint'; Status = 'PENDIENTE'; Duration = '0s' },
    [PSCustomObject]@{ Name = 'npm test'; Command = 'npm test'; Status = 'PENDIENTE'; Duration = '0s' },
    [PSCustomObject]@{ Name = 'cargo test --lib'; Command = 'cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib'; Status = 'PENDIENTE'; Duration = '0s' },
    [PSCustomObject]@{ Name = 'npm run build'; Command = 'npm run build'; Status = 'PENDIENTE'; Duration = '0s' }
)

if ($Completo) {
    $steps += [PSCustomObject]@{ Name = 'cargo test (integracion completa)'; Command = 'cargo test --manifest-path desktop/src-tauri/Cargo.toml'; Status = 'PENDIENTE'; Duration = '0s' }
    $steps += [PSCustomObject]@{ Name = 'build:portable (.exe)'; Command = 'npm --prefix desktop run build:portable'; Status = 'PENDIENTE'; Duration = '0s' }
}

Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '  OmniTracks - Suite de Verificacion Automatizada' -ForegroundColor Cyan
if ($Completo) {
    Write-Host '  Modo: COMPLETO (incluye integracion y build portable)' -ForegroundColor Yellow
} else {
    Write-Host '  Modo: RAPIDO (unitarios, linter, tests --lib y build)' -ForegroundColor Yellow
}
Write-Host '====================================================' -ForegroundColor Cyan

$anyFailure = $false

foreach ($step in $steps) {
    Write-Host ''
    Write-Host ('>>> Ejecutando: {0}...' -f $step.Name) -ForegroundColor White
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    
    Invoke-Expression $step.Command
    $exitCode = $LASTEXITCODE
    
    $sw.Stop()
    $step.Duration = ('{0:N1}s' -f $sw.Elapsed.TotalSeconds)
    
    if ($exitCode -ne 0) {
        $step.Status = 'FALLO'
        $anyFailure = $true
        Write-Host ('[FALLO] El paso {0} fallo con codigo {1}.' -f $step.Name, $exitCode) -ForegroundColor Red
        break
    } else {
        $step.Status = 'OK'
        Write-Host ('[OK] {0} completado exitosamente en {1}.' -f $step.Name, $step.Duration) -ForegroundColor Green
    }
}

Write-Host ''
Write-Host '====================================================' -ForegroundColor Cyan
Write-Host '  RESUMEN FINAL DE VERIFICACION' -ForegroundColor Cyan
Write-Host '====================================================' -ForegroundColor Cyan

foreach ($step in $steps) {
    if ($step.Status -eq 'OK') {
        Write-Host ('  [OK]       {0} ({1})' -f $step.Name.PadRight(35), $step.Duration) -ForegroundColor Green
    } elseif ($step.Status -eq 'FALLO') {
        Write-Host ('  [FALLO]    {0} ({1})' -f $step.Name.PadRight(35), $step.Duration) -ForegroundColor Red
    } else {
        Write-Host ('  [OMITIDO]  {0}' -f $step.Name.PadRight(35)) -ForegroundColor DarkGray
    }
}
Write-Host '====================================================' -ForegroundColor Cyan

if ($anyFailure) {
    Write-Host 'ESTADO GLOBAL: FALLO (Se interrumpio por error en el flujo)' -ForegroundColor Red
    Write-Host ''
    exit 1
} else {
    Write-Host 'ESTADO GLOBAL: EXITOSO (Todos los pasos verificados)' -ForegroundColor Green
    Write-Host ''
    exit 0
}
