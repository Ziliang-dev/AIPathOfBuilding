Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourcePath = Join-Path $PSScriptRoot 'wincred_helper.cpp'
$outputPath = Join-Path $PSScriptRoot 'wincred-helper.exe'
$compiler = Get-Command cl.exe -ErrorAction SilentlyContinue
if ($null -eq $compiler) {
    throw 'MSVC cl.exe not found. Run from a Visual Studio Developer PowerShell.'
}

& $compiler.Source /nologo /O2 /EHsc /W4 /std:c++17 /DUNICODE /D_UNICODE /Fe:$outputPath $sourcePath advapi32.lib
if ($LASTEXITCODE -ne 0) {
    throw "WinCred helper build failed with exit code $LASTEXITCODE"
}
Write-Output $outputPath
