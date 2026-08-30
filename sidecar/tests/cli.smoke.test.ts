import { EMPTY_PROJECTION_FINGERPRINT, emptyModifierProjection } from "./mechanicsFixture.js";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/schemas.js";

interface Message {
  id?: string;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: unknown;
}

const children = new Set<ChildProcess>();
const temporaryDirectories = new Set<string>();

const fixtureWorkerScript = String.raw`
const net = require('node:net');
const argv = process.argv.slice(1);
const get = name => argv[argv.indexOf(name) + 1];
const workerId = Number(get('--aipob-worker-id'));
const token = get('--aipob-worker-token');
const socket = net.connect(Number(get('--aipob-worker-port')), get('--aipob-worker-host'), () => {
  socket.write(JSON.stringify({ type: 'hello', token, workerId }) + '\n');
});
let buffer = '';
socket.on('data', chunk => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const frame = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!frame) continue;
    const message = JSON.parse(frame);
    if (message.type === 'shutdown') { socket.end(); process.exit(0); }
    if (message.type !== 'evaluate') continue;
    if (message.job.payload.operation === 'probe') {
      const nativeEvidenceByScenario = {};
      for (const scenario of message.job.payload.scenarios) {
        nativeEvidenceByScenario[scenario.id + ':' + scenario.profile] = {
          schemaVersion: 1, complete: true, truncated: false,
          engineVersion: 'fixture', dataVersion: '3_29', claims: [], nativeUptime: {},
          probeFingerprint: 'scenario-evidence:' + scenario.id + ':' + scenario.profile,
        };
      }
      socket.write(JSON.stringify({
        type: 'result', jobId: message.job.id, result: {
          jobId: message.job.id, candidateId: message.job.candidateId, operation: 'probe',
          candidateFingerprint: 'candidate:' + JSON.stringify(message.job.payload.actions),
          nativeProbeFingerprint: 'native-link:fixture', evidenceFingerprint: 'native-evidence:fixture',
          nativeLinkProbe: {
            schemaVersion: 1, complete: true, truncated: false, engineVersion: 'fixture',
            dataVersion: '3_29', groups: [], probeFingerprint: 'native-link:fixture',
          },
          nativeEvidence: {
            schemaVersion: 1, complete: true, truncated: false, engineVersion: 'fixture',
            dataVersion: '3_29', claims: [], nativeUptime: {}, probeFingerprint: 'native-evidence:fixture',
          },
          nativeEvidenceByScenario, diagnostics: [],
        },
      }) + '\n');
      continue;
    }
    const metricsByScenario = {};
    for (const scenario of message.job.payload.scenarios) {
      const metrics = { combinedDps: 1000000, effectiveHitPool: 50000, worstCaseMaxHit: 20000 };
      for (const action of message.job.payload.actions) {
        const payload = action.payload || {};
        const deltas = scenario.profile === 'peak'
          ? (payload.peakMetricDeltas || payload.metricDeltas || {})
          : (payload.metricDeltas || {});
        for (const [metric, value] of Object.entries(deltas)) metrics[metric] = (metrics[metric] || 0) + value;
      }
      metricsByScenario[scenario.id] = metrics;
    }
    socket.write(JSON.stringify({
      type: 'result',
      jobId: message.job.id,
      result: { jobId: message.job.id, candidateId: message.job.candidateId, metricsByScenario },
    }) + '\n');
  }
});
`;

afterEach(async () => {
  for (const child of children) if (child.exitCode === null) child.kill();
  children.clear();
  for (const path of temporaryDirectories) await rm(path, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe("packaged CLI", () => {
  it("self-terminates if its owner never connects", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aipob-sidecar-orphan-"));
    temporaryDirectories.add(directory);
    const readyFile = join(directory, "ready.json");
    const token = "orphan-session-token-".padEnd(40, "x");
    const child = spawn(process.execPath, [
      resolve("dist/server.cjs"),
      "--host", "127.0.0.1",
      "--port", "0",
      "--session-token", token,
      "--data-dir", directory,
      "--ready-file", readyFile,
      "--owner-connect-timeout-ms", "150",
    ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const errors: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));

    await pollReadyFile(readyFile, child, errors);
    await waitForExit(child, 10_000, errors);
    expect(child.exitCode).toBe(1);
    expect(Buffer.concat(errors).toString("utf8")).toContain("No owner connected");
    await expect(stat(readyFile)).rejects.toThrow();
  }, 15_000);

  it("runs capture/search/preview/reject and exits on owner disconnect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aipob-sidecar-smoke-"));
    temporaryDirectories.add(directory);
    const readyFile = join(directory, "ready.json");
    const token = "smoke-session-token-".padEnd(40, "x");
    const child = spawn(process.execPath, [
      resolve("dist/server.cjs"),
      "--host", "127.0.0.1",
      "--port", "0",
      "--session-token", token,
      "--data-dir", directory,
      "--ready-file", readyFile,
      "--worker-command", JSON.stringify([process.execPath, "-e", fixtureWorkerScript, "--"]),
    ], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const errors: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));

    const ready = await pollReadyFile(readyFile, child, errors);
    expect(ready).toMatchObject({ protocolVersion: PROTOCOL_VERSION, host: "127.0.0.1" });
    const client = await RpcTestClient.connect(ready.port, token);
    const hello = await client.request("hello", { client: "smoke", protocolVersion: PROTOCOL_VERSION });
    expect(hello).toMatchObject({ protocolVersion: PROTOCOL_VERSION });

    const snapshot = {
      schemaVersion: 3,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding><Build level=\"90\"/><Config/><Skills/><Items/><Tree/><Party/></PathOfBuilding>",
      fingerprint: "smoke-build",
      engineVersion: "smoke-engine",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { combinedDps: 1_000_000, effectiveHitPool: 50_000, worstCaseMaxHit: 20_000 },
      config: { enemyIsBoss: "None" },
      buildState: { level: 90 },
      gameplayFieldPaths: ["Build", "Build.@level", "Config", "Skills", "Items", "Tree", "Party"],
      contentCatalog: [{
        id: "config:condition-smoke",
        domain: "gear",
        kind: "proposal",
        available: true,
        data: {
          source: "currentBuild",
          action: {
            id: "action:condition-smoke",
            kind: "replaceItem",
            description: "Equip existing smoke fixture",
            dependsOn: [],
            preconditions: [],
            reversible: true,
            payload: {
              slot: "Helmet",
              itemId: 1,
              metricDeltas: { combinedDps: 100 },
              peakMetricDeltas: { combinedDps: 500 },
            },
          },
        },
      }],
    };
    await client.request("build.capture", { snapshot });
    const started = await client.request("run.start", {
      snapshotFingerprint: snapshot.fingerprint,
      objective: {
        schemaVersion: 3,
        primaryScenario: "mapping",
        scenarioWeights: { mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 },
        locks: { class: true, ascendancy: true, mainSkill: true, fields: [] },
        searchPreset: "deep",
        goals: [
          { metric: "combinedDps", direction: "maximize", weight: 1 },
          { metric: "effectiveHitPool", direction: "maximize", weight: 0.8 },
        ],
        hardConstraints: [],
        candidateSources: { currentBuild: true, uniques: false, targetRares: false, trade: false },
      },
    }) as { runId: string };
    const awaiting = await client.notification("run.awaitingApproval", 15_000) as {
      runId: string;
      candidates: Array<{ id: string }>;
    };
    expect(awaiting.runId).toBe(started.runId);
    expect(awaiting.candidates).toHaveLength(3);

    const preview = await client.request("candidate.preview", {
      runId: started.runId,
      candidateId: awaiting.candidates[0]!.id,
    }) as {
      baseFingerprint: string;
      scenarioMetrics: { mapping: { combinedDps: number } };
      peakScenarioMetrics: { mapping: { combinedDps: number } };
    };
    expect(preview.baseFingerprint).toBe(snapshot.fingerprint);
    expect(preview.peakScenarioMetrics.mapping.combinedDps)
      .toBeGreaterThan(preview.scenarioMetrics.mapping.combinedDps);
    const rejected = await client.request("run.resume", { runId: started.runId, decision: "reject" });
    expect(rejected).toMatchObject({ status: "completed" });

    client.close();
    await waitForExit(child, 10_000, errors);
    expect(child.exitCode).toBe(0);
    await expect(stat(readyFile)).rejects.toThrow();
  }, 30_000);
});

class RpcTestClient {
  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #notifications: Message[] = [];
  readonly #notificationWaiters = new Map<string, Array<(value: unknown) => void>>();
  #buffer = "";
  #sequence = 0;

  private constructor(private readonly socket: Socket, private readonly token: string) {
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
  }

  static async connect(port: number, token: string): Promise<RpcTestClient> {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolveConnect, reject) => {
      socket.once("connect", resolveConnect);
      socket.once("error", reject);
    });
    return new RpcTestClient(socket, token);
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = `smoke:${++this.#sequence}`;
    const promise = new Promise<unknown>((resolveRequest, reject) => {
      this.#pending.set(id, { resolve: resolveRequest, reject });
    });
    this.socket.write(`${JSON.stringify({
      jsonrpc: "2.0", id, method, params, protocolVersion: PROTOCOL_VERSION, sessionToken: this.token,
    })}\n`);
    return promise;
  }

  async notification(method: string, timeoutMs: number): Promise<unknown> {
    const queued = this.#notifications.findIndex((message) => message.method === method);
    if (queued >= 0) return this.#notifications.splice(queued, 1)[0]?.params;
    return await new Promise<unknown>((resolveNotification, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const wrapped = (value: unknown): void => { clearTimeout(timeout); resolveNotification(value); };
      const waiters = this.#notificationWaiters.get(method) ?? [];
      waiters.push(wrapped);
      this.#notificationWaiters.set(method, waiters);
    });
  }

  close(): void { this.socket.end(); }

  #onData(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const frame = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!frame) continue;
      const message = JSON.parse(frame) as Message;
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (pending !== undefined) {
          this.#pending.delete(message.id);
          if (message.error !== undefined) pending.reject(new Error(message.error.message ?? "RPC error"));
          else pending.resolve(message.result);
        }
      } else if (message.method !== undefined) {
        const waiters = this.#notificationWaiters.get(message.method);
        const waiter = waiters?.shift();
        if (waiter !== undefined) waiter(message.params);
        else this.#notifications.push(message);
      }
    }
  }
}

async function pollReadyFile(
  path: string,
  child: ChildProcess,
  errors: readonly Buffer[],
): Promise<{ port: number; protocolVersion: number; host: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CLI exited before ready: ${Buffer.concat(errors).toString("utf8")}`);
    try {
      return JSON.parse(await readFile(path, "utf8")) as { port: number; protocolVersion: number; host: string };
    } catch {
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error(`Ready file timeout: ${Buffer.concat(errors).toString("utf8")}`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number, errors: readonly Buffer[]): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<never>((_resolve, reject) => setTimeout(
      () => reject(new Error(`CLI exit timeout: ${Buffer.concat(errors).toString("utf8")}`)),
      timeoutMs,
    )),
  ]);
}
