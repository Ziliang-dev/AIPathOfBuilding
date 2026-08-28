import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { DefaultPlannerController } from "../src/plannerController.js";
import { MemoryPlannerStore } from "../src/storage/index.js";
import { InMemoryWorkerPool } from "../src/worker/index.js";

const objective = {
  schemaVersion: 1 as const,
  primaryScenario: "mapping" as const,
  scenarioWeights: { mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 },
  locks: { class: true, ascendancy: true, mainSkill: true, fields: [] },
  budgetDivine: 10,
  searchPreset: "deep" as const,
  goals: [{ metric: "FullDPS", direction: "maximize" as const, weight: 1 }],
  hardConstraints: [],
  candidateSources: { currentBuild: true, uniques: true, targetRares: true, trade: true },
};

describe("DefaultPlannerController", () => {
  it("fails closed on Trade and can cancel while worker startup is pending", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "pending-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    let releaseStartup!: () => void;
    const startup = new Promise<void>((resolve) => { releaseStartup = resolve; });
    const startupPool = new InMemoryWorkerPool(1, (job) => ({
      jobId: job.id,
      candidateId: job.candidateId,
      metricsByScenario: {},
    }));
    const closeStartupPool = vi.spyOn(startupPool, "close");
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: async () => {
        await startup;
        return startupPool;
      },
    });
    const notifications: unknown[] = [];
    const context = {
      requestId: "test",
      signal: new AbortController().signal,
      notify: (notification: unknown) => notifications.push(notification),
    };
    const started = planner.startRun({ snapshotFingerprint: "pending-build", objective }, context) as {
      runId: string;
      warnings?: string[];
    };
    expect(started.warnings?.[0]).toMatch(/External item search disabled/);
    expect(planner.cancelRun({ runId: started.runId })).toEqual({
      runId: started.runId,
      status: "cancelled",
    });
    await expect(planner.resumeRun({ runId: started.runId, mode: "checkpoint" }, context))
      .rejects.toThrow(/terminal/);
    releaseStartup();
    for (let attempt = 0; attempt < 100 && closeStartupPool.mock.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(closeStartupPool).toHaveBeenCalledOnce();
    expect(planner.hello({ clientName: "test", clientVersion: "1" })).toMatchObject({
      capabilities: { trade: false, providerConfigured: false },
    });
    await planner.close();
  });

  it("persists the live Pareto frontier when cancelled during search", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "cancel-search-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
      contentCatalog: [{
        id: "current:helmet",
        domain: "gear",
        kind: "proposal",
        available: true,
        data: {
          source: "currentBuild",
          metricsByScenario: {
            mapping: { FullDPS: 999 }, standardBoss: { FullDPS: 999 },
            pinnacle: { FullDPS: 999 }, uber: { FullDPS: 999 },
          },
          action: {
            id: "equip-current-helmet",
            kind: "replaceItem",
            description: "Equip current helmet fixture",
            payload: { slot: "Helmet", itemId: 1 },
          },
        },
      }],
    });
    let candidateWorkerCalls = 0;
    const pool = new InMemoryWorkerPool(1, (job) => {
      if (!job.candidateId.startsWith("baseline:")) candidateWorkerCalls += 1;
      return {
        jobId: job.id,
        candidateId: job.candidateId,
        metricsByScenario: Object.fromEntries(job.scenarios.map((scenario) => [
          scenario,
          { FullDPS: job.candidateId.startsWith("baseline:") ? 100 : 200 },
        ])),
      };
    });
    const closePool = vi.spyOn(pool, "close");
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: () => pool,
    });
    let cancellationSent = false;
    const started = planner.startRun({ snapshotFingerprint: "cancel-search-build", objective }, {
      requestId: "cancel-search",
      signal: new AbortController().signal,
      notify: (notification) => {
        if (!cancellationSent && notification.method === "run.progress" && notification.params.frontierSize > 0) {
          cancellationSent = true;
          planner.cancelRun({ runId: notification.params.runId });
        }
      },
    }) as { runId: string };
    for (let attempt = 0; attempt < 100 && store.getRun(started.runId)?.searchStopReason !== "cancelled"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(cancellationSent).toBe(true);
    expect(store.getRun(started.runId)).toMatchObject({
      status: "cancelled",
      searchStopReason: "cancelled",
    });
    expect(store.getRun(started.runId)?.frontier.length).toBeGreaterThan(0);
    expect(store.getRun(started.runId)?.evaluations).toBeGreaterThan(0);
    for (const metrics of Object.values(store.getRun(started.runId)?.frontier[0]?.peakScenarioMetrics ?? {})) {
      expect(metrics).toEqual({});
    }
    expect(candidateWorkerCalls).toBeGreaterThan(0);
    for (let attempt = 0; attempt < 100 && closePool.mock.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(closePool).toHaveBeenCalledOnce();
    await planner.close();
  });

  it("emits run.failed instead of run.completed when workflow search fails", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "failed-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: () => new InMemoryWorkerPool(1, () => {
        throw new Error("injected worker failure");
      }),
    });
    const notifications: { method?: string; params?: { error?: string } }[] = [];
    const started = planner.startRun({ snapshotFingerprint: "failed-build", objective }, {
      requestId: "failed",
      signal: new AbortController().signal,
      notify: (notification) => notifications.push(notification as typeof notifications[number]),
    }) as { runId: string };
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(notifications.find(({ method }) => method === "run.failed")?.params?.error)
      .toMatch(/injected worker failure/);
    expect(notifications.some(({ method }) => method === "run.completed")).toBe(false);
    const failedRun = store.getRun(started.runId);
    expect(failedRun).toMatchObject({ status: "failed", stopReason: "failed" });
    await planner.close();
  });

  it("persists startup failures and refuses to resume terminal runs", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "startup-failed-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: async () => { throw new Error("worker startup rejected"); },
    });
    const started = planner.startRun({ snapshotFingerprint: "startup-failed-build", objective }, {
      requestId: "startup-failed",
      signal: new AbortController().signal,
      notify: () => undefined,
    }) as { runId: string };
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(store.getRun(started.runId)).toMatchObject({
      status: "failed",
      stopReason: "failed",
      error: "worker startup rejected",
    });
    await expect(planner.resumeRun({ runId: started.runId, mode: "checkpoint" }, {
      requestId: "resume-terminal",
      signal: new AbortController().signal,
      notify: () => undefined,
    })).rejects.toThrow(/terminal/);
    await planner.close();
  });

  it("does not rewrite a completed run when a late cancel arrives", async () => {
    const store = new MemoryPlannerStore();
    const now = new Date().toISOString();
    store.saveRun({
      schemaVersion: 1,
      id: "completed-run",
      buildFingerprint: "completed-build",
      status: "completed",
      objective,
      scenarios: [],
      frontier: [],
      selected: [],
      evaluations: 4,
      modelCalls: 0,
      refinementRounds: 0,
      stopReason: "completed",
      startedAt: now,
      updatedAt: now,
    });
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: () => new InMemoryWorkerPool(1, () => {
        throw new Error("must not start a worker");
      }),
    });
    expect(() => planner.cancelRun({ runId: "completed-run" })).toThrow(/terminal/);
    expect(store.getRun("completed-run")).toMatchObject({ status: "completed", stopReason: "completed" });
    await expect(planner.recordTransactionResult({ result: {
      runId: "completed-run",
      candidateId: "already-applied",
      accepted: true,
      applied: true,
      rolledBack: false,
      fingerprint: "already-applied-fingerprint",
      metrics: {},
      scenarioMetrics: { mapping: {}, standardBoss: {}, pinnacle: {}, uber: {} },
    } }, {
      requestId: "transaction-replay",
      signal: new AbortController().signal,
      notify: () => undefined,
    })).resolves.toMatchObject({ status: "completed", replayed: true });
    expect(store.transactions).toHaveLength(0);
    await planner.close();
  });

  it("allows budgeted catalog-backed unique sources while Trade stays fail-closed", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "catalog-source-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
      contentCatalog: [{
        id: "unique:test",
        domain: "gear",
        kind: "proposal",
        available: true,
        data: {
          source: "unique",
          action: {
            id: "equip-unique",
            kind: "replaceItem",
            description: "Equip fixture unique",
            payload: { slot: "Helmet", itemId: 1 },
          },
        },
      }],
    });
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: () => new InMemoryWorkerPool(1, (job) => ({
        jobId: job.id,
        candidateId: job.candidateId,
        metricsByScenario: Object.fromEntries(job.scenarios.map((scenario) => [scenario, { FullDPS: 100 }])),
      })),
    });
    const started = planner.startRun({ snapshotFingerprint: "catalog-source-build", objective }, {
      requestId: "catalog-source",
      signal: new AbortController().signal,
      notify: () => undefined,
    }) as { runId: string };
    expect(store.getRun(started.runId)?.objective.candidateSources).toEqual({
      currentBuild: true,
      uniques: true,
      targetRares: false,
      trade: false,
    });
    planner.cancelRun({ runId: started.runId });
    await planner.close();
  });

  it("re-evaluates all sustainable scenarios in a fresh pool before Apply", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "apply-verify-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    let poolNumber = 0;
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: () => {
        poolNumber += 1;
        const fullDps = poolNumber === 1 ? 100 : 999;
        return new InMemoryWorkerPool(1, (job) => ({
          jobId: job.id,
          candidateId: job.candidateId,
          metricsByScenario: Object.fromEntries(job.scenarios.map((scenario) => [scenario, { FullDPS: fullDps }])),
        }));
      },
    });
    const notifications: Array<{ method: string }> = [];
    const context = {
      requestId: "apply-verify",
      signal: new AbortController().signal,
      notify: (notification: { method: string }) => notifications.push(notification),
    };
    const started = planner.startRun({ snapshotFingerprint: "apply-verify-build", objective }, context) as { runId: string };
    for (let attempt = 0; attempt < 100 && store.getRun(started.runId)?.selected.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const candidate = store.getRun(started.runId)?.selected[0];
    expect(candidate).toBeDefined();
    for (let attempt = 0; attempt < 100 && !notifications.some(({ method }) => method === "run.awaitingApproval"); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(notifications.some(({ method }) => method === "run.awaitingApproval")).toBe(true);
    expect(notifications.some(({ method }) => method === "run.completed")).toBe(false);
    await expect(planner.resumeRun({
      runId: started.runId,
      decision: "apply",
      candidateId: candidate!.id,
    }, context)).rejects.toThrow(/metric mismatch/);
    expect(poolNumber).toBe(2);
    expect(store.getRun(started.runId)?.status).toBe("paused");
    await planner.close();
  });

  it("aborts Apply verification with the request and emits no transaction", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "apply-timeout-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    let poolNumber = 0;
    let verificationStarted!: () => void;
    const startedVerification = new Promise<void>((resolve) => { verificationStarted = resolve; });
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: () => {
        poolNumber += 1;
        if (poolNumber === 1) {
          return new InMemoryWorkerPool(1, (job) => ({
            jobId: job.id,
            candidateId: job.candidateId,
            metricsByScenario: Object.fromEntries(job.scenarios.map((scenario) => [scenario, { FullDPS: 100 }])),
          }));
        }
        return new InMemoryWorkerPool(1, async (_job, workerContext) => {
          verificationStarted();
          await new Promise<void>((_resolve, reject) => workerContext.signal.addEventListener(
            "abort",
            () => reject(new Error("verification request aborted")),
            { once: true },
          ));
          throw new Error("unreachable");
        });
      },
    });
    const notifications: Array<{ method: string }> = [];
    const startContext = {
      requestId: "apply-timeout-start",
      signal: new AbortController().signal,
      notify: (notification: { method: string }) => notifications.push(notification),
    };
    const started = planner.startRun({ snapshotFingerprint: "apply-timeout-build", objective }, startContext) as { runId: string };
    for (let attempt = 0; attempt < 100 && store.getRun(started.runId)?.selected.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    const candidate = store.getRun(started.runId)?.selected[0];
    expect(candidate).toBeDefined();
    const request = new AbortController();
    const resume = planner.resumeRun({
      runId: started.runId,
      decision: "apply",
      candidateId: candidate!.id,
    }, {
      requestId: "apply-timeout-resume",
      signal: request.signal,
      notify: (notification: { method: string }) => notifications.push(notification),
    });
    await startedVerification;
    request.abort(new Error("request deadline"));
    await expect(resume).rejects.toThrow();
    expect(notifications.some(({ method }) => method === "transaction.apply")).toBe(false);
    expect(store.getRun(started.runId)?.status).toBe("paused");
    await planner.close();
  });

  it("aborts worker startup when a resumed request expires", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "resume-timeout-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    const now = new Date().toISOString();
    store.saveRun({
      schemaVersion: 1,
      id: "resume-timeout-run",
      buildFingerprint: "resume-timeout-build",
      status: "paused",
      objective,
      scenarios: [],
      frontier: [],
      selected: [],
      evaluations: 0,
      modelCalls: 0,
      refinementRounds: 0,
      startedAt: now,
      updatedAt: now,
    });
    let startupObserved!: () => void;
    const startupStarted = new Promise<void>((resolve) => { startupObserved = resolve; });
    let factorySignal: AbortSignal | undefined;
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: async (_snapshot, signal) => {
        factorySignal = signal;
        startupObserved();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    });
    const request = new AbortController();
    const resume = planner.resumeRun({ runId: "resume-timeout-run", mode: "checkpoint" }, {
      requestId: "resume-timeout",
      signal: request.signal,
      notify: () => undefined,
    });
    await startupStarted;
    request.abort(new Error("request deadline"));
    await expect(resume).rejects.toThrow(/request deadline/);
    expect(factorySignal?.aborted).toBe(true);
    expect(store.getRun("resume-timeout-run")?.status).toBe("paused");
    await planner.close();
  });

  it("serializes concurrent resume operations for one run", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "resume-concurrent-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    const now = new Date().toISOString();
    store.saveRun({
      schemaVersion: 1,
      id: "resume-concurrent-run",
      buildFingerprint: "resume-concurrent-build",
      status: "paused",
      objective,
      scenarios: [],
      frontier: [],
      selected: [],
      evaluations: 0,
      modelCalls: 0,
      refinementRounds: 0,
      startedAt: now,
      updatedAt: now,
    });
    let factoryCalls = 0;
    let startupObserved!: () => void;
    const startupStarted = new Promise<void>((resolve) => { startupObserved = resolve; });
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: async (_snapshot, signal) => {
        factoryCalls += 1;
        startupObserved();
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    });
    const context = {
      requestId: "resume-concurrent",
      signal: new AbortController().signal,
      notify: () => undefined,
    };
    const first = planner.resumeRun({ runId: "resume-concurrent-run", mode: "checkpoint" }, context);
    await startupStarted;
    await expect(planner.resumeRun({ runId: "resume-concurrent-run", mode: "checkpoint" }, context))
      .rejects.toThrow(/already in progress/);
    expect(factoryCalls).toBe(1);
    planner.cancelRun({ runId: "resume-concurrent-run" });
    await expect(first).rejects.toThrow(/cancelled/i);
    await planner.close();
  });

  it("awaits startup work and leaves a resumable paused run on controller shutdown", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "shutdown-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: async (_snapshot, signal) => {
        await new Promise<void>((_resolve, reject) => signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        ));
        throw new Error("unreachable");
      },
    });
    const started = planner.startRun({ snapshotFingerprint: "shutdown-build", objective }, {
      requestId: "shutdown",
      signal: new AbortController().signal,
      notify: () => undefined,
    }) as { runId: string };
    await planner.close();
    expect(store.getRun(started.runId)?.status).toBe("paused");
  });

  it("rejects resume activation after controller shutdown starts", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 1,
      xml: "<PathOfBuilding/>",
      fingerprint: "closed-resume-build",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    const now = new Date().toISOString();
    store.saveRun({
      schemaVersion: 1,
      id: "closed-resume-run",
      buildFingerprint: "closed-resume-build",
      status: "paused",
      objective,
      scenarios: [],
      frontier: [],
      selected: [],
      evaluations: 0,
      modelCalls: 0,
      refinementRounds: 0,
      startedAt: now,
      updatedAt: now,
    });
    const factory = vi.fn(() => new InMemoryWorkerPool(1, (job) => ({
      jobId: job.id,
      candidateId: job.candidateId,
      metricsByScenario: {},
    })));
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      workerPoolFactory: factory,
    });
    const closing = planner.close();
    await expect(planner.resumeRun({ runId: "closed-resume-run", mode: "checkpoint" }, {
      requestId: "closed-resume",
      signal: new AbortController().signal,
      notify: () => undefined,
    })).rejects.toThrow(/closed/);
    await closing;
    expect(factory).not.toHaveBeenCalled();
  });
});
