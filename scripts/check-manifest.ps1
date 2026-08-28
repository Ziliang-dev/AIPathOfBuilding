[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestUpdaterPath = Join-Path $repositoryRoot 'update_manifest.py'
$generatedManifestPath = Join-Path $repositoryRoot 'manifest-updated.xml'
$releaseEntryPath = Join-Path $repositoryRoot 'sidecar/dist/server.cjs'

foreach ($requiredPath in @($manifestUpdaterPath, $releaseEntryPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required manifest input not found: $requiredPath"
    }
}

$pythonCommand = Get-Command python -ErrorAction Stop
Push-Location -LiteralPath $repositoryRoot
try {
    & $pythonCommand.Source $manifestUpdaterPath --quiet
    if ($LASTEXITCODE -ne 0) {
        throw "Manifest generation failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $generatedManifestPath -PathType Leaf)) {
    throw "Generated manifest not found: $generatedManifestPath"
}

[xml]$manifest = Get-Content -Raw -LiteralPath $generatedManifestPath
$sidecarSources = @($manifest.PoBVersion.Source | Where-Object { $_.part -eq 'sidecar' })
if ($sidecarSources.Count -ne 1) {
    throw "Expected one sidecar manifest source; found $($sidecarSources.Count)."
}
$expectedUrl = 'https://raw.githubusercontent.com/Ziliang-dev/AIPathOfBuilding/{branch}/'
if ($sidecarSources[0].url -ne $expectedUrl) {
    throw "Unexpected sidecar manifest URL: $($sidecarSources[0].url)"
}

$sidecarFiles = @($manifest.PoBVersion.File | Where-Object { $_.part -eq 'sidecar' })
if ($sidecarFiles.Count -ne 1 -or $sidecarFiles[0].name -ne 'sidecar/dist/server.cjs') {
    $names = ($sidecarFiles | ForEach-Object { $_.name }) -join ', '
    throw "Manifest must contain only sidecar/dist/server.cjs for sidecar; found: $names"
}

Write-Host 'Manifest sidecar source and release entry are valid.'
