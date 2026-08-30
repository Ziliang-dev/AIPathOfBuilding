"""Packaged Windows JSON-RPC and real PoB-process E2E harness."""

from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
from typing import Any, TextIO

from windows_package import PackageRoot, POB_EXECUTABLE_NAMES, remove_tree, safe_package_path, verify_package_root


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
    if (message.job.payload.operation === 'mechanic_experiment') {
      const experiment = message.job.payload.mechanicExperiment;
      const observation = {
        context: experiment.context,
        fingerprint: 'sha256:' + '1'.repeat(64),
        projectionFingerprint: 'sha256:' + '2'.repeat(64),
        nativeProbeFingerprint: 'sha256:' + '3'.repeat(64),
        evidenceFingerprint: 'sha256:' + '4'.repeat(64),
        metrics: { combinedDps: 1000000, effectiveHitPool: 50000, worstCaseMaxHit: 20000 },
        skills: [], conditions: [], activeItemIds: [], activeModifierIds: [], activePassiveIds: [],
        configValues: {}, resources: {}, cooldowns: {}, durations: {},
        contributions: { combinedDps: 1000000, effectiveHitPool: 50000, worstCaseMaxHit: 20000 },
      };
      socket.write(JSON.stringify({ type: 'result', jobId: message.job.id, result: {
        jobId: message.job.id, candidateId: message.job.candidateId, operation: 'mechanic_experiment',
        mechanicExperimentResult: {
          experimentId: experiment.id, ...(experiment.claimId ? { claimId: experiment.claimId } : {}),
          context: experiment.context, baseline: observation, diagnostic: observation,
        },
      } }) + '\n');
      continue;
    }
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


MECHANIC_SOURCE_IDS = [
    "weaponSet1:item:e2e:explicit:1:parsed:1",
    "weaponSet2:item:e2e:explicit:1:parsed:1",
]


class FixtureProvider:
    """Loopback OpenAI-compatible tool caller used only by packaged E2E."""

    def __init__(self) -> None:
        self._sequence = 0
        self._lock = threading.Lock()
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length <= 0 or length > 4 * 1024 * 1024:
                        raise ValueError("invalid fixture request length")
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                    response = provider._completion(payload)
                    encoded = json.dumps(response, separators=(",", ":")).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)
                except Exception as error:  # pragma: no cover - surfaced by E2E failure
                    encoded = json.dumps({"error": {"message": str(error)}}).encode("utf-8")
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                    self.end_headers()
                    self.wfile.write(encoded)

            def log_message(self, _format: str, *args: Any) -> None:
                del args

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, name="aipob-e2e-provider", daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/v1"

    def start(self) -> None:
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def _next_id(self) -> str:
        with self._lock:
            self._sequence += 1
            return f"e2e-tool-{self._sequence}"

    @staticmethod
    def _tool_names(payload: dict[str, Any]) -> list[str]:
        result: list[str] = []
        for tool in payload.get("tools", []):
            if not isinstance(tool, dict):
                continue
            function = tool.get("function")
            if isinstance(function, dict) and isinstance(function.get("name"), str):
                result.append(function["name"])
            elif isinstance(tool.get("name"), str):
                result.append(tool["name"])
        return result

    def _completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        names = self._tool_names(payload)
        messages = payload.get("messages", [])
        message_text = "\n".join(
            str(message.get("content", ""))
            for message in messages
            if isinstance(message, dict)
        )
        tool_name: str | None = None
        arguments: dict[str, Any] | None = None
        content = "E2E Provider supplied read-only guidance from verified fixture tools."
        if "aipob_connection_probe" in names:
            tool_name, arguments = "aipob_connection_probe", {"ok": True}
        elif "submit_mechanic_claims" in names:
            if '"phase":"critic"' in message_text:
                tool_name, arguments = "submit_mechanic_review", {
                    "verdict": "complete",
                    "missingEntityIds": [],
                    "conflictingClaimIds": [],
                    "invalidProofIds": [],
                    "summary": "E2E fixture claims have exact local PoB provenance.",
                }
            elif any(isinstance(message, dict) and message.get("role") == "tool" for message in messages):
                tool_name, arguments = "submit_mechanic_claims", {
                    "claims": [
                        {
                            "sourceId": source_id,
                            "relation": "grants",
                            "targetId": source_id.rsplit(":explicit:1:parsed:1", 1)[0],
                            "context": context,
                            "statement": "Inactive diagnostic fixture modifier belongs to its inventory item.",
                            "evidenceIds": [source_id],
                        }
                        for source_id, context in zip(MECHANIC_SOURCE_IDS, ("weaponSet1", "weaponSet2"), strict=True)
                    ],
                    "complete": True,
                }
            else:
                tool_name, arguments = "inspect_mechanic_entity", {"entityIds": MECHANIC_SOURCE_IDS}

        tool_calls = [] if tool_name is None else [{
            "id": self._next_id(),
            "type": "function",
            "function": {"name": tool_name, "arguments": json.dumps(arguments, separators=(",", ":"))},
        }]
        return {
            "id": f"chatcmpl-{self._next_id()}",
            "object": "chat.completion",
            "created": 0,
            "model": "aipob-e2e-fixture",
            "choices": [{
                "index": 0,
                "finish_reason": "tool_calls" if tool_calls else "stop",
                "message": {"role": "assistant", "content": "" if tool_calls else content, "tool_calls": tool_calls},
            }],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }


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
    projection_fingerprint = "sha256:" + ("0" * 64)
    required_catalogs = [
        {
            "id": "pob:skills", "domain": "skills", "kind": "currentBuild", "available": True,
            "data": {"currentGroupsTruncated": False, "nativeLinkProbe": {"complete": True, "truncated": False, "groups": []}},
        },
        {"id": "pob:items", "domain": "gear", "kind": "currentBuild", "available": True, "data": {"truncated": False}},
        {"id": "pob:tree", "domain": "tree", "kind": "currentBuild", "available": True, "data": {"allocated": [], "allocatedTruncated": False}},
        {
            "id": "pob:actors", "domain": "actor", "kind": "currentBuild", "available": True,
            "data": {"actorSeason": {"actors": [], "season": {}, "truncated": False}},
        },
        {
            "id": "pob:config", "domain": "config", "kind": "currentBuild", "available": True,
            "data": {"conditionClaims": [], "valuesTruncated": False, "conditionClaimsTruncated": False},
        },
        {
            "id": "pob:loadouts", "domain": "progression", "kind": "currentBuild", "available": True,
            "data": {
                "itemSetIds": [1], "activeItemSetId": 1,
                "treeSpecIds": [1], "activeTreeSpecId": 1,
                "skillSetIds": [1], "activeSkillSetId": 1, "truncated": False,
            },
        },
    ]
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
        "mechanicProjection": {
            "version": 1,
            "inventory": {"version": 1, "sections": ["explicit"], "lineFlags": [], "sourceFamilies": []},
            "items": [{
                "id": "e2e", "name": "E2E inactive inventory item", "equipped": False, "active": False,
                "references": [], "state": {}, "legality": {"version": 1, "status": "valid", "findings": []},
                "modifierLines": [{
                    "id": "item:e2e:explicit:1", "section": "explicit", "ordinal": 1,
                    "rawText": "1% increased E2E fixture value", "active": False, "disabled": False,
                    "flags": [], "modTags": [], "parseStatus": "parsed",
                    "provenance": {
                        "sourceFamily": "explicit", "sourceTable": "e2e", "sourceModId": "E2EFixture",
                        "resolution": "exact", "evidence": ["e2e:fixture"],
                    },
                    "parsedMods": [{
                        "name": "E2EFixture", "type": "INC", "classification": "numeric",
                        "value": 1, "flags": 0, "keywordFlags": 0, "tags": [],
                    }],
                }],
            }],
            "modifierCount": 1,
            "activeModifierCount": 0,
            "unresolvedModifierCount": 0,
            "descriptions": {"entries": [], "truncated": False},
            "fingerprint": projection_fingerprint,
        },
        "mechanicProjectionFingerprint": projection_fingerprint,
        "contentCatalog": [*required_catalogs, {
            "id": "config:e2e",
            "domain": "gear",
            "kind": "proposal",
            "available": True,
            "data": {
                "source": "currentBuild",
                "action": {
                    "id": "action:e2e",
                    "kind": "setIdentity",
                    "description": "E2E fixture action",
                    "dependsOn": [],
                    "preconditions": [],
                    "reversible": True,
                    "payload": {
                        "property": "level",
                        "value": 91,
                        "metricDeltas": {"combinedDps": 100},
                        "peakMetricDeltas": {"combinedDps": 500},
                    },
                },
            },
        }],
    }


def configure_fixture_provider(rpc: RpcClient, base_url: str) -> None:
    settings = {
        "providerId": "openai",
        "baseUrl": base_url,
        "model": "aipob-e2e-fixture",
        "authMode": "none",
        "apiMode": "chat_completions",
        "reasoningMode": "off",
    }
    preview = rpc.request("provider.test.preview", settings)
    tested = rpc.request("provider.test", {
        **settings,
        "consentKey": preview["consentKey"],
        "payloadHash": preview["payloadPreview"]["redactedHash"],
    })
    configured = rpc.request("provider.configure", {**settings, "testId": tested["testId"]})
    if not configured.get("configured"):
        fail("E2E fixture Provider was not configured.")
    consent = rpc.request("consent.preview", {
        "providerId": "openai",
        "dataCategories": [
            "objective", "build_snapshot", "metrics", "tool_outputs", "chat_messages",
            "mechanic_report", "mechanic_facts", "mechanic_experiment_results",
        ],
    })
    granted = rpc.request("consent.grant", {
        "providerId": "openai",
        "consentKey": consent["consentKey"],
        "payloadHash": consent["payloadPreview"]["redactedHash"],
    })
    if granted.get("decision") != "granted":
        fail("E2E fixture Provider consent was not granted.")


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
        credential_helper = safe_package_path(root, str(metadata["native"]["credentialHelper"]["path"]))
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
            "--credential-helper", str(credential_helper),
        ]
        if pob is None:
            arguments.extend(["--worker-command", json.dumps([str(node), str(fixture_path), "--"])])
        else:
            arguments.extend(["--pob-executable", str(pob), "--worker-script", str(worker)])

        provider = FixtureProvider()
        provider.start()
        sidecar = SidecarProcess(arguments, root / "sidecar", ready_path, rpc_timeout)
        rpc: RpcClient | None = None
        try:
            ready = sidecar.start()
            rpc = sidecar.connect(ready, protocol_version, token)
            hello = rpc.request("hello", {"clientName": "aipob-windows-e2e", "clientVersion": "1", "capabilities": []})
            if int(hello["protocolVersion"]) != protocol_version:
                fail("E2E hello protocol mismatch.")
            configure_fixture_provider(rpc, provider.base_url)
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
                sidecar.await_owner_exit()
            stderr = sidecar.stop()
            if stderr.strip():
                print(stderr, file=os.sys.stderr)
            provider.stop()
            remove_tree(data_directory)


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
