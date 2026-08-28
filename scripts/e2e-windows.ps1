[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PackagePath,
    [string]$PobExecutablePath,
    [string]$WorkerScriptPath,
    [ValidateSet('apply', 'reject', 'fail')][string]$TransactionMode = 'apply',
    [switch]$SkipPackageVerification,
    [switch]$RestartBeforeApply,
    [switch]$UsePackagedPob,
    [switch]$KeepExtracted
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$verifyScript = Join-Path $scriptRoot 'verify-package-windows.ps1'
$temporaryRoots = [System.Collections.Generic.List[string]]::new()
$script:rpcSequence = 0
$script:notifications = [System.Collections.Generic.List[object]]::new()
$dataDir = $null

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

function Assert-SafeZipEntries {
    param([Parameter(Mandatory)][string]$ArchivePath)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            if ([IO.Path]::IsPathRooted($name) -or $name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)') {
                throw "Package archive contains an unsafe path: $($entry.FullName)"
            }
        }
    }
    finally { $archive.Dispose() }
}

function Resolve-PackageRoot {
    param([Parameter(Mandatory)][string]$Path)
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    if (Test-Path -LiteralPath $resolved -PathType Container) { return $resolved }
    if ([IO.Path]::GetExtension($resolved).ToLowerInvariant() -ne '.zip') { throw "PackagePath must be a directory or .zip archive: $Path" }
    Assert-SafeZipEntries -ArchivePath $resolved
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("aipob-e2e-" + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($temporary) | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($resolved, $temporary)
    [void]$temporaryRoots.Add($temporary)
    return $temporary
}

function Read-RpcMessage {
    param([Parameter(Mandatory)][IO.StreamReader]$Reader)
    $line = $Reader.ReadLine()
    if ($null -eq $line) { throw 'RPC connection closed before the expected message.' }
    return ($line | ConvertFrom-Json)
}

function Get-RpcPropertyValue {
    param(
        [Parameter(Mandatory)]$Message,
        [Parameter(Mandatory)][string]$Name
    )
    $property = $Message.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Send-RpcRequest {
    param(
        [Parameter(Mandatory)][IO.StreamWriter]$Writer,
        [Parameter(Mandatory)][IO.StreamReader]$Reader,
        [Parameter(Mandatory)][int]$ProtocolVersion,
        [Parameter(Mandatory)][string]$Token,
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)]$Params
    )
    $script:rpcSequence++
    $id = "e2e:$($script:rpcSequence)"
    $request = [ordered]@{ jsonrpc = '2.0'; id = $id; method = $Method; params = $Params; sessionToken = $Token; protocolVersion = $ProtocolVersion }
    $Writer.WriteLine(($request | ConvertTo-Json -Compress -Depth 12))
    while ($true) {
        $message = Read-RpcMessage -Reader $Reader
        if ((Get-RpcPropertyValue -Message $message -Name 'id') -eq $id) {
            $rpcError = Get-RpcPropertyValue -Message $message -Name 'error'
            if ($null -ne $rpcError) { throw "RPC $Method failed: $($rpcError.message)" }
            return (Get-RpcPropertyValue -Message $message -Name 'result')
        }
        if ($null -ne (Get-RpcPropertyValue -Message $message -Name 'method')) { [void]$script:notifications.Add($message) }
    }
}

function Wait-RpcNotification {
    param(
        [Parameter(Mandatory)][IO.StreamReader]$Reader,
        [Parameter(Mandatory)][string]$Method
    )
    for ($index = 0; $index -lt $script:notifications.Count; $index++) {
        if ((Get-RpcPropertyValue -Message $script:notifications[$index] -Name 'method') -eq $Method) {
            $message = $script:notifications[$index]
            $script:notifications.RemoveAt($index)
            return (Get-RpcPropertyValue -Message $message -Name 'params')
        }
    }
    while ($true) {
        $message = Read-RpcMessage -Reader $Reader
        if ((Get-RpcPropertyValue -Message $message -Name 'method') -eq $Method) {
            return (Get-RpcPropertyValue -Message $message -Name 'params')
        }
        if ($null -ne (Get-RpcPropertyValue -Message $message -Name 'method')) { [void]$script:notifications.Add($message) }
    }
}

function Start-NodeProcess {
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
    return $process
}

$fixtureWorker = @'
const net = require('node:net');
const argv = process.argv.slice(1);
const get = name => argv[argv.indexOf(name) + 1];
const workerId = Number(get('--aipob-worker-id'));
const token = get('--aipob-worker-token');
const socket = net.connect(Number(get('--aipob-worker-port')), get('--aipob-worker-host'), () => socket.write(JSON.stringify({ type: 'hello', token, workerId }) + '\n'));
let buffer = '';
socket.on('data', chunk => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const frame = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1); if (!frame) continue;
    const message = JSON.parse(frame);
    if (message.type === 'shutdown') { socket.end(); process.exit(0); }
    if (message.type !== 'evaluate') continue;
    if (message.job.payload.operation === 'probe') {
      const nativeEvidenceByScenario = {};
      for (const scenario of message.job.payload.scenarios) nativeEvidenceByScenario[scenario.id + ':' + scenario.profile] = {
        schemaVersion: 1, complete: true, truncated: false, engineVersion: 'fixture', dataVersion: '3_29',
        claims: [], nativeUptime: {}, probeFingerprint: 'scenario:' + scenario.id + ':' + scenario.profile,
      };
      socket.write(JSON.stringify({ type: 'result', jobId: message.job.id, result: {
        jobId: message.job.id, candidateId: message.job.candidateId, operation: 'probe',
        candidateFingerprint: 'candidate:' + JSON.stringify(message.job.payload.actions),
        nativeProbeFingerprint: 'native-link:fixture', evidenceFingerprint: 'native-evidence:fixture',
        nativeLinkProbe: { schemaVersion: 1, complete: true, truncated: false, engineVersion: 'fixture', dataVersion: '3_29', groups: [], probeFingerprint: 'native-link:fixture' },
        nativeEvidence: { schemaVersion: 1, complete: true, truncated: false, engineVersion: 'fixture', dataVersion: '3_29', claims: [], nativeUptime: {}, probeFingerprint: 'native-evidence:fixture' },
        nativeEvidenceByScenario, diagnostics: [],
      } }) + '\n');
      continue;
    }
    const metricsByScenario = {};
    for (const scenario of message.job.payload.scenarios) {
      const metrics = { combinedDps: 1000000, effectiveHitPool: 50000, worstCaseMaxHit: 20000 };
      for (const action of message.job.payload.actions) for (const [metric, value] of Object.entries((scenario.profile === 'peak' ? (action.payload?.peakMetricDeltas || action.payload?.metricDeltas || {}) : (action.payload?.metricDeltas || {})))) metrics[metric] = (metrics[metric] || 0) + value;
      metricsByScenario[scenario.id] = metrics;
    }
    socket.write(JSON.stringify({ type: 'result', jobId: message.job.id, result: { jobId: message.job.id, candidateId: message.job.candidateId, metricsByScenario } }) + '\n');
  }
});
'@

try {
    if (-not $SkipPackageVerification) { & $verifyScript -PackagePath $PackagePath }
    $root = Resolve-PackageRoot -Path $PackagePath
    if ($UsePackagedPob) {
        if (-not [string]::IsNullOrWhiteSpace($PobExecutablePath) -or -not [string]::IsNullOrWhiteSpace($WorkerScriptPath)) {
            throw 'UsePackagedPob cannot be combined with explicit PoB worker paths.'
        }
        $pobNames = @('Path of Building.exe', 'Path{space}of{space}Building.exe', 'PathOfBuilding.exe')
        $PobExecutablePath = $pobNames | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
        if ([string]::IsNullOrWhiteSpace($PobExecutablePath)) { throw 'Packaged PoB executable was not found.' }
        $WorkerScriptPath = Join-Path $root 'src/AIPoBWorker.lua'
        if (-not (Test-Path -LiteralPath $WorkerScriptPath -PathType Leaf)) { throw 'Packaged AIPoB worker script was not found.' }
    }
    $metadata = Get-Content -Raw -LiteralPath (Join-Path $root 'aipob-package.json') | ConvertFrom-Json
    $protocolVersion = [int]$metadata.sidecar.protocolVersion
    $schemaVersion = [int]$metadata.sidecar.schemaVersion
    $nodePath = Join-Path $root 'sidecar/runtime/node.exe'
    $bundlePath = Join-Path $root ([string]$metadata.sidecar.bundle)
    $dataDir = Join-Path ([IO.Path]::GetTempPath()) ("aipob-e2e-data-" + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($dataDir) | Out-Null
    $readyPath = Join-Path $dataDir 'ready.json'
    $token = ('e2e-' + [guid]::NewGuid().ToString('N')).PadRight(40, 'x')
    $fixturePath = Join-Path $dataDir 'fixture-worker.js'
    [IO.File]::WriteAllText($fixturePath, $fixtureWorker, [Text.UTF8Encoding]::new($false))

    $arguments = [System.Collections.Generic.List[string]]::new()
    foreach ($argument in @($bundlePath, '--host', '127.0.0.1', '--port', '0', '--session-token', $token, '--data-dir', $dataDir, '--ready-file', $readyPath, '--worker-count', '2', '--owner-connect-timeout-ms', '30000')) { [void]$arguments.Add($argument) }
    if ([string]::IsNullOrWhiteSpace($PobExecutablePath)) {
        $workerCommand = @($nodePath, $fixturePath, '--') | ConvertTo-Json -Compress
        [void]$arguments.Add('--worker-command'); [void]$arguments.Add($workerCommand)
    } else {
        $worker = if ([string]::IsNullOrWhiteSpace($WorkerScriptPath)) { Join-Path $root 'src/AIPoBWorker.lua' } else { (Resolve-Path -LiteralPath $WorkerScriptPath -ErrorAction Stop).Path }
        [void]$arguments.Add('--pob-executable'); [void]$arguments.Add((Resolve-Path -LiteralPath $PobExecutablePath -ErrorAction Stop).Path)
        [void]$arguments.Add('--worker-script'); [void]$arguments.Add($worker)
    }
    $process = Start-NodeProcess -NodePath $nodePath -WorkingDirectory (Join-Path $root 'sidecar') -Arguments ([string[]]$arguments)
    try {
        $readyDeadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf) -and [DateTime]::UtcNow -lt $readyDeadline) {
            if ($process.HasExited) { throw "Sidecar exited before ready: $($process.StandardError.ReadToEnd())" }
            Start-Sleep -Milliseconds 50
        }
        if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) { throw 'E2E sidecar ready-file timeout.' }
        $ready = Get-Content -Raw -LiteralPath $readyPath | ConvertFrom-Json
        if ([int]$ready.protocolVersion -ne $protocolVersion -or $ready.host -ne '127.0.0.1') { throw 'E2E ready-file protocol or host mismatch.' }
        $client = [Net.Sockets.TcpClient]::new()
        $client.Connect('127.0.0.1', [int]$ready.port)
        $stream = $client.GetStream()
        $stream.ReadTimeout = 60000
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $false, 8192, $true)
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false), 8192, $true)
        $writer.AutoFlush = $true
        try {
            $hello = Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'hello' -Params @{ clientName = 'aipob-windows-e2e'; clientVersion = '1'; capabilities = @() }
            if ([int]$hello.protocolVersion -ne $protocolVersion) { throw 'E2E hello protocol mismatch.' }
            $snapshot = [ordered]@{
                schemaVersion = $schemaVersion
                xml = '<PathOfBuilding><Build level="90"/><Config/><Skills/><Items/><Tree/><Party/></PathOfBuilding>'
                fingerprint = 'e2e-build'
                engineVersion = 'e2e-engine'
                dataVersion = '3.29'
                ruleset = '3.29'
                metrics = @{ combinedDps = 1000000; effectiveHitPool = 50000; worstCaseMaxHit = 20000 }
                config = @{ enemyIsBoss = 'None' }
                buildState = @{ level = 90 }
                gameplayFieldPaths = @('Build', 'Build.@level', 'Config', 'Skills', 'Items', 'Tree', 'Party')
                contentCatalog = @(@{
                        id = 'config:e2e'; domain = 'gear'; kind = 'proposal'; available = $true
                        data = @{ source = 'currentBuild'; action = @{ id = 'action:e2e'; kind = 'replaceItem'; description = 'E2E fixture action'; dependsOn = @(); preconditions = @(); reversible = $true; payload = @{ slot = 'Helmet'; itemId = 1; metricDeltas = @{ combinedDps = 100 }; peakMetricDeltas = @{ combinedDps = 500 } } } }
                    })
            }
            [void](Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'build.capture' -Params @{ snapshot = $snapshot })
            $objective = @{ schemaVersion = $schemaVersion; primaryScenario = 'mapping'; scenarioWeights = @{ mapping = 0.55; standardBoss = 0.15; pinnacle = 0.15; uber = 0.15 }; locks = @{ class = $true; ascendancy = $true; mainSkill = $true; fields = @() }; searchPreset = 'deep'; goals = @(@{ metric = 'combinedDps'; direction = 'maximize'; weight = 1 }, @{ metric = 'effectiveHitPool'; direction = 'maximize'; weight = 0.8 }); hardConstraints = @(); candidateSources = @{ currentBuild = $true; uniques = $false; targetRares = $false; trade = $false } }
            $started = Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'run.start' -Params @{ snapshotFingerprint = 'e2e-build'; objective = $objective }
            $runId = [string]$started.runId
            $awaiting = Wait-RpcNotification -Reader $reader -Method 'run.awaitingApproval'
            $candidateId = [string]$awaiting.candidates[0].id
            $preview = Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'candidate.preview' -Params @{ runId = $runId; candidateId = $candidateId }
            if ([string]$preview.baseFingerprint -ne 'e2e-build') { throw 'E2E candidate fingerprint mismatch.' }
            if ($RestartBeforeApply -and $TransactionMode -ne 'reject') {
                $writer.Dispose(); $reader.Dispose(); $client.Dispose()
                if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'E2E sidecar did not stop before checkpoint restart.' }
                $script:notifications.Clear()
                $process = Start-NodeProcess -NodePath $nodePath -WorkingDirectory (Join-Path $root 'sidecar') -Arguments ([string[]]$arguments)
                $restartDeadline = [DateTime]::UtcNow.AddSeconds(30)
                while (-not (Test-Path -LiteralPath $readyPath -PathType Leaf) -and [DateTime]::UtcNow -lt $restartDeadline) {
                    if ($process.HasExited) { throw "Restarted sidecar exited before ready: $($process.StandardError.ReadToEnd())" }
                    Start-Sleep -Milliseconds 50
                }
                if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) { throw 'E2E checkpoint restart ready-file timeout.' }
                $restartReady = Get-Content -Raw -LiteralPath $readyPath | ConvertFrom-Json
                if ([int]$restartReady.protocolVersion -ne $protocolVersion -or $restartReady.host -ne '127.0.0.1') { throw 'E2E checkpoint restart protocol or host mismatch.' }
                $client = [Net.Sockets.TcpClient]::new(); $client.Connect('127.0.0.1', [int]$restartReady.port)
                $stream = $client.GetStream()
                $stream.ReadTimeout = 60000
                $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $false, 8192, $true)
                $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false), 8192, $true); $writer.AutoFlush = $true
                [void](Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'hello' -Params @{ clientName = 'aipob-windows-e2e-restart'; clientVersion = '1'; capabilities = @() })
                $streamed = Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'run.stream' -Params @{ runId = $runId }
                if ([string]$streamed.status -notin @('paused', 'running')) { throw "Checkpoint stream returned unexpected status: $($streamed.status)" }
                [void](Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'run.resume' -Params @{ runId = $runId; mode = 'checkpoint' })
                $awaiting = Wait-RpcNotification -Reader $reader -Method 'run.awaitingApproval'
                $candidateId = [string]$awaiting.candidates[0].id
                $preview = Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'candidate.preview' -Params @{ runId = $runId; candidateId = $candidateId }
            }
            if ($TransactionMode -eq 'reject') {
                $rejected = Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'run.resume' -Params @{ runId = $runId; decision = 'reject' }
                if ([string]$rejected.status -ne 'completed') { throw 'E2E reject did not complete the run.' }
            } else {
                [void](Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'run.resume' -Params @{ runId = $runId; decision = 'apply'; candidateId = $candidateId })
                [void](Wait-RpcNotification -Reader $reader -Method 'transaction.apply')
                $transactionError = if ($TransactionMode -eq 'fail') { 'E2E injected transaction failure' } else { $null }
                $result = [ordered]@{ runId = $runId; candidateId = $candidateId; accepted = $true; applied = ($TransactionMode -eq 'apply'); rolledBack = ($TransactionMode -eq 'fail'); error = $transactionError }
                if ($TransactionMode -eq 'apply') { $result.fingerprint = 'e2e-applied'; $result.metrics = $preview.metrics; $result.scenarioMetrics = $preview.scenarioMetrics }
                $transaction = Send-RpcRequest -Writer $writer -Reader $reader -ProtocolVersion $protocolVersion -Token $token -Method 'transaction.result' -Params @{ result = $result }
                if ($TransactionMode -eq 'apply' -and [string]$transaction.status -ne 'completed') { throw 'E2E applied transaction did not complete the run.' }
                if ($TransactionMode -eq 'fail' -and [string]$transaction.status -ne 'failed') { throw 'E2E injected transaction failure did not fail the run.' }
            }
            Write-Host "Windows E2E passed ($TransactionMode): run $runId"
        }
        finally {
            $writer.Dispose(); $reader.Dispose(); $client.Dispose()
        }
    }
    finally {
        if (-not $process.HasExited) { $process.Kill() }
        $process.WaitForExit(15000)
        $process.Dispose()
    }
}
finally {
    if ($null -ne $dataDir) { Remove-VerifiedTemporaryRoot -Path $dataDir -Prefix 'aipob-e2e-data-' }
    if (-not $KeepExtracted) { foreach ($temporary in $temporaryRoots) { Remove-VerifiedTemporaryRoot -Path $temporary -Prefix 'aipob-e2e-' } }
}
