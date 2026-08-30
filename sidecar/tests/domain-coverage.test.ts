import { describe, expect, it } from "vitest";
import {
  CoverageGapError,
  CoverageRegistry,
  DomainGraph,
  MechanicAdapterRegistry,
  compareRulesets,
  createDefaultCoverageRegistry,
  createDefaultMechanicAdapterRegistry,
} from "../src/domain/index.js";

describe("CoverageRegistry", () => {
  it("classifies every optimization domain and explicitly excludes derived state", () => {
    const registry = createDefaultCoverageRegistry();
    const audit = registry.audit([
      "Build.targetVersion",
      "Build.level",
      "Build.characterLevelAutoMode",
      "Build.Spectre.1",
      "Build.TimelessData.jewelTypeId",
      "Skills.SkillSet.1",
      "Items.ItemSet.1",
      "Tree.Spec.1",
      "Party.Member.1",
      "Config.enemyIsBoss",
      "Trade.Query.1",
      "Progression.Step.1",
      "Calcs.CombinedDPS",
      "Build.PlayerStat.TotalDPS",
      "Notes.Text",
    ]);

    expect(audit.complete).toBe(true);
    expect(new Set(audit.classified.map((entry) => entry.domain))).toEqual(new Set([
      "rules", "identity", "skills", "gear", "tree", "actor", "config", "external", "progression",
    ]));
    expect(audit.excluded.map((entry) => entry.path)).toEqual([
      "Build.PlayerStat.TotalDPS", "Calcs.CombinedDPS", "Notes.Text",
    ]);
  });

  it("fails a release audit when a new gameplay field is not classified", () => {
    const registry = createDefaultCoverageRegistry();
    expect(() => registry.assertComplete(["NewSeason.UnknownMechanic"])).toThrow(CoverageGapError);
  });

  it("selects the most specific rule", () => {
    const registry = new CoverageRegistry()
      .register({ pattern: "Items.**", domain: "gear" })
      .register({ pattern: "Items.Guardian.**", domain: "actor" });
    expect(registry.classify("Items.Guardian.Helmet").domain).toBe("actor");
  });
});

describe("MechanicAdapterRegistry", () => {
  it("applies compatible adapters, validates claims, and records adapter coverage", () => {
    const registry = new MechanicAdapterRegistry().register({
      id: "test-mechanic",
      version: 2,
      minRuleset: "3.20",
      maxRuleset: "3.30",
      apply: () => ({
        nodes: [{ id: "mechanic:test", domain: "config", kind: "condition", data: {} }],
        conditionClaims: [{
          condition: "condition:test",
          sources: [{ id: "mechanic:test", trigger: "always" }],
        }],
        coverage: [{ pattern: "Special.Test.**", domain: "config" }],
      }),
    });
    const coverage = new CoverageRegistry();
    const result = registry.apply(
      new DomainGraph(),
      { ruleset: "3.29", dataVersion: "test", catalog: [] },
      coverage,
    );

    expect(result.appliedAdapterIds).toEqual(["test-mechanic@2"]);
    expect(result.graph.hasNode("mechanic:test")).toBe(true);
    expect(result.conditionClaims[0]).toMatchObject({ condition: "condition:test", manual: false });
    expect(coverage.classify("Special.Test.Value").mechanicAdapterId).toBe("test-mechanic");
  });

  it("compares PoE ruleset numbers and ships adapters for special content", () => {
    expect(compareRulesets("3.29", "3.9")).toBeGreaterThan(0);
    expect(compareRulesets("3.29.0", "3.29")).toBe(0);

    const registry = createDefaultMechanicAdapterRegistry();
    const result = registry.apply(new DomainGraph(), {
      ruleset: "3.29",
      dataVersion: "test",
      catalog: [
        {
          id: "tree:timeless",
          domain: "tree",
          kind: "Abyss Timeless Jewel",
          available: true,
          data: {},
        },
        {
          id: "pob:config",
          domain: "config",
          kind: "currentBuild",
          available: true,
          data: {
            conditionClaims: [{
              condition: "conditionHaveTotem",
              source: "current-config",
              sourceStatus: "manual",
            }],
          },
        },
      ],
    });
    expect(result.appliedAdapterIds).toContain("advanced-passives@1");
    expect(result.appliedAdapterIds).toContain("configuration-evidence@1");
    expect(result.graph.hasNode("tree:timeless")).toBe(true);
    expect(result.conditionClaims[0]).toMatchObject({
      condition: "conditionHaveTotem",
      configKey: "conditionHaveTotem",
      manual: true,
    });
  });
});
