"""Packaged Windows JSON-RPC and real PoB-process E2E harness."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from typing import Any, TextIO

from windows_package import PackageRoot, POB_EXECUTABLE_NAMES, safe_package_path, verify_package_root


FIXTURE_WORKER = r"""
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
""".strip()


def fail(message: str) -> "NoReturn":
    raise RuntimeError(message)


class RpcClient:
    def __init__(self, connection: socket.socket, protocol_version: int, token: str):
        self.connection = connection
        self.protocol_version = protocol_version
        self.token = token
        self.reader: TextIO = connection.makefile("r", encoding="utf-8", newline="\n")
        self.writer: TextIO = connection.makefile("w", encoding="utf-8", newline="\n")
        self.sequence = 0
        self.notifications: list[dict[str, Any]] = []

    def read(self) -> dict[str, Any]:
        line = self.reader.readline()
        if line == "":
            fail("RPC connection closed before the expected message.")
        return json.loads(line)

    def request(self, method: str, params: dict[str, Any]) -> Any:
        self.sequence += 1
        request_id = f"e2e:{self.sequence}"
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
            "sessionToken": self.token,
            "protocolVersion": self.protocol_version,
        }
        self.writer.write(json.dumps(request, separators=(",", ":")) + "\n")
        self.writer.flush()
        while True:
            message = self.read()
            if message.get("id") == request_id:
                if message.get("error") is not None:
                    fail(f"RPC {method} failed: {message['error'].get('message', message['error'])}")
                return message.get("result")
            if message.get("method") is not None:
                self.notifications.append(message)

    def notification(self, method: str) -> dict[str, Any]:
        for index, message in enumerate(self.notifications):
            if message.get("method") == method:
                self.notifications.pop(index)
                return message.get("params", {})
            if message.get("method") == "run.failed":
                self.notifications.pop(index)
                fail(f"Packaged workflow failed: {message.get('params', {}).get('error', 'unknown error')}")
        while True:
            message = self.read()
            if message.get("method") == method:
                return message.get("params", {})
            if message.get("method") == "run.failed":
                fail(f"Packaged workflow failed: {message.get('params', {}).get('error', 'unknown error')}")
            if message.get("method") is not None:
                self.notifications.append(message)

    def close(self) -> None:
        for stream in (self.writer, self.reader):
            try:
                stream.close()
            except OSError:
                pass
        self.connection.close()


class SidecarProcess:
    def __init__(self, arguments: list[str], working_directory: Path, ready_path: Path, timeout: float):
        self.arguments = arguments
        self.working_directory = working_directory
        self.ready_path = ready_path
        self.timeout = timeout
        self.process: subprocess.Popen[str] | None = None

    def start(self) -> dict[str, Any]:
        self.process = subprocess.Popen(
            self.arguments,
            cwd=self.working_directory,
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        deadline = time.monotonic() + 30
        while not self.ready_path.is_file() and time.monotonic() < deadline:
            if self.process.poll() is not None:
                stderr = self.process.stderr.read() if self.process.stderr else ""
                fail(f"Sidecar exited before ready: {stderr}")
            time.sleep(0.05)
        if not self.ready_path.is_file():
            fail("E2E sidecar ready-file timeout.")
        return json.loads(self.ready_path.read_text(encoding="utf-8"))

    def connect(self, ready: dict[str, Any], protocol_version: int, token: str) -> RpcClient:
        if int(ready["protocolVersion"]) != protocol_version or ready["host"] != "127.0.0.1":
            fail("E2E ready-file protocol or host mismatch.")
        connection = socket.create_connection(("127.0.0.1", int(ready["port"])), timeout=30)
        connection.settimeout(self.timeout)
        return RpcClient(connection, protocol_version, token)

    def await_owner_exit(self) -> None:
        if self.process is None:
            return
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
            fail("E2E sidecar did not stop after owner disconnect.")

    def stop(self) -> str:
        if self.process is None:
            return ""
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=15)
        return self.process.stderr.read() if self.process.stderr else ""


def find_pob(root: Path) -> Path:
    for name in POB_EXECUTABLE_NAMES:
        candidate = root / name
        if candidate.is_file():
            return candidate
    fail("Packaged PoB executable was not found.")


def base_snapshot(schema_version: int) -> dict[str, Any]:
    return {
        "schemaVersion": schema_version,
        "xml": '<PathOfBuilding><Build level="90"/><Config/><Skills/><Items/><Tree/><Party/></PathOfBuilding>',
        "fingerprint": "e2e-build",
        "engineVersion": "e2e-engine",
        "dataVersion": "3.29",
        "ruleset": "3.29",
        "metrics": {"combinedDps": 1000000, "effectiveHitPool": 50000, "worstCaseMaxHit": 20000},
        "config": {"enemyIsBoss": "None"},
        "buildState": {"level": 90},
        "gameplayFieldPaths": ["Build", "Build.@level", "Config", "Skills", "Items", "Tree", "Party"],
        "contentCatalog": [{
            "id": "config:e2e",
            "domain": "gear",
            "kind": "proposal",
            "available": True,
            "data": {
                "source": "currentBuild",
                "action": {
                    "id": "action:e2e",
                    "kind": "replaceItem",
                    "description": "E2E fixture action",
                    "dependsOn": [],
                    "preconditions": [],
                    "reversible": True,
                    "payload": {
                        "slot": "Helmet",
                        "itemId": 1,
                        "metricDeltas": {"combinedDps": 100},
                        "peakMetricDeltas": {"combinedDps": 500},
                    },
                },
            },
        }],
    }


def objective(schema_version: int) -> dict[str, Any]:
    return {
        "schemaVersion": schema_version,
        "primaryScenario": "mapping",
        "scenarioWeights": {"mapping": 0.55, "standardBoss": 0.15, "pinnacle": 0.15, "uber": 0.15},
        "locks": {"class": True, "ascendancy": True, "mainSkill": True, "fields": []},
        "searchPreset": "deep",
        "goals": [
            {"metric": "combinedDps", "direction": "maximize", "weight": 1},
            {"metric": "effectiveHitPool", "direction": "maximize", "weight": 0.8},
        ],
        "hardConstraints": [],
        "candidateSources": {"currentBuild": True, "uniques": False, "targetRares": False, "trade": False},
    }


def e2e_windows(args: argparse.Namespace) -> None:
    package = Path(args.package)
    with PackageRoot(package, args.keep_extracted) as root:
        if not args.skip_package_verification:
            metadata = verify_package_root(root)
        else:
            metadata = json.loads((root / "aipob-package.json").read_text(encoding="utf-8"))
        protocol_version = int(metadata["sidecar"]["protocolVersion"])
        schema_version = int(metadata["sidecar"]["schemaVersion"])
        node = root / "sidecar" / "runtime" / "node.exe"
        bundle = safe_package_path(root, str(metadata["sidecar"]["bundle"]))
        use_packaged_pob = args.use_packaged_pob
        pob = find_pob(root) if use_packaged_pob else Path(args.pob_executable).resolve() if args.pob_executable else None
        worker = root / "src" / "AIPoBWorker.lua" if use_packaged_pob else Path(args.worker_script).resolve() if args.worker_script else root / "src" / "AIPoBWorker.lua"
        if use_packaged_pob and (args.pob_executable or args.worker_script):
            fail("--use-packaged-pob cannot be combined with explicit PoB worker paths.")
        if pob is not None and not worker.is_file():
            fail(f"PoB worker script not found: {worker}")

        data_directory = Path(tempfile.mkdtemp(prefix="aipob-e2e-data-"))
        fixture_path = data_directory / "fixture-worker.js"
        fixture_path.write_text(FIXTURE_WORKER, encoding="utf-8")
        ready_path = data_directory / "ready.json"
        token = ("e2e-" + os.urandom(16).hex()).ljust(40, "x")
        worker_count = "1" if use_packaged_pob else "2"
        rpc_timeout = 180 if use_packaged_pob else 60
        arguments = [
            str(node), str(bundle), "--host", "127.0.0.1", "--port", "0",
            "--session-token", token, "--data-dir", str(data_directory), "--ready-file", str(ready_path),
            "--worker-count", worker_count, "--owner-connect-timeout-ms", "30000",
        ]
        if pob is None:
            arguments.extend(["--worker-command", json.dumps([str(node), str(fixture_path), "--"])])
        else:
            arguments.extend(["--pob-executable", str(pob), "--worker-script", str(worker)])

        sidecar = SidecarProcess(arguments, root / "sidecar", ready_path, rpc_timeout)
        rpc: RpcClient | None = None
        try:
            ready = sidecar.start()
            rpc = sidecar.connect(ready, protocol_version, token)
            hello = rpc.request("hello", {"clientName": "aipob-windows-e2e", "clientVersion": "1", "capabilities": []})
            if int(hello["protocolVersion"]) != protocol_version:
                fail("E2E hello protocol mismatch.")
            rpc.request("build.capture", {"snapshot": base_snapshot(schema_version)})
            started = rpc.request("run.start", {"snapshotFingerprint": "e2e-build", "objective": objective(schema_version)})
            run_id = str(started["runId"])
            awaiting = rpc.notification("run.awaitingApproval")
            candidate_id = str(awaiting["candidates"][0]["id"])
            preview = rpc.request("candidate.preview", {"runId": run_id, "candidateId": candidate_id})
            if preview["baseFingerprint"] != "e2e-build":
                fail("E2E candidate fingerprint mismatch.")

            if args.restart_before_apply and args.transaction_mode != "reject":
                rpc.close()
                rpc = None
                sidecar.await_owner_exit()
                sidecar = SidecarProcess(arguments, root / "sidecar", ready_path, rpc_timeout)
                restart_ready = sidecar.start()
                rpc = sidecar.connect(restart_ready, protocol_version, token)
                rpc.request("hello", {"clientName": "aipob-windows-e2e-restart", "clientVersion": "1", "capabilities": []})
                streamed = rpc.request("run.stream", {"runId": run_id})
                if streamed["status"] not in ("paused", "running"):
                    fail(f"Checkpoint stream returned unexpected status: {streamed['status']}")
                resumed = rpc.request("run.resume", {"runId": run_id, "mode": "checkpoint"})
                if resumed["status"] not in ("paused", "running") or not resumed.get("candidates"):
                    fail(f"Checkpoint resume returned no approval Candidate: {resumed['status']}")
                candidate_id = str(resumed["candidates"][0]["id"])
                preview = rpc.request("candidate.preview", {"runId": run_id, "candidateId": candidate_id})

            if args.transaction_mode == "reject":
                rejected = rpc.request("run.resume", {"runId": run_id, "decision": "reject"})
                if rejected["status"] != "completed":
                    fail("E2E reject did not complete the run.")
            else:
                rpc.request("run.resume", {"runId": run_id, "decision": "apply", "candidateId": candidate_id})
                rpc.notification("transaction.apply")
                result: dict[str, Any] = {
                    "runId": run_id,
                    "candidateId": candidate_id,
                    "accepted": True,
                    "applied": args.transaction_mode == "apply",
                    "rolledBack": args.transaction_mode == "fail",
                }
                if args.transaction_mode == "apply":
                    result.update({
                        "fingerprint": "e2e-applied",
                        "metrics": preview["metrics"],
                        "scenarioMetrics": preview["scenarioMetrics"],
                    })
                else:
                    result["error"] = "E2E injected transaction failure"
                transaction = rpc.request("transaction.result", {"result": result})
                expected = "completed" if args.transaction_mode == "apply" else "failed"
                if transaction["status"] != expected:
                    fail(f"E2E transaction returned {transaction['status']}; expected {expected}.")
            print(f"Windows E2E passed ({args.transaction_mode}): run {run_id}")
        finally:
            if rpc is not None:
                rpc.close()
            stderr = sidecar.stop()
            if stderr.strip():
                print(stderr, file=os.sys.stderr)
            shutil.rmtree(data_directory)


def add_e2e_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    parser = subparsers.add_parser("e2e-windows")
    parser.add_argument("--package", required=True)
    parser.add_argument("--pob-executable")
    parser.add_argument("--worker-script")
    parser.add_argument("--transaction-mode", choices=("apply", "reject", "fail"), default="apply")
    parser.add_argument("--skip-package-verification", action="store_true")
    parser.add_argument("--restart-before-apply", action="store_true")
    parser.add_argument("--use-packaged-pob", action="store_true")
    parser.add_argument("--keep-extracted", action="store_true")
    parser.set_defaults(handler=e2e_windows)
