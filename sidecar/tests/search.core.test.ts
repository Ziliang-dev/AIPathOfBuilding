import { describe, expect, it } from "vitest";
import { ObjectiveSpecSchema, SCHEMA_VERSION, type Candidate } from "../src/schemas.js";
import {
  AdapterRegistry,
  ParetoFrontier,
  buildProgressionDag,
  candidateFromSchema,
  canonicalHash,
  canonicalStringify,
  createFullDomainRegistry,
  createSearchCacheKey,
  evaluateConstraints,
  objectiveFromSchema,
  selectCandidates,
  type DomainSearchState,
  type EvaluatedCandidate,
  type SearchObjective,
} from "../src/search/index.js";

const scenarios = ["mapping", "standardBoss", "pinnacle", "uber"] as const;

const objective: SearchObjective = {
  primaryMetric: "dps",
  primaryScenario: "mapping",
  scenarioWeights: { mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 },
  metrics: [
    { key: "dps", direction: "maximize", role: "offence" },
    { key: "ehp", direction: "maximize", role: "defence" },
  ],
  hardConstraints: [{ id: "survive", metric: "ehp", operator: "gte", value: 100 }],
};

function candidate(id: string, dps: number, ehp: number): EvaluatedCandidate {
  return {
    id,
    baseFingerprint: "build",
    actions: [],
    metricsByScenario: Object.fromEntries(scenarios.map((scenario) => [scenario, { dps, ehp }])),
  };
}

describe("search canonicalization", () => {
  it("is independent of object insertion order and rejects cycles", () => {
    expect(canonicalStringify({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalHash({ a: 1, b: 2 })).toBe(canonicalHash({ b: 2, a: 1 }));
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow(/cycles/u);
    const keyBase = {
      engineCommit: "commit",
      ruleset: "3.29",
      buildFingerprint: "build",
      scenario: "mapping",
      objectiveVersion: 1,
    };
    expect(createSearchCacheKey({ ...keyBase, actions: [{ id: "b" }, { id: "a" }] }))
      .toBe(createSearchCacheKey({ ...keyBase, actions: [{ id: "a" }, { id: "b" }] }));
  });
});

describe("constraints and Pareto", () => {
  it("checks every sustainable scenario and excludes infeasible candidates", () => {
    const failing = candidate("failing", 200, 99);
    const result = evaluateConstraints(failing, objective.hardConstraints, scenarios);
    expect(result.satisfied).toBe(false);
    expect(result.violations).toHaveLength(4);

    const frontier = new ParetoFrontier(objective, scenarios);
    expect(frontier.add(failing)).toBe(false);
    frontier.addAll([candidate("balanced", 150, 150), candidate("offence", 200, 110), candidate("dominated", 100, 100)]);
    expect(frontier.values().map((entry) => entry.id)).toEqual(["balanced", "offence"]);
  });

  it("selects stable offence, balanced and worst-case defence candidates", () => {
    const entries = [candidate("offence", 300, 100), candidate("balanced", 220, 220), candidate("defence", 100, 400)];
    const selected = selectCandidates(entries, objective, scenarios);
    expect(selected.offence?.id).toBe("offence");
    expect(selected.balanced?.id).toBe("balanced");
    expect(selected.defence?.id).toBe("defence");
  });
});

describe("public schema adapters", () => {
  it("uses ObjectiveSpec and Candidate contracts", () => {
    const publicObjective = ObjectiveSpecSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      goals: [{ metric: "TotalDPS", direction: "maximize" }],
      hardConstraints: [{ metric: "Life", operator: ">=", value: 3000 }],
    });
    const internal = objectiveFromSchema(publicObjective);
    expect(internal.primaryMetric).toBe("TotalDPS");
    expect(internal.hardConstraints[0]?.operator).toBe("gte");

    const publicCandidate: Candidate = {
      schemaVersion: SCHEMA_VERSION,
      id: "candidate",
      label: "Balanced",
      summary: "Test",
      baseFingerprint: "build",
      cost: { divine: 0, display: "0 div" },
      metrics: {},
      scenarioMetrics: { mapping: {}, standardBoss: {}, pinnacle: {}, uber: {} },
      peakScenarioMetrics: { mapping: {}, standardBoss: {}, pinnacle: {}, uber: {} },
      actions: [],
      evidence: [],
      hardConstraintsSatisfied: true,
    };
    expect(candidateFromSchema(publicCandidate).id).toBe("candidate");
  });
});

describe("full-domain Adapter registry", () => {
  it("contains every domain and blocks external candidates without budget", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    expect(registry).toBeInstanceOf(AdapterRegistry);
    expect(registry.list()).toHaveLength(9);
    const external = registry.get("external");
    const state: DomainSearchState = {
      domainCandidates: {
        external: [{ id: "trade", baseFingerprint: "build", actions: [], metadata: { source: "trade" } }],
      },
    };
    const generated = await external.generate({
      state,
      seed: candidate("base", 1, 100),
      frontier: [],
      objective: {
        ...objective,
        candidatePolicy: {
          sources: { currentBuild: true, uniques: false, targetRares: false, trade: false },
        },
      },
      round: 1,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("rejects an external proposal unless it declares an enabled external source", async () => {
    const external = createFullDomainRegistry<DomainSearchState>().get("external");
    const context = {
      state: {
        domainCandidates: {
          external: [{ id: "missing-source", baseFingerprint: "build", actions: [{ id: "external-action" }] }],
        },
      },
      seed: candidate("base", 1, 100),
      frontier: [],
      objective: {
        ...objective,
        candidatePolicy: {
          budgetDivine: 10,
          sources: { currentBuild: true, uniques: true, targetRares: true, trade: true },
        },
      },
      round: 1,
      signal: new AbortController().signal,
    };
    expect(await external.generate(context)).toEqual([]);
  });

  it("does not treat a missing catalog source as currentBuild", async () => {
    const gear = createFullDomainRegistry<DomainSearchState>().get("gear");
    const generated = await gear.generate({
      state: {
        domainCandidates: {
          gear: [{
            id: "unknown-gear", baseFingerprint: "build", actions: [{ id: "unknown-action" }],
            metadata: { catalogId: "broker:unknown" },
          }],
        },
      },
      seed: candidate("base", 1, 100),
      frontier: [],
      objective: {
        ...objective,
        candidatePolicy: {
          budgetDivine: 10,
          sources: { currentBuild: true, uniques: true, targetRares: true, trade: true },
        },
      },
      round: 1,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("does not infer current-build actions from an untrusted catalog entry", async () => {
    const generated = await createFullDomainRegistry<DomainSearchState>().get("gear").generate({
      state: {
        contentCatalog: [{
          id: "broker:unknown",
          domain: "gear",
          kind: "proposal",
          available: true,
          data: { actionCandidates: [{ kind: "replaceItem", payload: { slot: "Helmet", itemId: 1 } }] },
        }],
      },
      seed: candidate("base", 1, 100),
      frontier: [],
      objective: {
        ...objective,
        candidatePolicy: {
          budgetDivine: 10,
          sources: { currentBuild: true, uniques: true, targetRares: true, trade: true },
        },
      },
      round: 1,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("enforces budget against cumulative cross-domain action cost", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const seed = {
      ...candidate("paid-seed", 1, 100),
      actions: [{ id: "first", costDivine: 4 }],
      estimatedCost: 4,
    };
    const generated = await registry.get("gear").generate({
      state: {
        domainCandidates: {
          gear: [{
            id: "second", baseFingerprint: "build",
            actions: [{ id: "second", costDivine: 3 }], estimatedCost: 3,
            metadata: { source: "currentBuild" },
          }],
        },
      },
      seed,
      frontier: [],
      objective: {
        ...objective,
        candidatePolicy: {
          budgetDivine: 5,
          sources: { currentBuild: true, uniques: false, targetRares: false, trade: false },
        },
      },
      round: 1,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("enforces budget before admitting an enabled paid source", async () => {
    const generated = await createFullDomainRegistry<DomainSearchState>().get("gear").generate({
      state: {
        domainCandidates: {
          gear: [{
            id: "expensive-unique", baseFingerprint: "build",
            actions: [{ id: "expensive-action", costDivine: 12 }], estimatedCost: 12,
            metadata: { source: "unique" },
          }],
        },
      },
      seed: candidate("base", 1, 100),
      frontier: [],
      objective: {
        ...objective,
        candidatePolicy: {
          budgetDivine: 10,
          sources: { currentBuild: true, uniques: true, targetRares: false, trade: false },
        },
      },
      round: 1,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("rejects candidates touching objective locks", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const identity = registry.get("identity");
    const state: DomainSearchState = {
      domainCandidates: {
        identity: [
          { id: "locked", baseFingerprint: "build", actions: [], metadata: { source: "currentBuild", touches: ["identity.class"], absolute: true } },
          { id: "allowed", baseFingerprint: "build", actions: [], metadata: { source: "currentBuild", touches: ["identity.bandit"], absolute: true } },
        ],
      },
    };
    const generated = await identity.generate({
      state,
      seed: candidate("base", 1, 100),
      frontier: [],
      objective: {
        ...objective,
        candidatePolicy: {
          sources: { currentBuild: true, uniques: false, targetRares: false, trade: false },
          locks: { class: true, ascendancy: true, mainSkill: true, fields: [] },
        },
      },
      round: 1,
      signal: new AbortController().signal,
    });
    expect(generated.map((entry) => entry.id)).toEqual(["allowed"]);
  });

  it("uses Domain Graph conflicts to reject incompatible candidate packages", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const generated = await registry.get("config").generate({
      state: {
        domainCandidates: {
          config: [{
            id: "stance-b", baseFingerprint: "build", actions: [],
            metadata: { catalogId: "stance:b", absolute: true },
          }],
        },
        domainGraph: {
          nodes: [
            { id: "stance:a", domain: "config", kind: "condition", data: { active: true, available: true } },
            { id: "stance:b", domain: "config", kind: "condition", data: { available: true } },
          ],
          edges: [{ from: "stance:a", to: "stance:b", relation: "conflicts", data: {} }],
        },
      },
      seed: candidate("base", 1, 100),
      frontier: [], objective, round: 1,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("requires active Domain Graph dependencies for candidate packages", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const generate = async (requiredCurrent: boolean) => registry.get("skills").generate({
      state: {
        domainCandidates: {
          skills: [{
            id: "triggered-skill", baseFingerprint: "build", actions: [],
            metadata: { catalogId: "skill:triggered", absolute: true },
          }],
        },
        domainGraph: {
          nodes: [
            { id: "skill:triggered", domain: "skills", kind: "active", data: { available: true } },
            { id: "gear:trigger", domain: "gear", kind: "item", data: { available: true, current: requiredCurrent } },
          ],
          edges: [{ from: "skill:triggered", to: "gear:trigger", relation: "requires", data: {} }],
        },
      },
      seed: candidate("base", 1, 100),
      frontier: [], objective, round: 1,
      signal: new AbortController().signal,
    });
    expect(await generate(false)).toEqual([]);
    expect((await generate(true)).map(({ id }) => id)).toEqual(["triggered-skill"]);
  });

  it("derives lock touches from canonical action payloads", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const generated = await registry.get("identity").generate({
      state: {
        domainCandidates: {
          identity: [{
            id: "class-change", baseFingerprint: "build",
            actions: [{ kind: "setIdentity", payload: { property: "class", value: "Witch" } }],
          }],
        },
      },
      seed: candidate("base", 1, 100), frontier: [], round: 1,
      objective: {
        ...objective,
        candidatePolicy: {
          sources: { currentBuild: true, uniques: false, targetRares: false, trade: false },
          locks: { class: true, ascendancy: false, mainSkill: false, fields: [] },
        },
      },
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("derives typed gear, link, config and tree actions from normalized Lua inputs", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const state: DomainSearchState = {
      scenarioSpecs: scenarios.map((id) => ({
        id,
        name: id,
        enemyIsBoss: id === "mapping" ? "None" as const
          : id === "standardBoss" ? "Boss" as const
            : id === "pinnacle" ? "Pinnacle" as const
              : "Uber" as const,
        profile: "sustainable" as const,
        mapModifiers: [], allowedEvents: [], assumptions: {},
      })),
      evidence: scenarios.map((scenario) => ({
        condition: "conditionOnslaught",
        configKey: "conditionOnslaught",
        value: true,
        scenario,
        profile: "sustainable" as const,
        status: "proven_sustainable" as const,
        sources: ["fixture"], triggerChain: ["always"], conflictsWith: [], confidence: 1,
        reason: "fixture proof",
      })),
      contentCatalog: [{
        id: "pob:tree",
        domain: "tree",
        kind: "currentBuild",
        available: true,
        data: { pointBudget: { remainingPassive: 10, remainingAscendancy: 4 } },
      }],
      proposalInputs: {
        gear: [{ id: "helm", slot: "Helmet", itemId: 42 }],
        links: [{ id: "links", group: 1, gems: ["Fireball", "Spell Echo"] }],
        config: [{ id: "onslaught", name: "conditionOnslaught", value: true }],
        tree: [{ id: "tree", nodeIds: [1, 2] }],
      },
    };
    const seed = candidate("base", 1, 100);
    const context = { state, seed, frontier: [], objective, round: 1, signal: new AbortController().signal };
    const generated = await Promise.all([
      registry.get("gear").generate(context),
      registry.get("skills").generate(context),
      registry.get("config").generate(context),
      registry.get("tree").generate(context),
    ]);
    const actions = generated.flat().flatMap((entry) => entry.actions) as { kind: string; dependsOn: string[]; payload: Record<string, unknown> }[];
    expect(actions.map((entry) => entry.kind)).toEqual(["replaceItem", "replaceSkillLinks", "setConfig", "setTree", "setTree"]);
    expect(actions.every(luaCanonicalActionAccepts)).toBe(true);
    expect(actions.at(-1)?.dependsOn).toEqual([expect.stringContaining(":node:0")]);
  });

  it("rejects config actions without four-scenario sustainable evidence", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const generated = await registry.get("config").generate({
      state: { proposalInputs: { config: [{ id: "fake-buff", name: "conditionOnslaught", value: true }] } },
      seed: candidate("base", 1, 100),
      frontier: [], objective, round: 1,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("rejects passive paths that exceed the exported point budget", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const generated = await registry.get("tree").generate({
      state: { contentCatalog: [{
        id: "pob:tree",
        domain: "tree",
        kind: "currentBuild",
        available: true,
        data: {
          pointBudget: { remainingPassive: 1, remainingAscendancy: 0 },
          connectable: [{ id: 12, path: [11, 12], pointCost: 2, pointPool: "passive" }],
        },
      }] },
      seed: candidate("base", 1, 100),
      frontier: [], objective, round: 1,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("rejects cumulative tree packages that exceed remaining points", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const state: DomainSearchState = {
      contentCatalog: [{
        id: "pob:tree",
        domain: "tree",
        kind: "currentBuild",
        available: true,
        data: {
          pointBudget: { remainingPassive: 2, remainingAscendancy: 0 },
          connectable: [{ id: 13, path: [12, 13], pointCost: 2, pointPool: "passive" }],
        },
      }],
    };
    const seed = {
      ...candidate("seed", 1, 100),
      actions: [{
        id: "existing-tree-action",
        kind: "setTree",
        payload: { nodeId: 11, allocated: true, pointPool: "passive" },
      }],
    };
    const generated = await registry.get("tree").generate({
      state, seed, frontier: [], objective, round: 2,
      signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("does not append an inferred action ID already present in a beam seed", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const state: DomainSearchState = {
      proposalInputs: { gear: [{ id: "helm", slot: "Helmet", itemId: 42 }] },
    };
    const seed = {
      ...candidate("seed", 1, 100),
      actions: [{ id: "action:helm", kind: "replaceItem" }],
    };
    const generated = await registry.get("gear").generate({
      state, seed, frontier: [], objective, round: 2, signal: new AbortController().signal,
    });
    expect(generated).toEqual([]);
  });

  it("composes explicit domain action deltas onto the current coordinate seed", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const seed = { ...candidate("seed", 1, 100), actions: [{ id: "first", kind: "setConfig" }] };
    const state: DomainSearchState = {
      contentCatalog: [{
        id: "pob:tree",
        domain: "tree",
        kind: "currentBuild",
        available: true,
        data: { pointBudget: { remainingPassive: 2, remainingAscendancy: 0 } },
      }],
      domainCandidates: {
        tree: [{ id: "delta", baseFingerprint: "stale", actions: [{
          id: "second",
          kind: "setTree",
          payload: { nodeId: 11, allocated: true, pointPool: "passive" },
        }] }],
      },
    };
    const first = await registry.get("tree").generate({
      state, seed, frontier: [], objective, round: 1, signal: new AbortController().signal,
    });
    expect(first[0]?.actions).toEqual([seed.actions[0], {
      id: "second",
      kind: "setTree",
      payload: { nodeId: 11, allocated: true, pointPool: "passive" },
    }]);
    expect(first[0]?.baseFingerprint).toBe("build");
    expect(first[0]?.parentIds).toEqual(["seed"]);
    const repeated = await registry.get("tree").generate({
      state,
      seed: { ...seed, id: first[0]?.id ?? "missing", actions: first[0]?.actions ?? [] },
      frontier: [], objective, round: 2, signal: new AbortController().signal,
    });
    expect(repeated).toEqual([]);
  });

  it("consumes aggregate Lua ContentCatalog fixtures", async () => {
    const registry = createFullDomainRegistry<DomainSearchState>();
    const state: DomainSearchState = {
      scenarioSpecs: scenarios.map((id) => ({
        id,
        name: id,
        enemyIsBoss: id === "mapping" ? "None" as const
          : id === "standardBoss" ? "Boss" as const
            : id === "pinnacle" ? "Pinnacle" as const
              : "Uber" as const,
        profile: "sustainable" as const,
        mapModifiers: [], allowedEvents: [], assumptions: {},
      })),
      evidence: scenarios.map((scenario) => ({
        condition: "conditionOnslaught",
        configKey: "conditionOnslaught",
        scenario,
        profile: "sustainable" as const,
        status: "proven_sustainable" as const,
        sources: ["item:1"], triggerChain: ["always"], conflictsWith: [], confidence: 1,
        reason: "Permanent source sustains it",
      })),
      contentCatalog: [
        { id: "pob:items", domain: "gear", kind: "currentBuild", available: true, data: {
          actionCandidates: [{ kind: "replaceItem", payload: { slot: "Helmet", itemId: 7, itemSetId: 1 } }],
        } },
        { id: "pob:skills", domain: "skills", kind: "currentBuild", available: true, data: {
          groups: [{ index: 1, gems: [
            {
              name: "Fireball", level: 17, quality: 12, qualityId: "Divergent",
              enabled: false, count: 2, skillPart: 3, skillStage: 4,
              includeInFullDPS: true, enableGlobal1: false, enableGlobal2: true,
            },
            { name: "Added Fire Damage", level: 19, quality: 7, enabled: true, count: 1 },
          ] }],
          availableGems: [{ id: "Metadata/Items/Gems/SupportGemSpellEcho", grantedEffectId: "SupportSpellEcho", name: "Spell Echo", support: true }],
          nativeLinkProbe: {
            schemaVersion: 1, complete: true, truncated: false,
            engineVersion: "test", dataVersion: "3_29", probeFingerprint: "probe:test",
            groups: [{
              index: 1, capacity: 2, gems: [], activeSkills: [], currentSupports: [],
              supports: [{
                id: "Metadata/Items/Gems/SupportGemSpellEcho#SupportSpellEcho",
                gemId: "Metadata/Items/Gems/SupportGemSpellEcho",
                grantedEffectId: "SupportSpellEcho", acceptedBy: [1], acceptedByIds: ["Fireball"], available: true,
              }],
            }],
          },
        } },
        { id: "pob:config", domain: "config", kind: "currentBuild", available: true, data: {
          conditionClaims: [{ condition: "conditionOnslaught", current: false }],
        } },
        { id: "pob:tree", domain: "tree", kind: "currentBuild", available: true, data: {
          pointBudget: { remainingPassive: 10, remainingAscendancy: 4 },
          connectable: [{ id: 12, path: [10, 11], pointCost: 2, pointPool: "passive" }],
          masteryCandidates: [{ nodeId: 20, effectId: 200, path: [19, 20], pointCost: 2, pointPool: "passive" }],
        } },
      ],
    };
    const seed = candidate("base", 1, 100);
    const context = { state, seed, frontier: [], objective, round: 1, signal: new AbortController().signal };
    const candidates = (await Promise.all([
      registry.get("gear").generate(context),
      registry.get("skills").generate(context),
      registry.get("config").generate(context),
      registry.get("tree").generate(context),
    ])).flat();
    const actions = candidates.flatMap((entry) => entry.actions) as { kind: string; payload: Record<string, unknown> }[];
    expect(actions).toHaveLength(8);
    expect(actions.every(luaCanonicalActionAccepts)).toBe(true);
    const linkAction = actions.find((action) => action.kind === "replaceSkillLinks");
    expect((linkAction?.payload.gems as unknown[])[0]).toEqual({
      nameSpec: "Fireball", level: 17, quality: 12, qualityId: "Divergent",
      enabled: false, count: 2, skillPart: 3, skillStage: 4,
      includeInFullDPS: true, enableGlobal1: false, enableGlobal2: true,
    });
    expect((linkAction?.payload.gems as unknown[])[1]).toEqual({
      nameSpec: "Spell Echo", level: 20, quality: 0, enabled: true, count: 1,
    });
  });
});

function luaCanonicalActionAccepts(action: { kind: string; payload: Record<string, unknown> }): boolean {
  if (action.kind === "replaceItem") {
    return typeof action.payload.slot === "string"
      && Number.isInteger(action.payload.itemId)
      && (action.payload.itemId as number) >= 0;
  }
  if (action.kind === "replaceSkillLinks") {
    return Number.isInteger(action.payload.group)
      && (action.payload.group as number) >= 1
      && Array.isArray(action.payload.gems)
      && action.payload.gems.length > 0;
  }
  if (action.kind === "setConfig") return typeof action.payload.name === "string" && action.payload.name.length > 0;
  if (action.kind === "setTree") {
    return Number.isInteger(action.payload.nodeId)
      && (action.payload.nodeId as number) >= 1
      && (typeof action.payload.allocated === "boolean" || Number.isInteger(action.payload.effectId));
  }
  return false;
}

describe("progression DAG", () => {
  it("infers dependencies and assigns budget milestones", () => {
    const plan = buildProgressionDag([
      { id: "links", description: "links", costDivine: 2, provides: ["six-link"] },
      { id: "gem", description: "gem", costDivine: 1, requires: ["six-link"] },
      { id: "tree", description: "tree", costDivine: 0 },
    ], [1, 5]);
    expect(plan.steps.map((step) => step.action.id)).toEqual(["tree", "links", "gem"]);
    expect(plan.edges).toContainEqual({ from: "links", to: "gem" });
    expect(plan.totalCostDivine).toBe(3);
    expect(plan.steps[2]?.milestone).toBe(5);
  });

  it("rejects cycles", () => {
    expect(() => buildProgressionDag([
      { id: "a", description: "a", dependsOn: ["b"] },
      { id: "b", description: "b", dependsOn: ["a"] },
    ])).toThrow(/cycle/u);
  });
});
