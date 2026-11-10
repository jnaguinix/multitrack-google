param(
    [Parameter(Mandatory = $true)]
    [string]$PublicKeyFile
)

$ErrorActionPreference = 'Stop'
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    throw 'Define TAURI_SIGNING_PRIVATE_KEY antes de generar una versión publicable.'
}

$publicKey = (Get-Content -Raw -LiteralPath $PublicKeyFile).Trim()
if (-not $publicKey) {
    throw 'El archivo de clave pública está vacío.'
}

$repo = 'jnaguinix/multitrack-google'
$releaseBase = "https://github.com/$repo/releases"
$baseConfig = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'src-tauri/tauri.conf.json') | ConvertFrom-Json
$version = $baseConfig.version
$tag = "desktop-v$version"
$target = 'x86_64-pc-windows-msvc'
$buildConfig = New-TemporaryFile
$configPath = "$($buildConfig.FullName).json"
try {
    @{
        bundle = @{ createUpdaterArtifacts = $true }
        plugins = @{
            updater = @{
                pubkey = $publicKey
                endpoints = @("$releaseBase/latest/download/latest.json")
                requireSignedVersion = $true
            }
        }
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding ASCII

    npm.cmd --prefix $PSScriptRoot run build -- --config $configPath
    if ($LASTEXITCODE -ne 0) { throw "La compilación firmada falló ($LASTEXITCODE)." }

    $manifestPath = Join-Path $PSScriptRoot 'src-tauri/Cargo.toml'
    $metadata = cargo metadata --format-version 1 --no-deps --manifest-path $manifestPath
    if ($LASTEXITCODE -ne 0) { throw "No se pudo localizar el directorio de Cargo ($LASTEXITCODE)." }
    $targetDir = ($metadata | ConvertFrom-Json).target_directory
    $bundleDir = Join-Path $targetDir "$target/release/bundle/nsis"
    $signedSetups = @(Get-ChildItem -LiteralPath $bundleDir -Filter "*_${version}_x64-setup.exe.sig" -File)
    if ($signedSetups.Count -ne 1) { throw "Se esperaba una sola firma NSIS para $version en $bundleDir." }

    $signature = (Get-Content -Raw -LiteralPath $signedSetups[0].FullName).Trim()
    $installer = "$($baseConfig.productName)-$version-x64-setup.exe"
    $outputDir = Join-Path $targetDir "$target/release/desktop-release/$tag"
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    Copy-Item -LiteralPath ($signedSetups[0].FullName -replace '\.sig$', '') -Destination (Join-Path $outputDir $installer)
    @{
        version = $version
        platforms = @{
            'windows-x86_64' = @{
                signature = $signature
                url = "$releaseBase/download/$tag/$installer"
            }
        }
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $outputDir 'latest.json') -Encoding ASCII
    Write-Output "Archivos listos para publicar en $tag desde $outputDir"
} finally {
    Remove-Item -LiteralPath $configPath, $buildConfig.FullName -ErrorAction SilentlyContinue
}
