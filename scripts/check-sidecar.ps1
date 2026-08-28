[CmdletBinding()]
param(
    [switch]$Install
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sidecarPath = Join-Path $repositoryRoot 'sidecar'
$packagePath = Join-Path $sidecarPath 'package.json'
$installScript = Join-Path $PSScriptRoot 'install-sidecar.ps1'

if ($Install) {
    & $installScript
    if ($LASTEXITCODE -ne 0) {
        throw "Dependency installation failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
    throw "Sidecar package not found: $packagePath"
}

$package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json
$scriptNames = @($package.scripts.PSObject.Properties.Name)
$pnpmCommand = Get-Command pnpm -ErrorAction Stop
$resolvedSidecarPath = (Resolve-Path -LiteralPath $sidecarPath).Path

function Invoke-SidecarScript {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    & $pnpmCommand.Source run $Name
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm run $Name failed with exit code $LASTEXITCODE."
    }
}

Push-Location -LiteralPath $resolvedSidecarPath
try {
    if ($scriptNames -contains 'lint') {
        Invoke-SidecarScript -Name 'lint'
    }
    else {
        Write-Host 'No lint script is defined; skipping lint.'
    }

    if ($scriptNames -contains 'typecheck') {
        Invoke-SidecarScript -Name 'typecheck'
    }
    elseif ($scriptNames -contains 'check') {
        Invoke-SidecarScript -Name 'check'
    }
    else {
        throw 'Neither a typecheck nor check script is defined.'
    }

    Invoke-SidecarScript -Name 'test'
}
finally {
    Pop-Location
}
