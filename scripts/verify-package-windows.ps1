[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackagePath,
    [switch]$SkipLaunch,
    [switch]$KeepExtracted
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Remove-VerifiedTemporaryRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Prefix
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $resolved = [IO.Path]::GetFullPath($Path)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName($resolved).StartsWith($Prefix, [StringComparison]::Ordinal)) {
        throw "Refusing to remove unverified temporary root: $resolved"
    }
    Write-Host "Removing exact temporary root: $resolved"
    Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ManifestSha1 {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes -contains 0) {
        return ([BitConverter]::ToString(([Security.Cryptography.SHA1]::Create().ComputeHash($bytes)))).Replace('-', '').ToLowerInvariant()
    }
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    $normalized = [regex]::Replace($text, "\r\n?|\n", "`r`n")
    $normalizedBytes = [Text.Encoding]::UTF8.GetBytes($normalized)
    return ([BitConverter]::ToString(([Security.Cryptography.SHA1]::Create().ComputeHash($normalizedBytes)))).Replace('-', '').ToLowerInvariant()
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
                throw "Package archive contains an unsafe path: $($entry.FullName)"
            }
        }
    }
    finally { $archive.Dispose() }
}

function New-PackageRoot {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][System.Collections.Generic.List[string]]$TemporaryRoots
    )

    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if (Test-Path -LiteralPath $resolved -PathType Container) { return $resolved }
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf) -or [IO.Path]::GetExtension($resolved).ToLowerInvariant() -ne '.zip') {
        throw "PackagePath must be a directory or .zip archive: $Path"
    }
    Assert-SafeZipEntries -ArchivePath $resolved
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("aipob-package-" + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporary) | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($resolved, $temporary)
    [void]$TemporaryRoots.Add($temporary)
    return $temporary
}

function Assert-ChecksumFile {
    param([Parameter(Mandatory)][string]$Root)

    $checksumPath = Join-Path $Root 'SHA256SUMS.txt'
    if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) { throw "Package checksum file missing: $checksumPath" }
    $expected = @{}
    foreach ($line in Get-Content -LiteralPath $checksumPath) {
        if ($line -notmatch '^(?<hash>[0-9a-fA-F]{64})\s{2}(?<path>.+)$') { throw "Invalid checksum line: $line" }
        $relative = $Matches.path.Replace('\', '/')
        if ([IO.Path]::IsPathRooted($relative) -or $relative.StartsWith('/') -or $relative -match '(^|/)\.\.(/|$)') { throw "Unsafe checksum path: $relative" }
        if ($relative -eq 'SHA256SUMS.txt' -or $expected.ContainsKey($relative)) { throw "Duplicate or self checksum entry: $relative" }
        $expected[$relative] = $Matches.hash.ToLowerInvariant()
    }
    $actualFiles = @(Get-ChildItem -LiteralPath $Root -File -Recurse | Where-Object { $_.Name -ne 'SHA256SUMS.txt' })
    foreach ($file in $actualFiles) {
        $relative = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
        if (-not $expected.ContainsKey($relative)) { throw "File missing from SHA256SUMS.txt: $relative" }
        $actual = Get-Sha256 -Path $file.FullName
        if ($actual -ne $expected[$relative]) { throw "Checksum mismatch: $relative" }
    }
    if ($expected.Count -ne $actualFiles.Count) { throw "SHA256SUMS.txt contains entries for missing files." }
}

function Get-SafePackagePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$RelativePath
    )
    $normalized = $RelativePath.Replace('\', '/')
    if ([IO.Path]::IsPathRooted($normalized) -or $normalized.StartsWith('/') -or $normalized -match '(^|/)\.\.(/|$)') {
        throw "Package metadata contains an unsafe path: $RelativePath"
    }
    $candidate = [IO.Path]::GetFullPath((Join-Path $Root $normalized))
    $prefix = $Root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Package metadata escapes package root: $RelativePath" }
    return $candidate
}

function Invoke-PackagedNode {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $NodePath
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) { throw "Unable to start packaged Node runtime: $NodePath" }
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw "Packaged Node command timed out: $($Arguments -join ' ')" }
        $outText = $stdout.GetAwaiter().GetResult().Trim()
        $errText = $stderr.GetAwaiter().GetResult().Trim()
        if ($process.ExitCode -ne 0) { throw "Packaged Node command failed ($($process.ExitCode)): $errText" }
        return $outText
    }
    finally { $process.Dispose() }
}

function Assert-OwnerTimeout {
    param(
        [Parameter(Mandatory)][string]$NodePath,
        [Parameter(Mandatory)][string]$BundlePath,
        [Parameter(Mandatory)][string]$WorkingDirectory
    )

    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("aipob-owner-timeout-" + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporary) | Out-Null
    $ready = Join-Path $temporary 'ready.json'
    $token = ('verify-' + [guid]::NewGuid().ToString('N')).PadRight(40, 'x')
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $NodePath
    $start.WorkingDirectory = $WorkingDirectory
    $start.UseShellExecute = $false
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @(
            $BundlePath, '--host', '127.0.0.1', '--port', '0', '--session-token', $token,
            '--data-dir', $temporary, '--ready-file', $ready, '--owner-connect-timeout-ms', '250'
        )) { [void]$start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'Unable to start packaged sidecar for owner-timeout smoke.' }
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (-not (Test-Path -LiteralPath $ready -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
            if ($process.HasExited) { break }
            Start-Sleep -Milliseconds 50
        }
        if (-not (Test-Path -LiteralPath $ready -PathType Leaf)) {
            $errorText = $process.StandardError.ReadToEnd()
            if ($process.HasExited) { throw "Packaged sidecar exited before ready: $errorText" }
            throw 'Packaged sidecar did not publish a ready file.'
        }
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Packaged sidecar did not honor owner-connect timeout.' }
        if ($process.ExitCode -ne 1) { throw "Packaged sidecar owner-timeout exit code was $($process.ExitCode), expected 1." }
        if (Test-Path -LiteralPath $ready) { throw 'Packaged sidecar left its ready file after owner timeout.' }
    }
    finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.Dispose()
        Remove-VerifiedTemporaryRoot -Path $temporary -Prefix 'aipob-owner-timeout-'
    }
}

$temporaryRoots = [System.Collections.Generic.List[string]]::new()
try {
    $root = New-PackageRoot -Path $PackagePath -TemporaryRoots $temporaryRoots
    Assert-ChecksumFile -Root $root

    $metadataPath = Join-Path $root 'aipob-package.json'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) { throw "Package metadata missing: $metadataPath" }
    $metadata = Get-Content -Raw -LiteralPath $metadataPath | ConvertFrom-Json
    if ($metadata.formatVersion -ne 1 -or $metadata.product -ne 'AIPathOfBuilding' -or $metadata.packageKind -ne 'windows-portable') {
        throw 'Unsupported or invalid AIPoB package metadata.'
    }
    if ([int]$metadata.sidecar.protocolVersion -lt 1 -or [int]$metadata.sidecar.schemaVersion -lt 1) { throw 'Package metadata contains invalid protocol/schema versions.' }

    $bundlePath = Get-SafePackagePath -Root $root -RelativePath ([string]$metadata.sidecar.bundle)
    $nodePath = Join-Path $root 'sidecar/runtime/node.exe'
    $credentialHelperPath = Get-SafePackagePath -Root $root -RelativePath ([string]$metadata.native.credentialHelper.path)
    $nativePath = Get-SafePackagePath -Root $root -RelativePath ([string]$metadata.native.packages[0].nativeBinding)
    foreach ($required in @($bundlePath, $nodePath, $credentialHelperPath, $nativePath, (Join-Path $root 'src/AIPoBWorker.lua'), (Join-Path $root 'manifest.cfg'), (Join-Path $root 'manifest.xml'))) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required packaged file missing: $required" }
    }
    $pobExecutables = @(@('Path of Building.exe', 'Path{space}of{space}Building.exe', 'PathOfBuilding.exe') |
        ForEach-Object { Join-Path $root $_ } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
    if ($pobExecutables.Count -eq 0) { throw 'No packaged Path of Building executable was found.' }
    $bundleCount = @(Get-ChildItem -LiteralPath (Join-Path $root 'sidecar/dist') -Filter 'server.cjs' -File).Count
    if ($bundleCount -ne 1) { throw "Expected exactly one sidecar/dist/server.cjs; found $bundleCount." }
    if ((Get-Sha256 -Path $bundlePath) -ne [string]$metadata.sidecar.sha256) { throw 'Sidecar bundle metadata hash mismatch.' }
    if ((Get-Sha256 -Path $nodePath) -ne [string]$metadata.node.sha256) { throw 'Node runtime metadata hash mismatch.' }
    if ((Get-Sha256 -Path $nativePath) -ne [string]$metadata.native.packages[0].nativeSha256) { throw 'Native binding metadata hash mismatch.' }
    if ((Get-Sha256 -Path $credentialHelperPath) -ne [string]$metadata.native.credentialHelper.sha256) { throw 'WinCred helper metadata hash mismatch.' }
    if ((Get-Sha256 -Path (Join-Path $root 'manifest.cfg')) -ne [string]$metadata.inputs.manifestConfig.sha256) { throw 'Manifest configuration metadata hash mismatch.' }
    if ((Get-Sha256 -Path (Join-Path $root 'manifest.xml')) -ne [string]$metadata.inputs.manifestXml.sha256) { throw 'Release manifest metadata hash mismatch.' }
    [xml]$manifest = Get-Content -Raw -LiteralPath (Join-Path $root 'manifest.xml')
    $manifestEntry = @($manifest.PoBVersion.File | Where-Object { $_.part -eq 'sidecar' -and $_.name -eq 'sidecar/dist/server.cjs' })
    if ($manifestEntry.Count -ne 1) { throw 'Release manifest must contain one sidecar/dist/server.cjs entry.' }
    $bundleSha1 = Get-ManifestSha1 -Path $bundlePath
    if ([string]$manifestEntry[0].sha1 -ne $bundleSha1) { throw 'Release manifest sidecar hash does not match the packaged bundle.' }

    $nodeJson = Invoke-PackagedNode -NodePath $nodePath -WorkingDirectory (Split-Path -Parent $nodePath) -Arguments @('-p', 'JSON.stringify({version:process.version,modules:process.versions.modules,napi:process.versions.napi,platform:process.platform,arch:process.arch})')
    $node = $nodeJson | ConvertFrom-Json
    $nodeMatchesMetadata = $node.platform -eq 'win32' -and $node.arch -eq 'x64' -and
        ([Version]$node.version.TrimStart('v')) -eq [Version]'24.20.0' -and
        [string]$node.modules -eq '137' -and
        [string]$node.version -eq [string]$metadata.node.version -and
        [string]$node.modules -eq [string]$metadata.node.modules -and
        [string]$node.napi -eq [string]$metadata.node.napi
    if (-not $nodeMatchesMetadata) { throw "Packaged Node runtime does not match metadata: $nodeJson" }
    Invoke-PackagedNode -NodePath $nodePath -WorkingDirectory (Join-Path $root 'sidecar') -Arguments @('-e', "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.prepare('select 1').get(); db.close();") | Out-Null
    if (-not $SkipLaunch) { Assert-OwnerTimeout -NodePath $nodePath -BundlePath $bundlePath -WorkingDirectory (Join-Path $root 'sidecar') }

    Write-Host "Verified full Windows package: $root"
}
finally {
    if (-not $KeepExtracted) {
        foreach ($temporary in $temporaryRoots) { Remove-VerifiedTemporaryRoot -Path $temporary -Prefix 'aipob-package-' }
    }
}
