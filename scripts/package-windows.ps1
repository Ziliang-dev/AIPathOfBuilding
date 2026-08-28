[CmdletBinding()]
param(
    [string]$NodeExePath = $env:AIPOB_NODE_EXE,
    [string]$OutputPath,
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sidecarPath = Join-Path $repositoryRoot 'sidecar'
$distPath = Join-Path $sidecarPath 'dist'
$releaseEntryPath = Join-Path $distPath 'server.cjs'
$buildScript = Join-Path $PSScriptRoot 'build-sidecar.ps1'

if ([string]::IsNullOrWhiteSpace($NodeExePath)) {
    throw 'Pass -NodeExePath or set AIPOB_NODE_EXE to a portable Node.js 24 node.exe.'
}

$resolvedNodePath = (Resolve-Path -LiteralPath $NodeExePath -ErrorAction Stop).Path
if ([System.IO.Path]::GetFileName($resolvedNodePath) -ne 'node.exe') {
    throw "Node runtime must be a node.exe file; received $resolvedNodePath."
}

$nodeVersionText = (& $resolvedNodePath --version).TrimStart('v')
if ($LASTEXITCODE -ne 0) {
    throw "Unable to execute Node runtime: $resolvedNodePath"
}
$nodeVersion = [System.Version]::Parse($nodeVersionText)
if ($nodeVersion.Major -ne 24) {
    throw "Portable package requires Node.js 24; found $nodeVersion."
}
$nodePlatform = (& $resolvedNodePath -p "process.platform + ':' + process.arch").Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Unable to query Node runtime architecture: $resolvedNodePath"
}
if ($nodePlatform -ne 'win32:x64') {
    throw "Portable package requires win32:x64 Node.js; found $nodePlatform."
}

if (-not $SkipBuild) {
    & $buildScript
    if ($LASTEXITCODE -ne 0) {
        throw "Sidecar build failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $releaseEntryPath -PathType Leaf)) {
    throw "Release entry not found: $releaseEntryPath"
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $repositoryRoot 'artifacts/AIPathOfBuilding-AIPoB-windows-x64'
}

$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$zipPath = "$resolvedOutputPath.zip"
Write-Host "Package directory: $resolvedOutputPath"
Write-Host "Package archive: $zipPath"

if ($resolvedOutputPath -eq $repositoryRoot -or $resolvedOutputPath.StartsWith($sidecarPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputPath must not be the repository root or a child of sidecar.'
}
if (Test-Path -LiteralPath $resolvedOutputPath) {
    throw "Output directory already exists: $resolvedOutputPath"
}
if (Test-Path -LiteralPath $zipPath) {
    throw "Output archive already exists: $zipPath"
}

$outputParent = Split-Path -Parent $resolvedOutputPath
[System.IO.Directory]::CreateDirectory($outputParent) | Out-Null
[System.IO.Directory]::CreateDirectory($resolvedOutputPath) | Out-Null
$packageSidecarPath = Join-Path $resolvedOutputPath 'sidecar'
$packageDistPath = Join-Path $packageSidecarPath 'dist'
$packageRuntimePath = Join-Path $packageSidecarPath 'runtime'
$packageNodeModulesPath = Join-Path $packageSidecarPath 'node_modules'
[System.IO.Directory]::CreateDirectory($packageSidecarPath) | Out-Null
[System.IO.Directory]::CreateDirectory($packageDistPath) | Out-Null
[System.IO.Directory]::CreateDirectory($packageRuntimePath) | Out-Null
[System.IO.Directory]::CreateDirectory($packageNodeModulesPath) | Out-Null

Copy-Item -LiteralPath $releaseEntryPath -Destination $packageDistPath
Copy-Item -LiteralPath $resolvedNodePath -Destination (Join-Path $packageRuntimePath 'node.exe')

$sqliteSourcePath = Join-Path $sidecarPath 'node_modules/better-sqlite3'
$sqlitePackagePath = Join-Path $sqliteSourcePath 'package.json'
$sqliteLibPath = Join-Path $sqliteSourcePath 'lib'
$sqliteLicensePath = Join-Path $sqliteSourcePath 'LICENSE'
$sqlitePrebuildPath = Join-Path $sqliteSourcePath 'prebuilds/win32-x64.node'
foreach ($requiredPath in @($sqlitePackagePath, $sqliteLibPath, $sqliteLicensePath, $sqlitePrebuildPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required better-sqlite3 runtime asset not found: $requiredPath"
    }
}

$packageSqlitePath = Join-Path $packageNodeModulesPath 'better-sqlite3'
$packageSqlitePrebuildsPath = Join-Path $packageSqlitePath 'prebuilds'
[System.IO.Directory]::CreateDirectory($packageSqlitePath) | Out-Null
[System.IO.Directory]::CreateDirectory($packageSqlitePrebuildsPath) | Out-Null
Copy-Item -LiteralPath $sqlitePackagePath -Destination $packageSqlitePath
Copy-Item -LiteralPath $sqliteLicensePath -Destination $packageSqlitePath
Copy-Item -LiteralPath $sqliteLibPath -Destination $packageSqlitePath -Recurse
Copy-Item -LiteralPath $sqlitePrebuildPath -Destination $packageSqlitePrebuildsPath

$packagedNodePath = Join-Path $packageRuntimePath 'node.exe'
Push-Location -LiteralPath $packageSidecarPath
try {
    & $packagedNodePath -e "require('better-sqlite3');"
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged better-sqlite3 failed to load with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$readmePath = Join-Path $repositoryRoot 'README-AIPOB.md'
$licensePath = Join-Path $repositoryRoot 'LICENSE.md'
if (Test-Path -LiteralPath $readmePath -PathType Leaf) {
    Copy-Item -LiteralPath $readmePath -Destination $resolvedOutputPath
}
if (Test-Path -LiteralPath $licensePath -PathType Leaf) {
    Copy-Item -LiteralPath $licensePath -Destination $resolvedOutputPath
}

$checksums = Get-ChildItem -LiteralPath $resolvedOutputPath -File -Recurse | ForEach-Object {
    $relativePath = [System.IO.Path]::GetRelativePath($resolvedOutputPath, $_.FullName).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $relativePath"
}
$checksumPath = Join-Path $resolvedOutputPath 'SHA256SUMS.txt'
[System.IO.File]::WriteAllLines($checksumPath, $checksums, [System.Text.UTF8Encoding]::new($false))

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $resolvedOutputPath,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $true
)

Write-Host "Packaged Node.js $nodeVersion and sidecar bundle: $zipPath"
