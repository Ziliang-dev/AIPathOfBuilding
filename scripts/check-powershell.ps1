[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptFiles = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File
$parseFailures = [System.Collections.Generic.List[string]]::new()
foreach ($scriptFile in $scriptFiles) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $scriptFile.FullName,
        [ref]$tokens,
        [ref]$errors
    )
    foreach ($parseError in $errors) {
        $parseFailures.Add("$($scriptFile.Name): $($parseError.Message)")
    }
}

if ($parseFailures.Count -gt 0) {
    throw "PowerShell parser failures:`n$($parseFailures -join "`n")"
}

Write-Host "PowerShell parser accepted $($scriptFiles.Count) scripts."
