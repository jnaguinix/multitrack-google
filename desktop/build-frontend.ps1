$ErrorActionPreference = 'Stop'
$previous = $env:VITE_LIBRETRACKS_DESKTOP
Push-Location (Join-Path $PSScriptRoot '..')
try {
    $env:VITE_LIBRETRACKS_DESKTOP = '1'
    npm.cmd run build -- --outDir desktop/dist --emptyOutDir
    if ($LASTEXITCODE -ne 0) { throw "Vite falló ($LASTEXITCODE)." }
} finally {
    $env:VITE_LIBRETRACKS_DESKTOP = $previous
    Pop-Location
}
