import { EMPTY_PROJECTION_FINGERPRINT, emptyModifierProjection } from "./mechanicsFixture.js";
import { describe, expect, it } from "vitest";
import { SidecarDatabase } from "../src/storage/database.js";

describe("SidecarDatabase", () => {
  it("round-trips snapshots and cached evaluations", () => {
    const store = new SidecarDatabase(":memory:");
    const snapshot = {
      schemaVersion: 4 as const,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>",
      fingerprint: "build:one",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "Standard",
      metrics: {},
      config: {},
      buildState: {},
      gameplayFieldPaths: ["Build.level"],
    };
    store.saveSnapshot(snapshot);
    expect(store.getSnapshot("build:one")).toEqual(snapshot);
    store.setCache("cache:one", { FullDPS: 123 });
    expect(store.getCache("cache:one")).toEqual({ FullDPS: 123 });
    store.close();
  });

  it("persists a selected candidate that overlaps the frontier id", () => {
    const store = new SidecarDatabase(":memory:");
    const snapshot = {
      schemaVersion: 4 as const,
      mechanicProjection: emptyModifierProjection(),
      mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
      xml: "<PathOfBuilding/>",
      fingerprint: "build:overlap",
      engineVersion: "test",
      dataVersion: "3.29",
      ruleset: "3.29",
      metrics: { FullDPS: 100 },
      config: {},
      buildState: {},
      gameplayFieldPaths: ["Build.level"],
    };
    store.saveSnapshot(snapshot);
    const candidate = {
      schemaVersion: 4 as const,
      id: "same-candidate",
      label: "Balanced" as const,
      summary: "Same selected and frontier candidate",
      baseFingerprint: snapshot.fingerprint,
      cost: { divine: 0, display: "0" },
      metrics: { FullDPS: 100 },
      scenarioMetrics: {
        mapping: { FullDPS: 100 }, standardBoss: { FullDPS: 100 },
        pinnacle: { FullDPS: 100 }, uber: { FullDPS: 100 },
      },
      peakScenarioMetrics: { mapping: {}, standardBoss: {}, pinnacle: {}, uber: {} },
      actions: [], evidence: [], hardConstraintsSatisfied: true,
    };
    store.saveRun({
      schemaVersion: 4,
      id: "run:overlap",
      buildFingerprint: snapshot.fingerprint,
      status: "paused",
      objective: {
        schemaVersion: 4,
        primaryScenario: "mapping",
        scenarioWeights: { mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 },
        locks: { class: true, ascendancy: true, mainSkill: true, fields: [] },
        searchPreset: "deep",
        goals: [{ metric: "FullDPS", direction: "maximize", weight: 1 }],
        hardConstraints: [],
        candidateSources: { currentBuild: true, uniques: false, targetRares: false, trade: false },
      },
      scenarios: [], frontier: [candidate], selected: [candidate],
      evaluations: 4, modelCalls: 0, refinementRounds: 0,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    expect(store.getCandidate("run:overlap", "same-candidate")?.id).toBe("same-candidate");
    store.close();
  });
});
