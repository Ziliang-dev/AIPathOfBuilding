import { EMPTY_PROJECTION_FINGERPRINT, emptyModifierProjection } from "./mechanicsFixture.js";
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { DefaultPlannerController } from "../src/plannerController.js";
import { MemoryCredentialStore } from "../src/credentials/index.js";
import {
  ConsentManager,
  MemoryConsentRecordStore,
  MemoryProviderProfileStore,
  ProviderModelAdapterFactory,
  ProviderProfileService,
  CONNECTION_PROBE_TOOL_NAME,
} from "../src/provider/index.js";
import { MemoryPlannerStore } from "../src/storage/index.js";
import { InMemoryWorkerPool } from "../src/worker/index.js";
import type { BuildSnapshot, VerifiedBuildMechanicReport } from "../src/schemas.js";
import type { ModelAdapter } from "../src/llm/types.js";

const objective = {
  schemaVersion: 4 as const,
  primaryScenario: "mapping" as const,
  scenarioWeights: { mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 },
  locks: { class: true, ascendancy: true, mainSkill: true, fields: [] },
  budgetDivine: 10,
  searchPreset: "deep" as const,
  goals: [{ metric: "FullDPS", direction: "maximize" as const, weight: 1 }],
  hardConstraints: [],
  candidateSources: { currentBuild: true, uniques: true, targetRares: true, trade: true },
};

const TEST_HASH = `sha256:${"a".repeat(64)}`;

function verifiedMechanicReport(snapshot: BuildSnapshot): VerifiedBuildMechanicReport {
  return {
    schemaVersion: 4,
    status: "verified",
    snapshotFingerprint: snapshot.fingerprint,
    projectionFingerprint: snapshot.mechanicProjectionFingerprint,
    factBundleFingerprint: TEST_HASH,
    analysisFingerprint: TEST_HASH,
    cacheKey: TEST_HASH,
    contexts: ["weaponSet1", "weaponSet2"],
    claims: [], proofs: [], graph: { nodes: [], edges: [] }, coverage: [], findings: [], blockers: [],
    summary: "verified test mechanic report",
    llmSummary: "verified by injected test engine",
    modelCalls: 1, experimentCount: 0, repairRounds: 0,
    createdAt: new Date(0).toISOString(),
  };
}

function testRuntime() {
  const adapter: ModelAdapter<string> = {
    callsUsed: 0,
    callsRemaining: 16,
    complete: async () => ({ kind: "message", content: "verified test guidance", toolCalls: [] }),
  };
  return {
    modelAdapterFactory: {
      create: async <TName extends string>() => adapter as ModelAdapter<TName>,
    },
    mechanicEngineFactory: () => ({
      understand: async (snapshot: BuildSnapshot) => verifiedMechanicReport(snapshot),
    }),
  };
}

describe("DefaultPlannerController", () => {
  it("negotiates and consumes a one-shot connection-test authorization", async () => {
    const providerService = new ProviderProfileService({
      profiles: new MemoryProviderProfileStore(),
      credentials: new MemoryCredentialStore(),
      consent: new ConsentManager(new MemoryConsentRecordStore()),
      probeTransportFactory: () => ({
        create: async () => ({
          model: "resolved-model",
          choices: [{ message: { tool_calls: [{
            id: "probe", type: "function",
            function: { name: CONNECTION_PROBE_TOOL_NAME, arguments: '{"ok":true}' },
          }] } }],
        }),
      }),
    });
    const planner = new DefaultPlannerController({
      store: new MemoryPlannerStore(),
      checkpointer: new MemorySaver(),
      ...testRuntime(),
      providerService,
    });
    await expect(planner.hello({
      clientName: "test",
      clientVersion: "1",
      capabilities: ["providerConnectionTest", "providerCompatibility"],
    })).resolves.toMatchObject({ capabilities: { providerConnectionTest: true, providerCompatibility: true } });
    const preview = await planner.previewProviderTest({
      providerId: "openai", baseUrl: "https://provider.invalid/v1", model: "test-model",
      authMode: "bearer", apiMode: "auto", reasoningMode: "auto",
    }) as { consentKey: string; payloadPreview: { redactedHash: string } };
    const context = {
      requestId: "probe",
      signal: new AbortController().signal,
      notify: () => undefined,
    };
    const params = {
      providerId: "openai",
      baseUrl: "https://provider.invalid/v1",
      model: "test-model",
      authMode: "bearer" as const,
      apiMode: "auto" as const,
      reasoningMode: "auto" as const,
      apiKey: "ephemeral-secret",
      consentKey: preview.consentKey,
      payloadHash: preview.payloadPreview.redactedHash,
    };
    await expect(planner.testProviderConnection(params, context)).resolves.toMatchObject({
      ok: true, responseModel: "resolved-model", toolCallValidated: true,
    });
    await expect(planner.testProviderConnection(params, context)).rejects.toThrow(/missing or stale/);

    for (const stale of [
      { baseUrl: "https://other.invalid/v1" },
      { model: "other-model" },
      { payloadHash: `sha256:${"b".repeat(64)}` },
    ]) {
      const boundPreview = await planner.previewProviderTest({
        providerId: "openai", baseUrl: "https://provider.invalid/v1", model: "test-model",
        authMode: "bearer", apiMode: "auto", reasoningMode: "auto",
      }) as { consentKey: string; payloadPreview: { redactedHash: string } };
      await expect(planner.testProviderConnection({
        ...params,
        consentKey: boundPreview.consentKey,
        payloadHash: boundPreview.payloadPreview.redactedHash,
        ...stale,
      }, context)).rejects.toThrow(/missing or stale/);
    }
    await expect(providerService.status("openai")).resolves.toMatchObject({ configured: false });
    await planner.close();
  });

  it("fails closed on Trade and can cancel while worker startup is pending", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      ...testRuntime(),
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
    await expect(planner.hello({ clientName: "test", clientVersion: "1" })).resolves.toMatchObject({
      capabilities: { trade: false, providerConfigured: false },
    });
    await planner.close();
  });

  it("persists the live Pareto frontier when cancelled during search", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      ...testRuntime(),
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
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      ...testRuntime(),
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
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      ...testRuntime(),
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
      schemaVersion: 4,
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
      ...testRuntime(),
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
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      ...testRuntime(),
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

  it("queries Trade dynamically and emits a fingerprint-bound importAndEquip candidate", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>",
      fingerprint: "trade-build",
      engineVersion: "test",
      dataVersion: "3_29",
      ruleset: "3_29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    const tradeQueries: Array<Record<string, unknown>> = [];
    const evaluatedActions: unknown[][] = [];
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      ...testRuntime(),
      workerPoolFactory: () => new InMemoryWorkerPool(1, (job) => {
        evaluatedActions.push([...job.payload.actions]);
        const improved = job.payload.actions.some((action) => action.kind === "importAndEquip");
        return {
          jobId: job.id,
          candidateId: job.candidateId,
          metricsByScenario: Object.fromEntries(job.scenarios.map((scenario) => [
            scenario,
            { FullDPS: improved ? 200 : 100 },
          ])),
        };
      }),
    });
    const tradeObjective = {
      ...objective,
      tradeContext: { realm: "pc" as const, league: "Keepers" },
    };
    const started = planner.startRun({ snapshotFingerprint: "trade-build", objective: tradeObjective }, {
      requestId: "trade-dynamic",
      signal: new AbortController().signal,
      notify: () => undefined,
      requestTradeCatalog: async (query) => {
        tradeQueries.push(query);
        const now = new Date().toISOString();
        return {
          runId: query.runId,
          requestId: query.requestId,
          queryHash: query.queryHash,
          fetchedAt: now,
          currencySnapshotAt: now,
          warnings: [],
          items: query.slot === "Helmet" ? [{
            catalogId: "trade:helmet:fixture",
            queryHash: query.queryHash,
            ruleset: query.ruleset,
            league: query.league,
            slot: query.slot,
            itemRaw: "Rarity: Rare\nGolden Helm\nHubris Circlet",
            itemHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            price: { amount: 1, currency: "divine", divineEquivalent: 1 },
          }] : [],
        };
      },
      cancelTradeCatalog: () => undefined,
    }) as { runId: string };
    for (let attempt = 0; attempt < 200 && store.getRun(started.runId)?.selected.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(tradeQueries).toHaveLength(8);
    expect(tradeQueries[0]).toMatchObject({
      ruleset: "3_29",
      realm: "pc",
      league: "Keepers",
      constraints: { rarity: "rare", statFilters: [] },
      limit: 10,
    });
    const tradeAction = evaluatedActions.flat().find((action) =>
      typeof action === "object" && action !== null && "kind" in action
      && action.kind === "importAndEquip") as { preconditions?: unknown; payload?: unknown } | undefined;
    expect(tradeAction).toMatchObject({
      preconditions: { baseFingerprint: "trade-build" },
      payload: {
        catalogId: "trade:helmet:fixture",
        slot: "Helmet",
        source: "trade",
        price: { divineEquivalent: 1 },
      },
    });
    expect(store.getRun(started.runId)?.objective.candidateSources.trade).toBe(true);
    if (store.getRun(started.runId)?.status === "paused") planner.cancelRun({ runId: started.runId });
    await planner.close();
  });

  it("injects the consent-gated OpenAI-compatible model into workflow nodes", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>",
      fingerprint: "provider-build",
      engineVersion: "test",
      dataVersion: "3_29",
      ruleset: "3_29",
      metrics: { FullDPS: 100 },
      config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    });
    const providerService = new ProviderProfileService({
      profiles: new MemoryProviderProfileStore(),
      credentials: new MemoryCredentialStore(),
      consent: new ConsentManager(new MemoryConsentRecordStore()),
      probeTransportFactory: () => ({
        create: async () => ({
          choices: [{ message: { tool_calls: [{
            id: "probe", type: "function",
            function: { name: CONNECTION_PROBE_TOOL_NAME, arguments: '{"ok":true}' },
          }] } }],
        }),
      }),
    });
    const settings = {
      providerId: "openai",
      baseURL: "https://example.com/v1",
      model: "golden-model",
      authMode: "bearer" as const,
      apiMode: "chat_completions" as const,
      reasoningMode: "auto" as const,
      apiKey: "provider-secret",
    };
    const testPreview = providerService.previewConnectionTest(settings);
    const tested = await providerService.testConnection({
      ...settings,
      consentKey: testPreview.consentKey,
      payloadHash: testPreview.payloadPreview.redactedHash,
    });
    await providerService.configure({ ...settings, testId: tested.testId });
    const preview = await providerService.preview("openai", { objective: "redacted preview" });
    await providerService.grantConsent("openai", preview.consentKey, preview.dataCategories);
    const providerRequests: Record<string, unknown>[] = [];
    const modelAdapterFactory = new ProviderModelAdapterFactory({
      service: providerService,
      adapter: {
        transport: {
          create: async (request) => {
            providerRequests.push(request);
            return {
              choices: [{ message: { content: "Use verified deterministic search.", tool_calls: [] } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            };
          },
        },
      },
    });
    const planner = new DefaultPlannerController({
      store,
      checkpointer: new MemorySaver(),
      ...testRuntime(),
      providerService,
      modelAdapterFactory,
      workerPoolFactory: () => new InMemoryWorkerPool(1, (job) => ({
        jobId: job.id,
        candidateId: job.candidateId,
        metricsByScenario: Object.fromEntries(job.scenarios.map((scenario) => [scenario, { FullDPS: 100 }])),
      })),
    });
    const providerObjective = {
      ...objective,
      candidateSources: { ...objective.candidateSources, trade: false },
    };
    const started = planner.startRun({ snapshotFingerprint: "provider-build", objective: providerObjective }, {
      requestId: "provider-injection",
      signal: new AbortController().signal,
      notify: () => undefined,
    }) as { runId: string };
    for (let attempt = 0; attempt < 200 && providerRequests.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(providerRequests.length).toBeGreaterThan(0);
    expect(JSON.stringify(providerRequests)).not.toContain("provider-secret");
    for (let attempt = 0; attempt < 200 && (store.getRun(started.runId)?.modelCalls ?? 0) === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(store.getRun(started.runId)?.modelCalls).toBeGreaterThan(0);
    if (store.getRun(started.runId)?.status === "paused") planner.cancelRun({ runId: started.runId });
    await planner.close();
  });

  it("re-evaluates all sustainable scenarios in a fresh pool before Apply", async () => {
    const store = new MemoryPlannerStore();
    store.saveSnapshot({
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      ...testRuntime(),
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
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      ...testRuntime(),
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
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      schemaVersion: 4,
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
      ...testRuntime(),
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
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      schemaVersion: 4,
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
      ...testRuntime(),
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
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      ...testRuntime(),
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
      schemaVersion: 4,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
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
      schemaVersion: 4,
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
      ...testRuntime(),
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

  it("blocks new optimization when no LLM Provider is configured", async () => {
    const store = new MemoryPlannerStore();
    const build = {
      schemaVersion: 4 as const, mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>", fingerprint: "no-provider-build", engineVersion: "test", dataVersion: "3.29", ruleset: "3.29",
      metrics: { FullDPS: 100 }, config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    };
    store.saveSnapshot(build);
    const planner = new DefaultPlannerController({
      store, checkpointer: new MemorySaver(),
      workerPoolFactory: () => new InMemoryWorkerPool(1, (job) => ({ jobId: job.id, candidateId: job.candidateId, metricsByScenario: {} })),
    });
    const notifications: Array<{ method: string; params: { error?: string } }> = [];
    const started = planner.startRun({ snapshotFingerprint: build.fingerprint, objective }, {
      requestId: "no-provider", signal: new AbortController().signal,
      notify: (notification) => notifications.push(notification as typeof notifications[number]),
    }) as { runId: string };
    for (let attempt = 0; attempt < 100 && store.getRun(started.runId)?.status !== "failed"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(store.getRun(started.runId)).toMatchObject({ status: "failed" });
    expect(notifications.find(({ method }) => method === "run.failed")?.params.error).toMatch(/Provider configuration is unavailable/);
    await planner.close();
  });

  it("starts, reports, and completes asynchronous mechanic understanding", async () => {
    const store = new MemoryPlannerStore();
    const build = {
      schemaVersion: 4 as const, mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>", fingerprint: "mechanic-analysis-build", engineVersion: "test", dataVersion: "3.29", ruleset: "3.29",
      metrics: {}, config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    };
    store.saveSnapshot(build);
    const providerService = new ProviderProfileService({
      profiles: new MemoryProviderProfileStore(), credentials: new MemoryCredentialStore(),
      consent: new ConsentManager(new MemoryConsentRecordStore()),
    });
    const notifications: Array<{ method: string }> = [];
    const planner = new DefaultPlannerController({
      store, checkpointer: new MemorySaver(), providerService, ...testRuntime(),
      workerPoolFactory: () => new InMemoryWorkerPool(1, (job) => ({ jobId: job.id, candidateId: job.candidateId, metricsByScenario: {} })),
    });
    const context = {
      requestId: "mechanics", signal: new AbortController().signal,
      notify: (notification: { method: string }) => notifications.push(notification),
    };
    const started = planner.startMechanicAnalysis({
      snapshotFingerprint: build.fingerprint, contexts: ["weaponSet1", "weaponSet2"], force: false,
    }, context) as { analysisId: string };
    let status: { status: string; report?: VerifiedBuildMechanicReport } = { status: "running" };
    for (let attempt = 0; attempt < 100 && status.status === "running"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      status = planner.mechanicAnalysisStatus({ analysisId: started.analysisId }, context) as typeof status;
    }
    expect(status).toMatchObject({ status: "completed", report: { status: "verified" } });
    expect(notifications.some(({ method }) => method === "mechanics.completed")).toBe(true);
    await planner.close();
  });

  it("cancels an active mechanic analysis without publishing a failed report", async () => {
    const store = new MemoryPlannerStore();
    const build = {
      schemaVersion: 4 as const, mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>", fingerprint: "mechanic-cancel-build", engineVersion: "test", dataVersion: "3.29", ruleset: "3.29",
      metrics: {}, config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    };
    store.saveSnapshot(build);
    const providerService = new ProviderProfileService({
      profiles: new MemoryProviderProfileStore(), credentials: new MemoryCredentialStore(),
      consent: new ConsentManager(new MemoryConsentRecordStore()),
    });
    const notifications: Array<{ method: string }> = [];
    const planner = new DefaultPlannerController({
      store, checkpointer: new MemorySaver(), providerService,
      modelAdapterFactory: testRuntime().modelAdapterFactory,
      mechanicEngineFactory: () => ({ understand: async (_snapshot: BuildSnapshot, _options: unknown, signal: AbortSignal) => {
        if (signal.aborted) throw signal.reason;
        return await new Promise<VerifiedBuildMechanicReport>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } }),
      workerPoolFactory: () => new InMemoryWorkerPool(1, (job) => ({ jobId: job.id, candidateId: job.candidateId, metricsByScenario: {} })),
    });
    const context = {
      requestId: "mechanics-cancel", signal: new AbortController().signal,
      notify: (notification: { method: string }) => notifications.push(notification),
    };
    const started = planner.startMechanicAnalysis({
      snapshotFingerprint: build.fingerprint, contexts: ["weaponSet1", "weaponSet2"], force: false,
    }, context) as { analysisId: string };
    expect(planner.cancelMechanicAnalysis({ analysisId: started.analysisId })).toEqual({
      analysisId: started.analysisId, status: "cancelled",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(planner.mechanicAnalysisStatus({ analysisId: started.analysisId }, context)).toMatchObject({ status: "cancelled" });
    expect(notifications.some(({ method }) => method === "mechanics.failed")).toBe(false);
    await planner.close();
  });

  it("rejects Start when the mechanic report is blocked", async () => {
    const store = new MemoryPlannerStore();
    const build = {
      schemaVersion: 4 as const, mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>", fingerprint: "blocked-mechanics-build", engineVersion: "test", dataVersion: "3.29", ruleset: "3.29",
      metrics: { FullDPS: 100 }, config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    };
    store.saveSnapshot(build);
    const runtime = testRuntime();
    const planner = new DefaultPlannerController({
      store, checkpointer: new MemorySaver(), ...runtime,
      mechanicEngineFactory: () => ({ understand: async (captured: BuildSnapshot) => ({
        ...verifiedMechanicReport(captured), status: "blocked" as const, blockers: ["critical proof missing"],
        findings: [{ id: "blocked", severity: "blocker" as const, code: "missing_proof", message: "critical proof missing", evidenceIds: [] }],
      }) }),
      workerPoolFactory: () => new InMemoryWorkerPool(1, (job) => ({ jobId: job.id, candidateId: job.candidateId, metricsByScenario: {} })),
    });
    const started = planner.startRun({ snapshotFingerprint: build.fingerprint, objective }, {
      requestId: "blocked", signal: new AbortController().signal, notify: () => undefined,
    }) as { runId: string };
    for (let attempt = 0; attempt < 100 && store.getRun(started.runId)?.status !== "failed"; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(store.getRun(started.runId)).toMatchObject({ status: "failed", error: expect.stringContaining("blocked") });
    await planner.close();
  });

  it("checkpoints Provider failure and permits only retryProvider or cancelProvider", async () => {
    const store = new MemoryPlannerStore();
    const build = {
      schemaVersion: 4 as const, mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>", fingerprint: "provider-checkpoint-build", engineVersion: "test", dataVersion: "3.29", ruleset: "3.29",
      metrics: { FullDPS: 100 }, config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    };
    store.saveSnapshot(build);
    let fail = true;
    const adapter: ModelAdapter<string> = {
      callsUsed: 0, callsRemaining: 16,
      complete: async () => fail
        ? { kind: "fallback", signal: { type: "deterministic_fallback", reason: "provider_timeout", retryable: true, detail: "fixture timeout" } }
        : { kind: "message", content: "provider recovered", toolCalls: [] },
    };
    const planner = new DefaultPlannerController({
      store, checkpointer: new MemorySaver(),
      modelAdapterFactory: { create: async <TName extends string>() => adapter as ModelAdapter<TName> },
      mechanicEngineFactory: () => ({ understand: async (captured: BuildSnapshot) => verifiedMechanicReport(captured) }),
      workerPoolFactory: () => new InMemoryWorkerPool(1, (job) => ({
        jobId: job.id, candidateId: job.candidateId,
        metricsByScenario: Object.fromEntries(job.scenarios.map((scenario) => [scenario, { FullDPS: 100 }])),
      })),
    });
    const context = { requestId: "provider-checkpoint", signal: new AbortController().signal, notify: () => undefined };
    const started = planner.startRun({ snapshotFingerprint: build.fingerprint, objective }, context) as { runId: string };
    for (let attempt = 0; attempt < 100 && store.getRun(started.runId)?.awaitingProvider === undefined; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    expect(store.getRun(started.runId)).toMatchObject({
      status: "paused", awaitingProvider: { phase: "PlanSearch", error: "fixture timeout", retryable: true },
    });
    await expect(planner.resumeRun({ runId: started.runId, decision: "reject" }, context)).rejects.toThrow(/only retryProvider or cancelProvider/);
    fail = false;
    const resumed = await planner.resumeRun({ runId: started.runId, decision: "retryProvider" }, context) as { status: string };
    expect(resumed.status).toBe("paused");
    expect(store.getRun(started.runId)?.awaitingProvider).toBeUndefined();
    planner.cancelRun({ runId: started.runId });
    await planner.close();
  });
});
