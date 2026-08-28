[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][string]$OutputPath,
    [string]$MakeNsisPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$verifyScript = Join-Path $PSScriptRoot 'verify-package-windows.ps1'
$nsiPath = Join-Path $repositoryRoot 'installer/aipob.nsi'
$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath -ErrorAction Stop).Path
if ([IO.Path]::GetExtension($resolvedPackage).ToLowerInvariant() -ne '.zip') {
    throw 'PackagePath must be the canonical portable .zip archive.'
}
if (-not (Test-Path -LiteralPath $verifyScript -PathType Leaf)) { throw "Package verifier not found: $verifyScript" }
if (-not (Test-Path -LiteralPath $nsiPath -PathType Leaf)) { throw "NSIS source not found: $nsiPath" }

& $verifyScript -PackagePath $resolvedPackage

$compilerPath = if ([string]::IsNullOrWhiteSpace($MakeNsisPath)) {
    $compilerCommand = Get-Command makensis.exe -ErrorAction SilentlyContinue
    if ($null -ne $compilerCommand) {
        $compilerCommand.Source
    }
    else {
        $compilerCandidates = [System.Collections.Generic.List[string]]::new()
        foreach ($programFilesRoot in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
            if (-not [string]::IsNullOrWhiteSpace($programFilesRoot)) {
                [void]$compilerCandidates.Add((Join-Path $programFilesRoot 'NSIS/makensis.exe'))
            }
        }
        $installedCompiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if ($null -eq $installedCompiler) { throw 'makensis.exe was not found on PATH or in a standard NSIS installation directory.' }
        $installedCompiler
    }
} else {
    (Resolve-Path -LiteralPath $MakeNsisPath -ErrorAction Stop).Path
}
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$outputParent = Split-Path -Parent $resolvedOutput
[IO.Directory]::CreateDirectory($outputParent) | Out-Null
if (Test-Path -LiteralPath $resolvedOutput) {
    Write-Host "Overwriting exact installer output: $resolvedOutput"
    Remove-Item -LiteralPath $resolvedOutput -Force
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('aipob-installer-stage-' + [guid]::NewGuid().ToString('N'))
$stagingPath = Join-Path $temporaryRoot 'staging'
[IO.Directory]::CreateDirectory($stagingPath) | Out-Null
try {
    Expand-Archive -LiteralPath $resolvedPackage -DestinationPath $stagingPath
    $pobNames = @('Path of Building.exe', 'Path{space}of{space}Building.exe', 'PathOfBuilding.exe')
    $pobExecutable = $pobNames | ForEach-Object { Join-Path $stagingPath $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if ($null -eq $pobExecutable) { throw 'Canonical staging does not contain a PoB executable.' }
    & $compilerPath "/DSTAGING_PATH=$stagingPath" "/DOUTPUT_PATH=$resolvedOutput" $nsiPath
    if ($LASTEXITCODE -ne 0) { throw "NSIS compilation failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath $resolvedOutput -PathType Leaf)) { throw "NSIS output not found: $resolvedOutput" }
}
finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemporary.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTemporary).StartsWith('aipob-installer-stage-', [StringComparison]::Ordinal)) {
        Write-Host "Removing exact temporary staging: $resolvedTemporary"
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "Built canonical AIPoB installer: $resolvedOutput"
