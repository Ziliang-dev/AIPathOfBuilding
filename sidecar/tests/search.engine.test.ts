import { describe, expect, it } from "vitest";
import type { DeepLimits, ScenarioSpec } from "../src/schemas.js";
import {
  SearchControl,
  SearchEngine,
  createFullDomainRegistry,
  type DomainSearchState,
  type EvaluatedCandidate,
  type SearchCandidate,
  type SearchObjective,
} from "../src/search/index.js";
import { InMemoryWorkerPool, type WorkerEvaluation } from "../src/worker/index.js";
import type { PobWorkerEvaluatePayload } from "../src/worker/index.js";
import { MemoryPlannerStore } from "../src/storage/index.js";

const scenarios = ["mapping", "standardBoss", "pinnacle", "uber"] as const;
const objective: SearchObjective = {
  primaryMetric: "dps",
  primaryScenario: "mapping",
  scenarioWeights: { mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 },
  metrics: [
    { key: "dps", direction: "maximize", role: "offence" },
    { key: "ehp", direction: "maximize", role: "defence" },
  ],
  hardConstraints: [],
};
const limits: DeepLimits = {
  recursionLimit: 10,
  wallTimeMs: 60_000,
  evaluationLimit: 100,
  modelCallLimit: 16,
  convergenceRounds: 3,
  convergenceThreshold: 0.005,
  duplicateCallLimit: 99,
};
const scenarioSpecs: readonly ScenarioSpec[] = [
  { id: "mapping", name: "Mapping", enemyIsBoss: "None", profile: "sustainable", mapModifiers: [], allowedEvents: ["onKill"], assumptions: {} },
  { id: "standardBoss", name: "Standard Boss", enemyIsBoss: "Boss", profile: "sustainable", mapModifiers: [], allowedEvents: [], assumptions: {} },
  { id: "pinnacle", name: "Pinnacle", enemyIsBoss: "Pinnacle", profile: "sustainable", mapModifiers: [], allowedEvents: [], assumptions: {} },
  { id: "uber", name: "Uber", enemyIsBoss: "Uber", profile: "sustainable", mapModifiers: [], allowedEvents: [], assumptions: {} },
];

function evaluated(id: string, dps: number, ehp: number): EvaluatedCandidate {
  return {
    id,
    baseFingerprint: "build",
    actions: [],
    metricsByScenario: Object.fromEntries(scenarios.map((scenario) => [scenario, { dps, ehp }])),
  };
}

describe("SearchEngine", () => {
  it("evaluates domain proposals and preserves the Pareto frontier", async () => {
    const proposal: SearchCandidate = { id: "upgrade", baseFingerprint: "build", actions: [{ id: "upgrade-action" }] };
    const state: DomainSearchState = {
      buildXml: "<PathOfBuilding/>",
      scenarioSpecs,
      evidence: [],
      domainCandidates: { skills: [proposal] },
    };
    const pool = new InMemoryWorkerPool<PobWorkerEvaluatePayload, WorkerEvaluation>(2, (job) => ({
      jobId: job.id,
      candidateId: job.candidateId,
      metricsByScenario: Object.fromEntries(scenarios.map((scenario) => [scenario, { dps: 200, ehp: 200 }])),
    }));
    const engine = new SearchEngine({
      runId: "run",
      state,
      initialCandidates: [evaluated("base", 100, 100)],
      sustainableScenarios: scenarios,
      objective,
      registry: createFullDomainRegistry(),
      workerPool: pool,
      limits,
    });
    const result = await engine.run();
    expect(result.stopReason).toBe("exhausted");
    expect(result.evaluations).toBe(4);
    expect(result.frontier).toHaveLength(1);
    expect(result.frontier[0]?.id).toMatch(/^candidate:skills:/u);
    expect(result.selections.offence?.id).toBe(result.frontier[0]?.id);
    await pool.close();
  });

  it("searches from an infeasible baseline until an action satisfies hard constraints", async () => {
    const constrained: SearchObjective = {
      ...objective,
      hardConstraints: [{ id: "survive", metric: "ehp", operator: "gte", value: 150 }],
    };
    const pool = new InMemoryWorkerPool<PobWorkerEvaluatePayload, WorkerEvaluation>(1, (job) => ({
      jobId: job.id,
      candidateId: job.candidateId,
      metricsByScenario: Object.fromEntries(scenarios.map((scenario) => [scenario, { dps: 120, ehp: 200 }])),
    }));
    const result = await new SearchEngine({
      runId: "constraint-recovery",
      state: {
        buildXml: "<PathOfBuilding/>", scenarioSpecs, evidence: [],
        domainCandidates: { skills: [{ id: "repair", baseFingerprint: "build", actions: [{ id: "repair" }] }] },
      },
      initialCandidates: [evaluated("infeasible", 100, 100)],
      sustainableScenarios: scenarios,
      objective: constrained,
      registry: createFullDomainRegistry(),
      workerPool: pool,
      limits,
    }).run();
    expect(result.evaluations).toBe(4);
    expect(result.frontier).toHaveLength(1);
    expect(result.frontier[0]?.metricsByScenario.mapping?.ehp).toBe(200);
    await pool.close();
  });

  it("stops cleanly when cancelled before search", async () => {
    const control = new SearchControl();
    control.cancel();
    const pool = new InMemoryWorkerPool<PobWorkerEvaluatePayload, WorkerEvaluation>(1, () => {
      throw new Error("must not evaluate");
    });
    const result = await new SearchEngine({
      runId: "cancelled",
      state: {},
      initialCandidates: [evaluated("base", 100, 100)],
      sustainableScenarios: scenarios,
      objective,
      registry: createFullDomainRegistry(),
      workerPool: pool,
      control,
      limits,
    }).run();
    expect(result.stopReason).toBe("cancelled");
    expect(result.evaluations).toBe(0);
    await pool.close();
  });

  it("detects repeated tool calls without graph-state change", () => {
    const control = new SearchControl();
    expect(control.recordToolCall("same", 3)).toBe(1);
    expect(control.recordToolCall("same", 3)).toBe(2);
    expect(control.doomLoop).toBe(false);
    expect(control.recordToolCall("same", 3)).toBe(3);
    expect(control.doomLoop).toBe(true);
  });

  it("stops exactly at the model-call limit", async () => {
    const control = new SearchControl();
    control.recordModelCall();
    const pool = new InMemoryWorkerPool<PobWorkerEvaluatePayload, WorkerEvaluation>(1, () => {
      throw new Error("must not evaluate");
    });
    const result = await new SearchEngine({
      runId: "model-limit",
      state: {},
      initialCandidates: [evaluated("base", 100, 100)],
      sustainableScenarios: scenarios,
      objective,
      registry: createFullDomainRegistry(),
      workerPool: pool,
      control,
      limits: { ...limits, modelCallLimit: 1 },
    }).run();
    expect(result.stopReason).toBe("model_call_limit");
    await pool.close();
  });

  it("reads and writes PlannerStore evaluation cache without charging cache hits", async () => {
    const proposal: SearchCandidate = { id: "cached", baseFingerprint: "build", actions: [{ id: "action" }] };
    const state: DomainSearchState = {
      buildXml: "<PathOfBuilding/>",
      scenarioSpecs,
      evidence: [],
      domainCandidates: { skills: [proposal] },
    };
    const store = new MemoryPlannerStore();
    let workerCalls = 0;
    const cacheContext = {
      engineCommit: "commit",
      ruleset: "3.29",
      buildFingerprint: "build",
      objectiveVersion: 1,
    };
    const makePool = () => new InMemoryWorkerPool<PobWorkerEvaluatePayload, WorkerEvaluation>(1, (job) => {
      workerCalls += 1;
      return {
        jobId: job.id,
        candidateId: job.candidateId,
        metricsByScenario: Object.fromEntries(job.scenarios.map((scenario) => [scenario, { dps: 200, ehp: 200 }])),
      };
    });
    const firstPool = makePool();
    const first = await new SearchEngine({
      runId: "first",
      state,
      initialCandidates: [evaluated("base", 100, 100)],
      sustainableScenarios: scenarios,
      objective,
      registry: createFullDomainRegistry(),
      workerPool: firstPool,
      limits,
      store,
      cacheContext,
    }).run();
    expect(first.evaluations).toBe(4);
    await firstPool.close();

    const secondPool = makePool();
    const second = await new SearchEngine({
      runId: "second",
      state,
      initialCandidates: [evaluated("base", 100, 100)],
      sustainableScenarios: scenarios,
      objective,
      registry: createFullDomainRegistry(),
      workerPool: secondPool,
      limits,
      store,
      cacheContext,
    }).run();
    expect(second.evaluations).toBe(0);
    expect(workerCalls).toBe(1);
    await secondPool.close();
    store.close();
  });

  it("does not partially evaluate a candidate when the remaining scenario budget is insufficient", async () => {
    let calls = 0;
    const pool = new InMemoryWorkerPool<PobWorkerEvaluatePayload, WorkerEvaluation>(1, () => {
      calls += 1;
      throw new Error("must not partially evaluate");
    });
    const result = await new SearchEngine({
      runId: "limited",
      state: {
        buildXml: "<PathOfBuilding/>", scenarioSpecs, evidence: [],
        domainCandidates: { skills: [{ id: "upgrade", baseFingerprint: "build", actions: [{ id: "action" }] }] },
      },
      initialCandidates: [evaluated("base", 100, 100)],
      sustainableScenarios: scenarios,
      objective,
      registry: createFullDomainRegistry(),
      workerPool: pool,
      limits: { ...limits, evaluationLimit: 2 },
    }).run();
    expect(result.stopReason).toBe("evaluation_limit");
    expect(result.evaluations).toBe(0);
    expect(calls).toBe(0);
    await pool.close();
  });
});
