[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sidecarPath = Join-Path $repositoryRoot 'sidecar'
$packagePath = Join-Path $sidecarPath 'package.json'

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "Sidecar package not found: $packagePath"
}

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeVersionText = (& $nodeCommand.Source --version).TrimStart('v')
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to query the Node.js version.'
}

$nodeVersion = [System.Version]::Parse($nodeVersionText)
$minimumNodeVersion = [System.Version]'22.13.0'
if ($nodeVersion -lt $minimumNodeVersion) {
    throw "Node.js $minimumNodeVersion or newer is required; found $nodeVersion."
}

$pnpmCommand = Get-Command pnpm -ErrorAction Stop
$resolvedSidecarPath = (Resolve-Path -LiteralPath $sidecarPath).Path
Push-Location -LiteralPath $resolvedSidecarPath
try {
    & $pnpmCommand.Source install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm install failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
