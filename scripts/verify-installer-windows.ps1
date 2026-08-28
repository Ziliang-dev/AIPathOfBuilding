[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InstallerPath,
    [Parameter(Mandatory)][string]$PackagePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$verifyPackage = Join-Path $PSScriptRoot 'verify-package-windows.ps1'
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$resolvedPackage = (Resolve-Path -LiteralPath $PackagePath -ErrorAction Stop).Path
if ([IO.Path]::GetExtension($resolvedInstaller).ToLowerInvariant() -ne '.exe') { throw 'InstallerPath must be an .exe file.' }
if ([IO.Path]::GetExtension($resolvedPackage).ToLowerInvariant() -ne '.zip') { throw 'PackagePath must be a .zip file.' }

& $verifyPackage -PackagePath $resolvedPackage
if ($LASTEXITCODE -ne 0) { throw "Canonical package verification failed with exit code $LASTEXITCODE." }

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('aipob-installer-verify-' + [guid]::NewGuid().ToString('N'))
$expectedRoot = Join-Path $temporaryRoot 'expected'
$installRoot = Join-Path $temporaryRoot 'installed'
[IO.Directory]::CreateDirectory($expectedRoot) | Out-Null
try {
    Expand-Archive -LiteralPath $resolvedPackage -DestinationPath $expectedRoot
    $process = Start-Process -FilePath $resolvedInstaller -ArgumentList @('/S', "/D=$installRoot") -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "Silent installer failed with exit code $($process.ExitCode)." }

    $expectedFiles = @(Get-ChildItem -LiteralPath $expectedRoot -File -Recurse)
    foreach ($expected in $expectedFiles) {
        $relative = [IO.Path]::GetRelativePath($expectedRoot, $expected.FullName)
        $installed = Join-Path $installRoot $relative
        if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { throw "Installer omitted canonical file: $relative" }
        $expectedHash = (Get-FileHash -LiteralPath $expected.FullName -Algorithm SHA256).Hash
        $installedHash = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
        if ($expectedHash -ne $installedHash) { throw "Installer changed canonical file: $relative" }
    }
    $allowed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($expected in $expectedFiles) { [void]$allowed.Add([IO.Path]::GetRelativePath($expectedRoot, $expected.FullName)) }
    [void]$allowed.Add('Uninstall.exe')
    foreach ($installed in Get-ChildItem -LiteralPath $installRoot -File -Recurse) {
        $relative = [IO.Path]::GetRelativePath($installRoot, $installed.FullName)
        if (-not $allowed.Contains($relative)) { throw "Installer added an unexpected payload file: $relative" }
    }

    $nodePath = Join-Path $installRoot 'sidecar/runtime/node.exe'
    $nodeVersion = (& $nodePath '--version').TrimStart('v').Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne '24.20.0') { throw "Installed Node runtime mismatch: $nodeVersion" }
    Write-Host "Installer verified against canonical staging: $resolvedInstaller"
}
finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolvedTemporary.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedTemporary).StartsWith('aipob-installer-verify-', [StringComparison]::Ordinal)) {
        Write-Host "Removing exact installer verification root: $resolvedTemporary"
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force -ErrorAction SilentlyContinue
    }
}
