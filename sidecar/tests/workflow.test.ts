import { EMPTY_PROJECTION_FINGERPRINT, emptyModifierProjection } from "./mechanicsFixture.js";
import { Command, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import type { BuildSnapshot, Candidate, ObjectiveSpec } from "../src/schemas.js";
import {
  createSqliteSaver,
  createWorkflowGraph,
  createWorkflowInput,
  resolveDeepLimits,
  toOptimizationRun,
  workflowConfig,
  type WorkflowNodeContext,
  type WorkflowState,
} from "../src/workflow/index.js";

const objective: ObjectiveSpec = {
  schemaVersion: 4,
  primaryScenario: "mapping",
  scenarioWeights: { mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 },
  locks: { class: true, ascendancy: true, mainSkill: true, fields: [] },
  searchPreset: "deep",
  goals: [{ metric: "FullDPS", direction: "maximize", weight: 1 }],
  hardConstraints: [],
  candidateSources: { currentBuild: true, uniques: true, targetRares: true, trade: true },
};

const snapshot: BuildSnapshot = {
  schemaVersion: 4,
  mechanicProjection: emptyModifierProjection(),
  mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
  xml: "<PathOfBuilding/>",
  fingerprint: "build-fingerprint",
  engineVersion: "2.67.2",
  dataVersion: "3.29",
  ruleset: "3_29",
  metrics: { FullDPS: 100 },
  config: {
    enemyIsBoss: "Pinnacle",
    presetBossSkills: "Sirus",
    mapModifiers: ["40% less recovery"],
    multiplierMapModEffect: 1.2,
    MapPrefix1: "Monsters deal extra damage",
  },
  buildState: {},
  gameplayFieldPaths: ["Build.level"],
};

const candidate: Candidate = {
  schemaVersion: 4,
  id: "balanced-1",
  label: "Balanced",
  summary: "More damage without losing defence",
  baseFingerprint: snapshot.fingerprint,
  cost: { divine: 0, display: "0 div" },
  metrics: { FullDPS: 120 },
  scenarioMetrics: {
    mapping: { FullDPS: 120 },
    standardBoss: { FullDPS: 110 },
    pinnacle: { FullDPS: 100 },
    uber: { FullDPS: 90 },
  },
  peakScenarioMetrics: { mapping: {}, standardBoss: {}, pinnacle: {}, uber: {} },
  actions: [],
  evidence: [],
  hardConstraintsSatisfied: true,
};

describe("optimizer workflow", () => {
  it("builds native scenarios, interrupts for approval, then records rejection", async () => {
    const graph = createWorkflowGraph({
      checkpointer: new MemorySaver(),
      nodes: { searchDomains: () => ({ searchStopReason: "exhausted" }) },
    });
    const config = workflowConfig("reject-run");
    const paused = await graph.invoke(createWorkflowInput({ runId: "reject-run", snapshot, objective }), config) as WorkflowState;

    expect(paused.status).toBe("paused");
    expect(paused.scenarios.map(({ id }) => id)).toEqual([
      "current",
      "mapping",
      "standardBoss",
      "pinnacle",
      "uber",
      "mapping",
      "standardBoss",
      "pinnacle",
      "uber",
    ]);
    expect(paused.scenarios.find(({ id }) => id === "current")?.enemyIsBoss).toBe("Pinnacle");
    expect(paused.scenarios.find(({ id }) => id === "mapping")?.allowedEvents).toContain("onKill");
    expect(paused.scenarios.find(({ id, profile }) => id === "mapping" && profile === "sustainable")
      ?.assumptions.configInputs).toEqual({
        multiplierMapModEffect: 1.2,
        MapPrefix1: "Monsters deal extra damage",
      });
    expect(paused.scenarios.find(({ id }) => id === "uber")?.allowedEvents).not.toContain("onKill");
    expect(paused.scenarios.find(({ id, profile }) => id === "standardBoss" && profile === "sustainable")
      ?.bossSkillPreset).toBe("Sirus");
    expect(paused.scenarios.find(({ id, profile }) => id === "mapping" && profile === "sustainable")
      ?.bossSkillPreset).toBeUndefined();
    expect(paused.objective?.candidateSources).toEqual({
      currentBuild: true,
      uniques: false,
      targetRares: false,
      trade: false,
    });
    expect(paused.searchStopReason).toBe("exhausted");

    const completed = await graph.invoke(new Command({ resume: { decision: "reject" } }), config) as WorkflowState;
    expect(completed.status).toBe("completed");
    expect(completed.stopReason).toBe("rejected");
    expect(toOptimizationRun(completed).searchStopReason).toBe("exhausted");
    expect(completed.phase).toBe("end");
    expect(completed.trace).toContain("HumanApproval");
  });

  it("loops through refinement and executes only the human-selected transaction", async () => {
    let verifyCalls = 0;
    const searchDomains = vi.fn((_state: Readonly<WorkflowState>, context: Readonly<WorkflowNodeContext>) => {
      expect(context.sustainableScenarios).toHaveLength(4);
      expect(context.sustainableScenarios.every(({ profile }) => profile === "sustainable")).toBe(true);
      expect(context.peakScenarios).toHaveLength(4);
      return {
        frontier: [candidate],
        selected: [candidate],
        usage: { evaluations: 4 },
      };
    });
    const graph = createWorkflowGraph({
      checkpointer: new MemorySaver(),
      nodes: {
        searchDomains,
        verify: () => {
          verifyCalls += 1;
          return verifyCalls === 1
            ? { needsRefinement: true, improvementRatio: 0.05 }
            : { needsRefinement: false, improvementRatio: 0.001 };
        },
      },
    });
    const config = workflowConfig("apply-run");
    const paused = await graph.invoke(createWorkflowInput({ runId: "apply-run", snapshot, objective }), config) as WorkflowState;

    expect(paused.refinementRounds).toBe(1);
    expect(searchDomains).toHaveBeenCalledTimes(2);
    expect(paused.evaluations).toBe(8);
    expect(paused.frontier).toEqual([candidate]);

    const transactionPaused = await graph.invoke(new Command({
      resume: { decision: "apply", candidateId: candidate.id },
    }), config) as WorkflowState;
    expect(transactionPaused.status).toBe("paused");
    expect(transactionPaused.transactionResult).toBeUndefined();

    const completed = await graph.invoke(new Command({
      resume: {
        runId: "apply-run",
        candidateId: candidate.id,
        accepted: true,
        applied: true,
        rolledBack: false,
        fingerprint: "applied-fingerprint",
        metrics: candidate.metrics,
        scenarioMetrics: candidate.scenarioMetrics,
      },
    }), config) as WorkflowState;
    expect(completed.transactionResult?.applied).toBe(true);
    expect(completed.stopReason).toBe("completed");
    expect(toOptimizationRun(completed).status).toBe("completed");
  });

  it("stops a repeated high-level call as a doom loop", async () => {
    const repeated = () => ({ toolCallFingerprint: "same-tool-and-arguments" });
    const graph = createWorkflowGraph({
      checkpointer: new MemorySaver(),
      limits: { duplicateCallLimit: 3 },
      nodes: {
        planSearch: repeated,
        searchDomains: repeated,
        verify: () => ({ needsRefinement: true, improvementRatio: 0.1 }),
        refineSearch: repeated,
      },
    });
    const config = workflowConfig("doom-run");
    const paused = await graph.invoke(createWorkflowInput({ runId: "doom-run", snapshot, objective }), config) as WorkflowState;

    expect(paused.stopReason).toBe("doom_loop");
    expect(paused.duplicateToolCalls).toBe(3);
    expect(paused.refinementRounds).toBe(1);
  });

  it("stops after three sub-threshold refinement rounds", async () => {
    let verifyCalls = 0;
    const graph = createWorkflowGraph({
      checkpointer: new MemorySaver(),
      limits: { convergenceRounds: 3, convergenceThreshold: 0.005 },
      nodes: {
        verify: () => {
          verifyCalls += 1;
          return {
            needsRefinement: true,
            improvementRatio: 0.001,
            paretoFrontierChanged: verifyCalls === 1,
          };
        },
      },
    });
    const config = workflowConfig("convergence-run");
    const paused = await graph.invoke(createWorkflowInput({ runId: "convergence-run", snapshot, objective }), config) as WorkflowState;

    expect(verifyCalls).toBe(4);
    expect(paused.noImprovementRounds).toBe(3);
    expect(paused.refinementRounds).toBe(3);
    expect(paused.stopReason).toBe("converged");
  });

  it("enforces evaluation and model-call limits before another expensive step", async () => {
    const evaluationGraph = createWorkflowGraph({
      checkpointer: new MemorySaver(),
      limits: { evaluationLimit: 2 },
      nodes: {
        searchDomains: () => ({ usage: { evaluations: 2 } }),
        verify: () => ({ needsRefinement: true, improvementRatio: 0.1 }),
      },
    });
    const evaluationState = await evaluationGraph.invoke(
      createWorkflowInput({ runId: "evaluation-limit", snapshot, objective }),
      workflowConfig("evaluation-limit"),
    ) as WorkflowState;
    expect(evaluationState.stopReason).toBe("evaluation_limit");
    expect(evaluationState.evaluations).toBe(2);

    const searchDomains = vi.fn(() => ({}));
    const modelGraph = createWorkflowGraph({
      checkpointer: new MemorySaver(),
      limits: { modelCallLimit: 1 },
      nodes: {
        planSearch: () => ({ usage: { modelCalls: 1 } }),
        searchDomains,
      },
    });
    const modelState = await modelGraph.invoke(
      createWorkflowInput({ runId: "model-limit", snapshot, objective }),
      workflowConfig("model-limit"),
    ) as WorkflowState;
    expect(modelState.stopReason).toBe("model_call_limit");
    expect(searchDomains).not.toHaveBeenCalled();
  });

  it("cancels without entering human approval", async () => {
    const graph = createWorkflowGraph({ checkpointer: new MemorySaver() });
    const completed = await graph.invoke(
      createWorkflowInput({ runId: "cancel-run", snapshot, objective, cancelRequested: true }),
      workflowConfig("cancel-run"),
    ) as WorkflowState;

    expect(completed.status).toBe("cancelled");
    expect(completed.stopReason).toBe("cancelled");
    expect(completed.trace).not.toContain("HumanApproval");
  });

  it("sets checkpoint thread id and recursion limit", () => {
    const limits = resolveDeepLimits({ recursionLimit: 77 });
    expect(workflowConfig("thread-77", limits, "optimizer")).toMatchObject({
      configurable: { thread_id: "thread-77", checkpoint_ns: "optimizer" },
      recursionLimit: 77,
    });
  });
});

describe("SQLite checkpointer factory", () => {
  it("loads the saver lazily and supports in-memory checkpoints", async () => {
    const result = await createSqliteSaver({ connectionString: ":memory:" });
    expect(result.checkpointer).toBeDefined();
    expect(result.persistent).toBe(false);
    expect(() => result.close()).not.toThrow();
    expect(() => result.close()).not.toThrow();
  });

  it("rejects an empty connection string before importing native SQLite", async () => {
    await expect(createSqliteSaver({ connectionString: " " })).rejects.toThrow(
      "SQLite connection string must not be empty",
    );
  });
});
