[CmdletBinding()]
param(
    [switch]$Install
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$checkPowerShellPath = Join-Path $PSScriptRoot 'check-powershell.ps1'
$checkSidecarPath = Join-Path $PSScriptRoot 'check-sidecar.ps1'
$buildSidecarPath = Join-Path $PSScriptRoot 'build-sidecar.ps1'
$checkManifestPath = Join-Path $PSScriptRoot 'check-manifest.ps1'
$luaSpecPaths = @(
    'spec/System/TestAIPoBCore_spec.lua',
    'spec/System/TestAIPoBRpc_spec.lua',
    'spec/System/TestAIPoBTradeBroker_spec.lua',
    'spec/System/TestAIPoBNativeProbe_spec.lua',
    'spec/System/TestAIPoBActorSeason_spec.lua',
    'spec/System/TestAIPoBGolden_spec.lua',
    'spec/System/TestAIPlannerTab_spec.lua'
)
$bustedSpecs = @($luaSpecPaths | ForEach-Object { "../$_" })
$manifestPath = Join-Path $repositoryRoot 'spec/AIPoBGolden/manifest.json'

foreach ($requiredPath in @($checkPowerShellPath, $checkSidecarPath, $buildSidecarPath, $checkManifestPath, $manifestPath) + @($luaSpecPaths | ForEach-Object { Join-Path $repositoryRoot $_ })) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Release gate input not found: $requiredPath"
    }
}

$pnpmCommand = Get-Command pnpm -ErrorAction Stop
$bustedCommand = Get-Command busted -ErrorAction SilentlyContinue
$dockerCommand = if ($null -eq $bustedCommand) { Get-Command docker -ErrorAction SilentlyContinue } else { $null }
if ($null -eq $bustedCommand -and $null -eq $dockerCommand) {
    throw 'Golden Lua gate requires busted or Docker.'
}

& $checkPowerShellPath
if ($Install) {
    & $checkSidecarPath -Install
}
else {
    & $checkSidecarPath
}
if ($LASTEXITCODE -ne 0) {
    throw "Sidecar checks failed with exit code $LASTEXITCODE."
}

& $buildSidecarPath -SkipChecks
if ($LASTEXITCODE -ne 0) {
    throw "Sidecar release build failed with exit code $LASTEXITCODE."
}

& $checkManifestPath
if ($LASTEXITCODE -ne 0) {
    throw "Manifest check failed with exit code $LASTEXITCODE."
}

Push-Location -LiteralPath $repositoryRoot
try {
    & $pnpmCommand.Source '--dir' 'sidecar' 'exec' 'vitest' 'run' 'tests/release-gate.test.ts'
    if ($LASTEXITCODE -ne 0) {
        throw "Golden corpus TypeScript harness failed with exit code $LASTEXITCODE."
    }

    if ($null -ne $bustedCommand) {
        & $bustedCommand.Source '--lua=luajit' @bustedSpecs
    } else {
        & $dockerCommand.Source 'compose' 'run' '--rm' '--no-deps' 'busted-tests' 'busted' '--lua=luajit' @bustedSpecs
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Golden corpus Lua harness failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

Write-Host 'Release gate passed: sidecar, manifest, Golden corpus, and all AIPoB Lua checks.'
