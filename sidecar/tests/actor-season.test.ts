import { describe, expect, it } from "vitest";
import {
  DomainGraph,
  createDefaultMechanicAdapterRegistry,
  createActorSeasonAdapters,
  supportsActorSeasonRuleset,
} from "../src/domain/index.js";

describe("actor and seasonal mechanic adapters", () => {
  it("gates the reviewed 3.29 rulesets", () => {
    expect(supportsActorSeasonRuleset("3_29")).toBe(true);
    expect(supportsActorSeasonRuleset("3_29_ruthless")).toBe(true);
    expect(supportsActorSeasonRuleset("3.29ruthless")).toBe(true);
    expect(supportsActorSeasonRuleset("3.30")).toBe(false);
  });

  it("registers the coverage-compatible bloodline and pact adapters", () => {
    const ids = createActorSeasonAdapters().map((adapter) => adapter.id);
    expect(ids).toEqual(expect.arrayContaining([
      "actor-native", "bloodline", "pacts", "advanced-passives-native", "equipment-seasonal",
    ]));
  });

  it("projects actor, bloodline, pact, passive, and seasonal item records", () => {
    const registry = createDefaultMechanicAdapterRegistry();
    const catalog = [
      {
        id: "pob:actors", domain: "actor" as const, kind: "currentBuild", available: true,
        data: {
          actors: [
            { id: "actor:player", kind: "player", source: "Build" },
            { id: "actor:spectre:monkey", kind: "spectre", spectreId: "monkey", known: true },
            { id: "actor:animate-guardian", kind: "animateGuardian", itemSetId: 2 },
          ],
          party: { Aura: { textHash: "abc", text: "raw party text", sourceStatus: "manual" } },
          season: {
            bloodline: { id: "Farrul", name: "Farrul Bloodline" },
            pacts: [{ id: "Pact of Beidat", name: "Pact of Beidat" }],
            timeless: { jewelTypeId: 9 },
            overrides: [{ nodeId: 37999, dn: "Tattoo of the Tawhoa Shaman", isTattoo: true }],
            items: {
              grafts: [{ itemId: "g1", baseName: "Uul-Netol Graft" }],
              tinctures: [{ itemId: "t1", baseName: "Prismatic Tincture" }],
              foulborn: [{ itemId: "f1", baseName: "Voll's Devotion", foulborn: true }],
            },
          },
        },
      },
      {
        id: "pob:tree", domain: "tree" as const, kind: "currentBuild", available: true,
        data: {
          secondaryAscendancy: { id: "Farrul", name: "Farrul Bloodline", selected: true },
          season: {
            timeless: { jewelTypeId: 9, conquerorTypeId: 1, jewelSocketId: 61419, seed: 533 },
            overrides: [{ nodeId: 37999, dn: "Tattoo of the Tawhoa Shaman", isTattoo: true }],
            runegrafts: [{ nodeId: 4492, dn: "Runegraft of the Agile", overrideType: "AlternateMastery" }],
          },
        },
      },
      {
        id: "pob:skills", domain: "skills" as const, kind: "currentBuild", available: true,
        data: {
          groups: [{ index: 1, gems: [{ name: "Fireball" }, { name: "Pact of Beidat" }] }],
          conditionClaims: [{
            condition: "BeidatActive",
            sources: [{ id: "Pact of Beidat", trigger: "always", uptime: 1 }],
          }],
        },
      },
      {
        id: "pob:items", domain: "gear" as const, kind: "currentBuild", available: true,
        data: { items: [
          { id: "g1", type: "Graft", baseName: "Uul-Netol Graft" },
          { id: "t1", type: "Tincture", baseName: "Prismatic Tincture" },
          { id: "f1", type: "Amulet", baseName: "Voll's Devotion", foulborn: true },
        ] },
      },
    ];
    const result = registry.apply(
      DomainGraph.fromCatalog(catalog),
      { ruleset: "3_29", dataVersion: "3.29", catalog },
    );

    expect(result.appliedAdapterIds).toEqual(expect.arrayContaining([
      "actor-native@1", "bloodline@1", "pacts@1", "advanced-passives-native@1", "equipment-seasonal@1",
    ]));
    expect(result.graph.hasNode("actor:spectre:monkey")).toBe(true);
    expect(result.graph.hasNode("actor:animate-guardian")).toBe(true);
    expect(result.graph.toJSON().nodes.find((node) => node.id === "actor:party:Aura")?.data.text).toBeUndefined();
    expect(result.graph.hasNode("season:bloodline:Farrul")).toBe(true);
    expect(result.graph.hasNode("season:pact:Pact of Beidat")).toBe(true);
    expect(result.graph.hasNode("season:timeless:9")).toBe(true);
    expect(result.graph.hasNode("season:passiveOverride:37999")).toBe(true);
    expect(result.graph.hasNode("season:runegraft:4492")).toBe(true);
    expect(result.graph.hasNode("season:graft:g1")).toBe(true);
    expect(result.graph.hasNode("season:tincture:t1")).toBe(true);
    expect(result.graph.hasNode("season:foulborn:f1")).toBe(true);
    expect(result.conditionClaims).toHaveLength(1);
  });

  it("does not apply reviewed adapters to unsupported future rulesets", () => {
    const registry = createDefaultMechanicAdapterRegistry();
    const result = registry.apply(DomainGraph.fromCatalog([{
      id: "pob:actors", domain: "actor", kind: "currentBuild", available: true,
      data: { actors: [{ id: "actor:minion:zombie", kind: "minion" }] },
    }]), { ruleset: "3_30", dataVersion: "3.30", catalog: [{
      id: "pob:actors", domain: "actor", kind: "currentBuild", available: true,
      data: { actors: [{ id: "actor:minion:zombie", kind: "minion" }] },
    }] });
    expect(result.appliedAdapterIds).not.toContain("actor-native@1");
  });

  it("applies native actor projection to the ruthless 3.29 ruleset", () => {
    const registry = createDefaultMechanicAdapterRegistry();
    const catalog = [{
      id: "pob:actors", domain: "actor" as const, kind: "currentBuild", available: true,
      data: { actors: [{ id: "actor:minion:zombie", kind: "minion" }] },
    }];
    const result = registry.apply(
      DomainGraph.fromCatalog(catalog),
      { ruleset: "3_29_ruthless", dataVersion: "3.29", catalog },
    );
    expect(result.appliedAdapterIds).toContain("actor-native@1");
    expect(result.graph.hasNode("actor:minion:zombie")).toBe(true);
  });
});
