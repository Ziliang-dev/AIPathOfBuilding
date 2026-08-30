import { EMPTY_PROJECTION_FINGERPRINT, emptyModifierProjection } from "./mechanicsFixture.js";
import { describe, expect, it } from "vitest";
import {
  BuildActionSchema,
  BuildSnapshotSchema,
  CandidateSchema,
  ObjectiveSpecSchema,
  TransactionResultSchema,
  normalizeObjectiveSpec,
} from "../src/schemas.js";
import { RunResumeParamsSchema } from "../src/protocol.js";

const objective = {
  schemaVersion: 3,
  primaryScenario: "mapping",
  scenarioWeights: { mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 },
  locks: { class: true, ascendancy: true, mainSkill: true, fields: [] },
  searchPreset: "deep",
  goals: [{ metric: "FullDPS", direction: "maximize", weight: 1 }],
  hardConstraints: [],
  candidateSources: { currentBuild: true, uniques: true, targetRares: true, trade: true },
} as const;

describe("public schemas", () => {
  it("accepts bounded optional catalog and graph data", () => {
    const parsed = BuildSnapshotSchema.parse({
      schemaVersion: 3,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>",
      fingerprint: "sha256:one",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "Standard",
      contentCatalog: [{ id: "skill:one", domain: "skills", kind: "gem" }],
      buildGraph: {
        nodes: [{ id: "skill:one", domain: "skills", kind: "gem" }],
        edges: [],
      },
    });
    expect(parsed.contentCatalog?.[0]?.available).toBe(true);
  });

  it("requires scenario weights to sum to one", () => {
    expect(() => ObjectiveSpecSchema.parse({
      ...objective,
      scenarioWeights: { ...objective.scenarioWeights, mapping: 0.4 },
    })).toThrow(/sum to 1/);
  });

  it("forces external candidate sources off when budget is absent", () => {
    expect(normalizeObjectiveSpec(objective).candidateSources).toEqual({
      currentBuild: true,
      uniques: false,
      targetRares: false,
      trade: false,
    });
    expect(normalizeObjectiveSpec({ ...objective, budgetDivine: 20 }).candidateSources.trade).toBe(true);
  });

  it("validates typed reversible actions", () => {
    expect(BuildActionSchema.parse({
      kind: "replaceSkillLinks",
      id: "action:links",
      description: "Replace support links",
      payload: { group: 1, gems: ["A", "B"] },
    }).reversible).toBe(true);
    expect(BuildActionSchema.parse({
      kind: "setConfig",
      id: "action:guarded",
      description: "Guarded config change",
      preconditions: { baseFingerprint: "sha256:base" },
      payload: { name: "conditionOnslaught", value: true },
    }).preconditions).toEqual({ baseFingerprint: "sha256:base" });
  });

  it("distinguishes checkpoint resume from human approval", () => {
    expect(RunResumeParamsSchema.parse({ runId: "run-1", mode: "checkpoint" })).toEqual({
      runId: "run-1", mode: "checkpoint",
    });
    expect(() => RunResumeParamsSchema.parse({ runId: "run-1", decision: "apply" })).toThrow();
  });

  it("requires complete proof for an applied transaction", () => {
    expect(() => TransactionResultSchema.parse({
      runId: "run-1",
      candidateId: "candidate-1",
      accepted: true,
      applied: true,
    })).toThrow(/requires/);
    expect(TransactionResultSchema.parse({
      runId: "run-1",
      candidateId: "candidate-1",
      accepted: true,
      applied: true,
      rolledBack: false,
      fingerprint: "applied-build",
      metrics: {},
      scenarioMetrics: { mapping: {}, standardBoss: {}, pinnacle: {}, uber: {} },
    }).fingerprint).toBe("applied-build");
  });

  it("requires all four ranked scenarios on candidates", () => {
    expect(() => CandidateSchema.parse({
      schemaVersion: 3,
      id: "candidate-incomplete",
      label: "Offence",
      summary: "Incomplete scenario fixture",
      baseFingerprint: "base-build",
      cost: { divine: 0, display: "0" },
      metrics: {},
      scenarioMetrics: { mapping: {} },
      actions: [],
      hardConstraintsSatisfied: true,
    })).toThrow();
  });
});
