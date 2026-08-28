import { describe, expect, it } from "vitest";
import {
  InMemoryWorkerPool,
  PobWorkerPool,
  WorkerCancelledError,
  WorkerFrameTooLargeError,
  parseWorkerCommand,
  type PobWorkerEvaluatePayload,
  type WorkerEvaluation,
  type WorkerJob,
} from "../src/worker/index.js";

interface Payload { readonly value: number }

function job(id: string, runId = "run"): WorkerJob<Payload> {
  return { id, runId, candidateId: id, buildFingerprint: "build", scenarios: ["mapping"], payload: { value: Number(id) } };
}

describe("InMemoryWorkerPool", () => {
  it("uses stable lanes and returns batch results in input order", async () => {
    const lanes: number[] = [];
    const pool = new InMemoryWorkerPool<Payload, WorkerEvaluation>(2, async (entry, context) => {
      lanes.push(context.workerId);
      return {
        jobId: entry.id,
        candidateId: entry.candidateId,
        metricsByScenario: { mapping: { value: entry.payload.value } },
      };
    });
    const result = await pool.evaluateBatch([job("0"), job("1"), job("2"), job("3")]);
    expect(result.map((entry) => entry.candidateId)).toEqual(["0", "1", "2", "3"]);
    expect(lanes).toEqual([0, 1, 0, 1]);
    expect(pool.stats()).toMatchObject({ completed: 4, active: 0, queued: 0 });
    await pool.close();
  });

  it("cancels queued and active jobs by run", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pool = new InMemoryWorkerPool<Payload, WorkerEvaluation>(1, async (entry, context) => {
      await Promise.race([
        gate,
        new Promise<void>((_, reject) => context.signal.addEventListener("abort", () => reject(new WorkerCancelledError()), { once: true })),
      ]);
      return { jobId: entry.id, candidateId: entry.candidateId, metricsByScenario: { mapping: {} } };
    });
    const first = pool.evaluate(job("1", "cancel-me"));
    const second = pool.evaluate(job("2", "cancel-me"));
    pool.cancel("cancel-me");
    await expect(first).rejects.toBeInstanceOf(WorkerCancelledError);
    await expect(second).rejects.toBeInstanceOf(WorkerCancelledError);
    release?.();
    await pool.close();
  });
});

const workerScript = String.raw`
const net = require('node:net');
const argv = process.argv.slice(1);
const get = (name) => argv[argv.indexOf(name) + 1];
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
    const payload = message.job.payload;
    if (payload.xml === 'CRASH' && workerId === 0) process.exit(17);
    if (payload.xml === 'WAIT') continue;
    const valid = typeof payload.xml === 'string'
      && Array.isArray(payload.actions)
      && Array.isArray(payload.scenarios)
      && Array.isArray(payload.evidence)
      && Object.keys(payload).sort().join(',') === 'actions,evidence,scenarios,xml';
    if (payload.xml === 'SPLIT_UTF8') {
      const encoded = Buffer.from(JSON.stringify({
        type: 'result',
        jobId: message.job.id,
        result: {
          jobId: message.job.id,
          candidateId: message.job.candidateId,
          metricsByScenario: { mapping: { valid: 1 } },
          diagnostics: ['优化'],
        },
      }) + '\n');
      const splitAt = encoded.indexOf(Buffer.from('优化')) + 1;
      socket.write(encoded.subarray(0, splitAt));
      setTimeout(() => socket.write(encoded.subarray(splitAt)), 5);
      continue;
    }
    socket.write(JSON.stringify({
      type: 'result',
      jobId: message.job.id,
      result: {
        jobId: message.job.id,
        candidateId: message.job.candidateId,
        metricsByScenario: { mapping: { valid: valid ? 1 : 0, workerId } },
      },
    }) + '\n');
  }
});
`;

describe("PobWorkerPool", () => {
  it("parses only shell-free JSON argv", () => {
    expect(parseWorkerCommand('["pob.exe","worker.lua"]')).toEqual({ executable: "pob.exe", args: ["worker.lua"] });
    expect(() => parseWorkerCommand("pob.exe worker.lua")).toThrow(/JSON array/u);
  });

  it("spawns authenticated loopback workers and preserves the Lua evaluate contract", async () => {
    const pool = await PobWorkerPool.create<PobWorkerEvaluatePayload>({
      command: { executable: process.execPath, args: ["-e", workerScript, "--"] },
      workerCount: 2,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });
    const payload: PobWorkerEvaluatePayload = {
      xml: "<PathOfBuilding/>",
      actions: [],
      scenarios: [{
        id: "mapping",
        name: "Mapping",
        enemyIsBoss: "None",
        profile: "sustainable",
        mapModifiers: [],
        allowedEvents: ["onKill"],
        assumptions: {},
      }],
      evidence: [],
    };
    const jobs: WorkerJob<PobWorkerEvaluatePayload>[] = [0, 1, 2, 3].map((index) => ({
      id: `job-${index}`,
      runId: "run",
      candidateId: `candidate-${index}`,
      buildFingerprint: "build",
      scenarios: ["mapping"],
      payload,
    }));
    const results = await pool.evaluateBatch(jobs);
    expect(results.map((result) => result.metricsByScenario.mapping?.valid)).toEqual([1, 1, 1, 1]);
    expect(new Set(results.map((result) => result.metricsByScenario.mapping?.workerId))).toEqual(new Set([0, 1]));
    await pool.close();
  });

  it("retries one crashed evaluation on a different worker", async () => {
    const pool = await PobWorkerPool.create<PobWorkerEvaluatePayload>({
      command: { executable: process.execPath, args: ["-e", workerScript, "--"] },
      workerCount: 2,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });
    const result = await pool.evaluate({
      id: "crash-job",
      runId: "run",
      candidateId: "candidate",
      buildFingerprint: "build",
      scenarios: ["mapping"],
      payload: { xml: "CRASH", actions: [], scenarios: [], evidence: [] },
    });
    expect(result.metricsByScenario.mapping?.workerId).toBe(1);
    expect(pool.stats().completed).toBe(1);
    await pool.close();
  });

  it("preserves UTF-8 when a worker frame splits inside a multibyte codepoint", async () => {
    const pool = await PobWorkerPool.create<PobWorkerEvaluatePayload>({
      command: { executable: process.execPath, args: ["-e", workerScript, "--"] },
      workerCount: 1,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });
    const result = await pool.evaluate({
      id: "utf8-job",
      runId: "run",
      candidateId: "candidate",
      buildFingerprint: "build",
      scenarios: ["mapping"],
      payload: { xml: "SPLIT_UTF8", actions: [], scenarios: [], evidence: [] },
    });
    expect(result.diagnostics).toEqual(["优化"]);
    await pool.close();
  });

  it("aborts an active process evaluation", async () => {
    const pool = await PobWorkerPool.create<PobWorkerEvaluatePayload>({
      command: { executable: process.execPath, args: ["-e", workerScript, "--"] },
      workerCount: 1,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });
    const controller = new AbortController();
    const evaluation = pool.evaluate({
      id: "wait-job",
      runId: "run",
      candidateId: "candidate",
      buildFingerprint: "build",
      scenarios: ["mapping"],
      payload: { xml: "WAIT", actions: [], scenarios: [], evidence: [] },
    }, controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    controller.abort();
    await expect(evaluation).rejects.toBeInstanceOf(WorkerCancelledError);
    expect(pool.stats().cancelled).toBe(1);
    await pool.close();
  });

  it("rejects an oversized request before disturbing a worker lane", async () => {
    const pool = await PobWorkerPool.create<PobWorkerEvaluatePayload>({
      command: { executable: process.execPath, args: ["-e", workerScript, "--"] },
      workerCount: 1,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 1_000,
    });
    await expect(pool.evaluate({
      id: "oversized-job",
      runId: "run",
      candidateId: "candidate",
      buildFingerprint: "build",
      scenarios: ["mapping"],
      payload: { xml: "x".repeat(8 * 1024 * 1024), actions: [], scenarios: [], evidence: [] },
    })).rejects.toBeInstanceOf(WorkerFrameTooLargeError);
    const result = await pool.evaluate({
      id: "small-job",
      runId: "run",
      candidateId: "candidate",
      buildFingerprint: "build",
      scenarios: ["mapping"],
      payload: { xml: "<PathOfBuilding/>", actions: [], scenarios: [], evidence: [] },
    });
    expect(result.metricsByScenario.mapping?.valid).toBe(1);
    await pool.close();
  });

  it("aborts process pool startup without waiting for startup timeout", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const startup = PobWorkerPool.create<PobWorkerEvaluatePayload>({
      command: { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)", "--"] },
      workerCount: 1,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 500,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);
    await expect(startup).rejects.toBeInstanceOf(WorkerCancelledError);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
