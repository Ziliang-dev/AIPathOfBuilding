[CmdletBinding()]
param(
    [switch]$SkipChecks
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sidecarPath = Join-Path $repositoryRoot 'sidecar'
$packagePath = Join-Path $sidecarPath 'package.json'
$releaseEntryPath = Join-Path $sidecarPath 'dist/server.cjs'
$checkScript = Join-Path $PSScriptRoot 'check-sidecar.ps1'

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "Sidecar package not found: $packagePath"
}

if (-not $SkipChecks) {
    & $checkScript
    if ($LASTEXITCODE -ne 0) {
        throw "Sidecar checks failed with exit code $LASTEXITCODE."
    }
}

$pnpmCommand = Get-Command pnpm -ErrorAction Stop
$resolvedSidecarPath = (Resolve-Path -LiteralPath $sidecarPath).Path
Push-Location -LiteralPath $resolvedSidecarPath
try {
    & $pnpmCommand.Source run build
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm run build failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $releaseEntryPath -PathType Leaf)) {
    throw "Release build did not produce $releaseEntryPath."
}

Write-Host "Built release entry: $releaseEntryPath"
