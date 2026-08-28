[CmdletBinding()]
param(
    [string]$NodeExePath = $env:AIPOB_NODE_EXE,
    [string]$OutputPath,
    [string]$SidecarBundlePath,
    [string]$RuntimeArchivePath,
    [string]$ManifestConfigPath,
    [string]$CredentialHelperPath,
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sidecarPath = Join-Path $repositoryRoot 'sidecar'
$distPath = Join-Path $sidecarPath 'dist'
$releaseEntryPath = Join-Path $distPath 'server.cjs'
$buildScript = Join-Path $PSScriptRoot 'build-sidecar.ps1'

function Get-RequiredFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Description,
        [ValidateSet('Leaf', 'Container')][string]$PathType = 'Leaf'
    )

    if (-not (Test-Path -LiteralPath $Path -PathType $PathType)) {
        throw "$Description not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ManifestSha1 {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes -contains 0) {
        return ([BitConverter]::ToString(([Security.Cryptography.SHA1]::Create().ComputeHash($bytes)))).Replace('-', '').ToLowerInvariant()
    }
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    $normalized = [regex]::Replace($text, "\r\n?|\n", "`r`n")
    $normalizedBytes = [Text.Encoding]::UTF8.GetBytes($normalized)
    return ([BitConverter]::ToString(([Security.Cryptography.SHA1]::Create().ComputeHash($normalizedBytes)))).Replace('-', '').ToLowerInvariant()
}

function Split-ManifestList {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return @() }
    return @($Value.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

function Read-ManifestConfig {
    param([Parameter(Mandatory)][string]$Path)

    $sections = [ordered]@{}
    $current = $null
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#') -or $trimmed.StartsWith(';')) { continue }
        if ($trimmed -match '^\[([^\]]+)\]$') {
            $current = $Matches[1].Trim()
            $sections[$current] = [ordered]@{}
            continue
        }
        if ($current -eq $null) { continue }
        if ($trimmed -match '^([^=]+)=(.*)$') {
            $sections[$current][$Matches[1].Trim()] = $Matches[2].Trim()
        }
    }
    return $sections
}

function Test-ManifestPathMatch {
    param(
        [Parameter(Mandatory)][string]$RepoRelativePath,
        [Parameter(Mandatory)][AllowEmptyCollection()][string[]]$Patterns
    )

    foreach ($pattern in $Patterns) {
        $normalized = $pattern.Trim().Trim('/').Replace('/', '\')
        $candidate = $RepoRelativePath.Replace('/', '\')
        $matchesPath = $candidate.Equals($normalized, [System.StringComparison]::OrdinalIgnoreCase) -or
            $candidate.StartsWith($normalized + '\', [System.StringComparison]::OrdinalIgnoreCase)
        if ($matchesPath) {
            return $true
        }
    }
    return $false
}

function Get-ManifestFiles {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Sections,
        [Parameter(Mandatory)][string]$RepositoryRoot
    )

    $selected = [System.Collections.Generic.List[object]]::new()
    foreach ($sectionName in $Sections.Keys) {
        if ($sectionName -eq 'sidecar') { continue }
        $section = $Sections[$sectionName]
        $sourceValue = [string]$section['path']
        $sourcePath = if ([string]::IsNullOrWhiteSpace($sourceValue) -or $sourceValue -eq '.') {
            $RepositoryRoot
        } else {
            Join-Path $RepositoryRoot $sourceValue
        }
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
            throw "Manifest section [$sectionName] source directory not found: $sourcePath"
        }

        $includeFiles = @(Split-ManifestList ([string]$section['include-files']))
        $includeDirectories = @(Split-ManifestList ([string]$section['include-directories']))
        $excludeFiles = @(Split-ManifestList ([string]$section['exclude-files']))
        $excludeDirectories = @(Split-ManifestList ([string]$section['exclude-directories']))
        foreach ($file in Get-ChildItem -LiteralPath $sourcePath -Recurse -File) {
            $repoRelative = [System.IO.Path]::GetRelativePath($RepositoryRoot, $file.FullName).Replace('\', '/')
            $name = $file.Name
            $includeFileMatches = @($includeFiles | Where-Object { $name -like $_ })
            $excludeFileMatches = @($excludeFiles | Where-Object { $name -like $_ })
            $includedDirectory = Test-ManifestPathMatch -RepoRelativePath $repoRelative -Patterns $includeDirectories
            $excludedDirectory = Test-ManifestPathMatch -RepoRelativePath $repoRelative -Patterns $excludeDirectories
            if ($includeFiles.Count -gt 0 -and $includeFileMatches.Count -eq 0) { continue }
            if ($includeDirectories.Count -gt 0 -and -not $includedDirectory) { continue }
            if ($excludeFiles.Count -gt 0 -and $excludeFileMatches.Count -gt 0) { continue }
            if ($excludeDirectories.Count -gt 0 -and $excludedDirectory) { continue }
            $relativeToSource = [System.IO.Path]::GetRelativePath($sourcePath, $file.FullName).Replace('\', '/')
            $destinationRelative = if ([string]::IsNullOrWhiteSpace($sourceValue) -or $sourceValue -eq '.') {
                $relativeToSource
            } else {
                ($sourceValue.TrimEnd('/', '\') + '/' + $relativeToSource)
            }
            [void]$selected.Add([pscustomobject]@{
                    Section = $sectionName
                    Source = $file.FullName
                    RelativePath = $destinationRelative
                })
        }
    }
    return $selected
}

function Assert-SafeZipEntries {
    param([Parameter(Mandatory)][string]$ArchivePath)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            if ([System.IO.Path]::IsPathRooted($name) -or $name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)') {
                throw "Runtime archive contains an unsafe path: $($entry.FullName)"
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

if ([string]::IsNullOrWhiteSpace($NodeExePath)) {
    throw 'Pass -NodeExePath or set AIPOB_NODE_EXE to a portable Node.js 24 node.exe.'
}
$resolvedNodePath = Get-RequiredFile -Path $NodeExePath -Description 'Node runtime'
if ([System.IO.Path]::GetFileName($resolvedNodePath) -ne 'node.exe') {
    throw "Node runtime must be a node.exe file; received $resolvedNodePath."
}

$nodeVersionText = (& $resolvedNodePath --version).TrimStart('v')
if ($LASTEXITCODE -ne 0) { throw "Unable to execute Node runtime: $resolvedNodePath" }
$nodeVersion = [System.Version]::Parse($nodeVersionText)
if ($nodeVersion -ne [System.Version]'24.20.0') { throw "Portable package requires Node.js 24.20.0; found $nodeVersion." }
$nodePlatform = (& $resolvedNodePath -p "process.platform + ':' + process.arch").Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to query Node runtime architecture: $resolvedNodePath" }
if ($nodePlatform -ne 'win32:x64') { throw "Portable package requires win32:x64 Node.js; found $nodePlatform." }
$nodeInfoJson = (& $resolvedNodePath -p "JSON.stringify({version:process.version,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})").Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to query Node runtime ABI: $resolvedNodePath" }
$nodeInfo = $nodeInfoJson | ConvertFrom-Json
if ([string]$nodeInfo.modules -ne '137') { throw "Portable package requires Node ABI 137; found $($nodeInfo.modules)." }

$resolvedManifestPath = if ([string]::IsNullOrWhiteSpace($ManifestConfigPath)) {
    Get-RequiredFile -Path (Join-Path $repositoryRoot 'manifest.cfg') -Description 'Manifest configuration'
} else {
    Get-RequiredFile -Path $ManifestConfigPath -Description 'Manifest configuration'
}
$resolvedRuntimeArchivePath = if ([string]::IsNullOrWhiteSpace($RuntimeArchivePath)) {
    Get-RequiredFile -Path (Join-Path $repositoryRoot 'runtime-win32.zip') -Description 'Windows runtime archive'
} else {
    Get-RequiredFile -Path $RuntimeArchivePath -Description 'Windows runtime archive'
}
Assert-SafeZipEntries -ArchivePath $resolvedRuntimeArchivePath
$resolvedCredentialHelperPath = if ([string]::IsNullOrWhiteSpace($CredentialHelperPath)) {
    Get-RequiredFile -Path (Join-Path $repositoryRoot 'native/wincred-helper/wincred-helper.exe') -Description 'WinCred helper'
} else {
    Get-RequiredFile -Path $CredentialHelperPath -Description 'WinCred helper'
}

$resolvedBundlePath = $null
if ([string]::IsNullOrWhiteSpace($SidecarBundlePath)) {
    if (-not $SkipBuild) {
        & $buildScript
        if ($LASTEXITCODE -ne 0) { throw "Sidecar build failed with exit code $LASTEXITCODE." }
    }
    $resolvedBundlePath = Get-RequiredFile -Path $releaseEntryPath -Description 'Sidecar release entry'
} else {
    $resolvedBundlePath = Get-RequiredFile -Path $SidecarBundlePath -Description 'Sidecar artifact'
}
$schemaSourcePath = Get-RequiredFile -Path (Join-Path $sidecarPath 'src/schemas.ts') -Description 'sidecar schema source'
$schemaSource = Get-Content -Raw -LiteralPath $schemaSourcePath
if ($schemaSource -notmatch 'SCHEMA_VERSION\s*=\s*(\d+)') { throw 'Unable to read SCHEMA_VERSION from sidecar/src/schemas.ts.' }
$schemaVersion = [int]$Matches[1]
if ($schemaSource -notmatch 'PROTOCOL_VERSION\s*=\s*(\d+)') { throw 'Unable to read PROTOCOL_VERSION from sidecar/src/schemas.ts.' }
$protocolVersion = [int]$Matches[1]
$releaseManifestPath = Get-RequiredFile -Path (Join-Path $repositoryRoot 'manifest.xml') -Description 'release manifest'
[xml]$releaseManifest = Get-Content -Raw -LiteralPath $releaseManifestPath
$manifestEntry = @($releaseManifest.PoBVersion.File | Where-Object { $_.part -eq 'sidecar' -and $_.name -eq 'sidecar/dist/server.cjs' })
if ($manifestEntry.Count -ne 1) { throw 'Release manifest must contain one sidecar/dist/server.cjs entry.' }
$bundleSha1 = Get-ManifestSha1 -Path $resolvedBundlePath
if ([string]$manifestEntry[0].sha1 -ne $bundleSha1) { throw 'Release manifest sidecar hash does not match the selected sidecar artifact.' }

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
if (Test-Path -LiteralPath $resolvedOutputPath) { throw "Output directory already exists: $resolvedOutputPath" }
if (Test-Path -LiteralPath $zipPath) { throw "Output archive already exists: $zipPath" }

$outputParent = Split-Path -Parent $resolvedOutputPath
[System.IO.Directory]::CreateDirectory($outputParent) | Out-Null
[System.IO.Directory]::CreateDirectory($resolvedOutputPath) | Out-Null

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($resolvedRuntimeArchivePath, $resolvedOutputPath)

$sections = Read-ManifestConfig -Path $resolvedManifestPath
$manifestFiles = Get-ManifestFiles -Sections $sections -RepositoryRoot $repositoryRoot
foreach ($manifestFile in $manifestFiles) {
    $destination = Join-Path $resolvedOutputPath $manifestFile.RelativePath
    $resolvedDestination = [System.IO.Path]::GetFullPath($destination)
    $outputPrefix = $resolvedOutputPath.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedDestination.StartsWith($outputPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Manifest selection escapes package staging: $($manifestFile.RelativePath)"
    }
    $destinationParent = Split-Path -Parent $destination
    [System.IO.Directory]::CreateDirectory($destinationParent) | Out-Null
    Copy-Item -LiteralPath $manifestFile.Source -Destination $destination -Force
}

$packageSidecarPath = Join-Path $resolvedOutputPath 'sidecar'
$packageDistPath = Join-Path $packageSidecarPath 'dist'
$packageRuntimePath = Join-Path $packageSidecarPath 'runtime'
$packageNodeModulesPath = Join-Path $packageSidecarPath 'node_modules'
[System.IO.Directory]::CreateDirectory($packageDistPath) | Out-Null
[System.IO.Directory]::CreateDirectory($packageRuntimePath) | Out-Null
[System.IO.Directory]::CreateDirectory($packageNodeModulesPath) | Out-Null
Copy-Item -LiteralPath $resolvedBundlePath -Destination (Join-Path $packageDistPath 'server.cjs') -Force
Copy-Item -LiteralPath $resolvedNodePath -Destination (Join-Path $packageRuntimePath 'node.exe') -Force
Copy-Item -LiteralPath $resolvedCredentialHelperPath -Destination (Join-Path $packageRuntimePath 'aipob-credential-helper.exe') -Force

$sqliteSourcePath = Get-RequiredFile -Path (Join-Path $sidecarPath 'node_modules/better-sqlite3') -Description 'better-sqlite3 package' -PathType Container
$sqlitePackagePath = Get-RequiredFile -Path (Join-Path $sqliteSourcePath 'package.json') -Description 'better-sqlite3 package metadata'
$sqliteLibPath = Get-RequiredFile -Path (Join-Path $sqliteSourcePath 'lib') -Description 'better-sqlite3 library' -PathType Container
$sqliteLicensePath = Get-RequiredFile -Path (Join-Path $sqliteSourcePath 'LICENSE') -Description 'better-sqlite3 license'
$sqlitePrebuildPath = Get-RequiredFile -Path (Join-Path $sqliteSourcePath 'prebuilds/win32-x64.node') -Description 'better-sqlite3 Windows native binding'
$packageSqlitePath = Join-Path $packageNodeModulesPath 'better-sqlite3'
$packageSqlitePrebuildsPath = Join-Path $packageSqlitePath 'prebuilds'
[System.IO.Directory]::CreateDirectory($packageSqlitePath) | Out-Null
[System.IO.Directory]::CreateDirectory($packageSqlitePrebuildsPath) | Out-Null
Copy-Item -LiteralPath $sqlitePackagePath -Destination $packageSqlitePath -Force
Copy-Item -LiteralPath $sqliteLicensePath -Destination $packageSqlitePath -Force
Copy-Item -LiteralPath $sqliteLibPath -Destination $packageSqlitePath -Recurse -Force
Copy-Item -LiteralPath $sqlitePrebuildPath -Destination $packageSqlitePrebuildsPath -Force

$packagedNodePath = Join-Path $packageRuntimePath 'node.exe'
Push-Location -LiteralPath $packageSidecarPath
try {
    & $packagedNodePath -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close();"
    if ($LASTEXITCODE -ne 0) { throw "Packaged better-sqlite3 failed to load with exit code $LASTEXITCODE." }
}
finally { Pop-Location }

foreach ($documentationFile in @('README.md', 'README-AIPOB.md', 'manifest.xml')) {
    $source = Join-Path $repositoryRoot $documentationFile
    if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination $resolvedOutputPath -Force }
}
Copy-Item -LiteralPath $resolvedManifestPath -Destination (Join-Path $resolvedOutputPath 'manifest.cfg') -Force

$sqlitePackage = Get-Content -Raw -LiteralPath $sqlitePackagePath | ConvertFrom-Json
$metadata = [ordered]@{
    formatVersion = 1
    product = 'AIPathOfBuilding'
    packageKind = 'windows-portable'
    platform = 'win32'
    arch = 'x64'
    node = [ordered]@{
        version = [string]$nodeInfo.version
        major = [int]$nodeVersion.Major
        modules = [string]$nodeInfo.modules
        napi = [string]$nodeInfo.napi
        platform = [string]$nodeInfo.platform
        arch = [string]$nodeInfo.arch
        sha256 = Get-Sha256 -Path $packagedNodePath
    }
    sidecar = [ordered]@{
        bundle = 'sidecar/dist/server.cjs'
        sha256 = Get-Sha256 -Path (Join-Path $packageDistPath 'server.cjs')
        protocolVersion = $protocolVersion
        schemaVersion = $schemaVersion
    }
    native = [ordered]@{
        credentialHelper = [ordered]@{
            path = 'sidecar/runtime/aipob-credential-helper.exe'
            sha256 = Get-Sha256 -Path (Join-Path $packageRuntimePath 'aipob-credential-helper.exe')
        }
        packages = @([ordered]@{
                name = 'better-sqlite3'
                version = [string]$sqlitePackage.version
                nativeBinding = 'sidecar/node_modules/better-sqlite3/prebuilds/win32-x64.node'
                nativeSha256 = Get-Sha256 -Path (Join-Path $packageSqlitePrebuildsPath 'win32-x64.node')
            })
    }
    inputs = [ordered]@{
        runtimeArchive = [ordered]@{ path = 'runtime-win32.zip'; sha256 = Get-Sha256 -Path $resolvedRuntimeArchivePath }
        manifestConfig = [ordered]@{ path = 'manifest.cfg'; sha256 = Get-Sha256 -Path $resolvedManifestPath }
        manifestXml = [ordered]@{ path = 'manifest.xml'; sha256 = Get-Sha256 -Path $releaseManifestPath }
        lockfile = [ordered]@{ path = 'sidecar/pnpm-lock.yaml'; sha256 = Get-Sha256 -Path (Get-RequiredFile -Path (Join-Path $sidecarPath 'pnpm-lock.yaml') -Description 'sidecar lockfile') }
    }
    manifestSelectedFiles = @($manifestFiles | ForEach-Object { [string]$_.RelativePath } | Sort-Object -Unique)
}
$metadataPath = Join-Path $resolvedOutputPath 'aipob-package.json'
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))

$checksums = Get-ChildItem -LiteralPath $resolvedOutputPath -File -Recurse |
    Where-Object { $_.Name -ne 'SHA256SUMS.txt' } |
    Sort-Object FullName |
    ForEach-Object {
        $relativePath = [System.IO.Path]::GetRelativePath($resolvedOutputPath, $_.FullName).Replace('\', '/')
        "$(Get-Sha256 -Path $_.FullName)  $relativePath"
    }
$checksumPath = Join-Path $resolvedOutputPath 'SHA256SUMS.txt'
[System.IO.File]::WriteAllLines($checksumPath, $checksums, [System.Text.UTF8Encoding]::new($false))

[System.IO.Compression.ZipFile]::CreateFromDirectory($resolvedOutputPath, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Write-Host "Packaged Node.js $nodeVersion and full PoB runtime: $zipPath"
