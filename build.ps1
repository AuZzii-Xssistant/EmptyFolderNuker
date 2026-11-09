param(
    [string] $Node = 'node',
    [string] $SourceCommit
)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    cargo test --locked -p efn-core --quiet
    if ($LASTEXITCODE) { throw 'The Rust tests failed.' }

    if (!$env:SHOTS) { $env:SHOTS = [IO.Path]::GetTempPath() }
    & $Node tests/ui.test.mjs
    if ($LASTEXITCODE) { throw 'The UI tests failed.' }

    $metadata = cargo metadata --locked --no-deps --format-version 1 | ConvertFrom-Json
    if ($LASTEXITCODE) { throw 'Could not read Cargo workspace metadata.' }
    cargo build --locked --release -p empty-folder-nuker --features custom-protocol
    if ($LASTEXITCODE) { throw 'The Windows release build failed.' }

    $version = ($metadata.packages | Where-Object name -eq 'empty-folder-nuker').version
    $exe = Join-Path $metadata.target_directory 'release\empty-folder-nuker.exe'
    $builds = Join-Path $PSScriptRoot 'builds'
    New-Item -ItemType Directory -Path $builds -Force | Out-Null
    $output = Join-Path $builds 'EmptyFolderNuker.exe'
    Copy-Item -LiteralPath $exe -Destination $output -Force
    if (!$SourceCommit) {
        $SourceCommit = git rev-parse --short HEAD 2>$null
        if ($LASTEXITCODE) { $SourceCommit = 'unknown' }
    }
    @(
        'EmptyFolderNuker.exe'
        "version : $version"
        "built   : $([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mmZ'))"
        "commit  : $SourceCommit (+ uncommitted changes, if any)"
        "size    : $((Get-Item -LiteralPath $output).Length) bytes"
        "sha256  : $((Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant())"
    ) | Set-Content -LiteralPath (Join-Path $builds 'BUILDINFO.txt') -Encoding ascii
    Get-Content -LiteralPath (Join-Path $builds 'BUILDINFO.txt')
} finally {
    Pop-Location
}
