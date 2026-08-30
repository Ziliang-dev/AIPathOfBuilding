import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import type { ModelAdapter, ModelTurnInput, ModelTurnResult } from "../src/llm/types.js";
import {
  MechanicUnderstandingEngine,
  auditMechanicReport,
} from "../src/mechanics/engine.js";
import {
  MechanicExperimentSchema,
  compileMechanicExperiments,
  diffMechanicObservations,
  type MechanicExperiment,
  type MechanicExperimentResult,
  type MechanicExperimentRunner,
} from "../src/mechanics/experiments.js";
import { extractMechanicFacts } from "../src/mechanics/facts.js";
import {
  MechanicToolDispatcher,
  type MechanicToolName,
} from "../src/mechanics/tools.js";
import {
  BuildActionSchema,
  type BuildSnapshot,
  type MechanicContext,
  type MechanicObservation,
} from "../src/schemas.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

function snapshot(): BuildSnapshot {
  return {
    schemaVersion: 4,
    xml: "<PathOfBuilding/>",
    fingerprint: "golden-build",
    engineVersion: "test-engine",
    dataVersion: "3_29",
    ruleset: "3_29",
    metrics: { FullDPS: 100 }, config: {}, buildState: {}, gameplayFieldPaths: ["Build.level"],
    mechanicProjectionFingerprint: HASH_A,
    mechanicProjection: {
      version: 1,
      inventory: { version: 1, sections: ["explicit"], lineFlags: [], sourceFamilies: [] },
      items: [{
        id: "1", name: "Golden Gloves", equipped: true, active: true, references: [], state: {},
        legality: { version: 1, status: "valid", findings: [] },
        modifierLines: [{
          id: "item:1:explicit:1", section: "explicit", ordinal: 1,
          rawText: "30% more Damage over Time", active: true, disabled: false,
          flags: [], modTags: [], parseStatus: "parsed",
          provenance: { sourceFamily: "explicit", sourceTable: "mods", sourceModId: "GoldenDot", resolution: "exact", evidence: ["mods:GoldenDot"] },
          parsedMods: [{ name: "Damage", type: "MORE", classification: "numeric", value: 30, flags: 0, keywordFlags: 0, tags: [] }],
        }],
      }],
      modifierCount: 1, activeModifierCount: 1, unresolvedModifierCount: 0,
      descriptions: { entries: [], truncated: false }, fingerprint: HASH_A,
    },
    contentCatalog: [
      { id: "pob:skills", domain: "skills", kind: "currentBuild", available: true, data: { nativeLinkProbe: { complete: true, truncated: false, groups: [] } } },
      { id: "pob:items", domain: "gear", kind: "currentBuild", available: true, data: { truncated: false } },
      { id: "pob:tree", domain: "tree", kind: "currentBuild", available: true, data: { allocated: [], truncated: false } },
      { id: "pob:actors", domain: "actor", kind: "currentBuild", available: true, data: { actorSeason: { actors: [], season: {} }, truncated: false } },
      { id: "pob:config", domain: "config", kind: "currentBuild", available: true, data: { conditionClaims: [], truncated: false } },
      { id: "pob:loadouts", domain: "progression", kind: "currentBuild", available: true, data: { itemSetIds: [1, 2], activeItemSetId: 1, treeSpecIds: [1], activeTreeSpecId: 1, skillSetIds: [1], activeSkillSetId: 1, truncated: false } },
    ],
  };
}

function observation(context: MechanicContext, diagnostic = false): MechanicObservation {
  return {
    context,
    fingerprint: diagnostic ? HASH_C : HASH_B,
    projectionFingerprint: HASH_A,
    nativeProbeFingerprint: HASH_B,
    evidenceFingerprint: HASH_C,
    metrics: { FullDPS: diagnostic ? 70 : 100 },
    skills: [], conditions: [], activeItemIds: ["1"],
    activeModifierIds: diagnostic ? [] : ["item:1:explicit:1"],
    activePassiveIds: [], configValues: {}, resources: {}, cooldowns: {}, durations: {},
    contributions: { FullDPS: diagnostic ? 70 : 100 },
  };
}

function toolCall(id: string, name: MechanicToolName, args: unknown) {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}

class ScriptedAdapter implements ModelAdapter<MechanicToolName> {
  callsUsed = 0;
  callsRemaining = 16;
  readonly #modifierIds: string[];
  readonly #itemIds: string[];
  readonly #metricIds: string[];
  readonly #criticVerdict: "complete" | "repair";
  readonly #extraInspectionIds: string[];
  readonly callsByPhase = new Map<string, number>();

  constructor(
    modifierIds: string[],
    metricIds: string[],
    criticVerdict: "complete" | "repair" = "complete",
    extraInspectionIds: string[] = [],
  ) {
    this.#modifierIds = modifierIds;
    this.#itemIds = modifierIds.map((id) => id.split(":").slice(0, -2).join(":"));
    this.#metricIds = metricIds;
    this.#criticVerdict = criticVerdict;
    this.#extraInspectionIds = extraInspectionIds;
  }

  async complete(input: ModelTurnInput): Promise<ModelTurnResult<MechanicToolName>> {
    this.callsUsed += 1;
    this.callsRemaining -= 1;
    const phase = String((input.context as { phase?: string } | undefined)?.phase ?? "unknown");
    const call = (this.callsByPhase.get(phase) ?? 0) + 1;
    this.callsByPhase.set(phase, call);
    if (phase === "critic") {
      return call === 1
        ? { kind: "message", content: "", toolCalls: [toolCall("proofs", "inspect_mechanic_proofs", { cursor: 0, limit: 100 })] }
        : { kind: "message", content: "", toolCalls: [toolCall("review", "submit_mechanic_review", {
            verdict: this.#criticVerdict, missingEntityIds: [], conflictingClaimIds: [], invalidProofIds: [],
            summary: this.#criticVerdict === "complete"
              ? "All local facts and counterfactuals verified."
              : "The critic still requires repair.",
          })] };
    }
    if (call === 1) {
      return { kind: "message", content: "", toolCalls: [toolCall("inspect", "inspect_mechanic_entity", {
        entityIds: [...this.#itemIds, ...this.#modifierIds, ...this.#extraInspectionIds],
      })] };
    }
    const itemClaims = this.#itemIds.map((sourceId, index) => ({
      sourceId, relation: "grants" as const, targetId: this.#modifierIds[index],
      context: sourceId.startsWith("weaponSet1:") ? "weaponSet1" as const : "weaponSet2" as const,
      statement: "The active item structurally grants its exact projected modifier line.", evidenceIds: [sourceId],
    }));
    const mechanicClaims = this.#modifierIds.map((sourceId, index) => ({
      sourceId, relation: "scales" as const, targetId: this.#metricIds[index],
      context: sourceId.startsWith("weaponSet1:") ? "weaponSet1" as const : "weaponSet2" as const,
      statement: "The exact glove modifier scales Full DPS.", evidenceIds: [sourceId],
    }));
    const claims = [...itemClaims, ...mechanicClaims];
    return { kind: "message", content: "", toolCalls: [toolCall("claims", "submit_mechanic_claims", { claims, complete: true })] };
  }
}

class FixtureRunner implements MechanicExperimentRunner {
  observeCalls = 0;
  experimentsRun = 0;

  async observe(_snapshot: BuildSnapshot, context: MechanicContext): Promise<MechanicObservation> {
    this.observeCalls += 1;
    return observation(context);
  }

  async run(_snapshot: BuildSnapshot, experiments: readonly MechanicExperiment[]): Promise<readonly MechanicExperimentResult[]> {
    this.experimentsRun += experiments.length;
    return experiments.map((experiment) => ({
      experimentId: experiment.id, ...(experiment.claimId === undefined ? {} : { claimId: experiment.claimId }), context: experiment.context,
      baseline: observation(experiment.context), diagnostic: observation(experiment.context, true),
    }));
  }
}

class StandaloneConditionRunner extends FixtureRunner {
  override async observe(_snapshot: BuildSnapshot, context: MechanicContext): Promise<MechanicObservation> {
    this.observeCalls += 1;
    return {
      ...observation(context),
      configValues: { enemyIsBoss: "None" },
      conditions: [{
        id: "player:Combat",
        actor: "player",
        value: true,
        sources: [],
        dependencies: ["dependency:player:Combat:Config:1"],
      }],
    };
  }
}

class TransformingRunner extends FixtureRunner {
  readonly #transform: (result: MechanicExperimentResult, index: number) => MechanicExperimentResult;

  constructor(transform: (result: MechanicExperimentResult, index: number) => MechanicExperimentResult) {
    super();
    this.#transform = transform;
  }

  override async run(snapshot: BuildSnapshot, experiments: readonly MechanicExperiment[]): Promise<readonly MechanicExperimentResult[]> {
    const results = await super.run(snapshot, experiments);
    return results.map(this.#transform);
  }
}

class DuplicateResultRunner extends FixtureRunner {
  override async run(snapshot: BuildSnapshot, experiments: readonly MechanicExperiment[]): Promise<readonly MechanicExperimentResult[]> {
    const results = await super.run(snapshot, experiments);
    const first = results[0];
    return first === undefined ? results : [...results, first];
  }
}

class FailOnceAdapter implements ModelAdapter<MechanicToolName> {
  readonly #inner: ModelAdapter<MechanicToolName>;
  failed = false;

  constructor(inner: ModelAdapter<MechanicToolName>) {
    this.#inner = inner;
  }

  get callsUsed() { return this.#inner.callsUsed + (this.failed ? 1 : 0); }
  get callsRemaining() { return this.#inner.callsRemaining; }

  async complete(input: ModelTurnInput, signal?: AbortSignal): Promise<ModelTurnResult<MechanicToolName>> {
    if (!this.failed) {
      this.failed = true;
      return { kind: "fallback", signal: {
        type: "deterministic_fallback", reason: "provider_unavailable", detail: "temporary outage", retryable: true,
      } };
    }
    return this.#inner.complete(input, signal);
  }
}

describe("MechanicUnderstandingEngine", () => {
  it("extracts stable complete facts for both weapon contexts and inventory-only saved sets", () => {
    const build = snapshot();
    const observations = { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") };
    const first = extractMechanicFacts(build, observations);
    const second = extractMechanicFacts(build, observations);
    expect(first).toEqual(second);
    expect(first.complete).toBe(true);
    expect(first.contexts).toEqual(["weaponSet1", "weaponSet2"]);
    expect(first.entities.filter(({ kind }) => kind === "modifierLine")).toHaveLength(2);
    expect(first.inventory.inactiveItemSetIds).toEqual(["2"]);
  });

  it("marks unavailable and generically truncated local catalogs incomplete", () => {
    const build = snapshot();
    const changed = {
      ...build,
      contentCatalog: build.contentCatalog?.map((entry) => entry.id === "pob:items"
        ? { ...entry, available: false, data: { ...entry.data, truncated: true } }
        : entry),
    };
    const facts = extractMechanicFacts(changed, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    expect(facts.complete).toBe(false);
    expect(facts.missingScopes).toContain("pob:items");
    expect(facts.truncatedScopes).toContain("pob:items");
  });

  it("requires detail inspection and rejects unknown claim evidence", async () => {
    const facts = extractMechanicFacts(snapshot(), { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const session = { phase: "analyst" as const, facts, proofs: [], existingClaims: [], inspectedEntityIds: new Set<string>() };
    const dispatcher = new MechanicToolDispatcher();
    await dispatcher.execute(toolCall("list", "list_mechanic_entities", { cursor: 0, limit: 200 }), session);
    expect(session.inspectedEntityIds.size).toBe(0);
    const modifier = facts.entities.find(({ kind }) => kind === "modifierLine")!;
    await dispatcher.execute(toolCall("inspect", "inspect_mechanic_entity", { entityIds: [modifier.id] }), session);
    expect(session.inspectedEntityIds.has(modifier.id)).toBe(true);
    const result = await dispatcher.execute(toolCall("claims", "submit_mechanic_claims", { complete: true, claims: [{
      sourceId: modifier.id, relation: "scales", targetId: facts.entities.find(({ kind, context }) => kind === "metric" && context === modifier.context)?.id,
      context: modifier.context, statement: "test", evidenceIds: ["invented-evidence"],
    }] }), session);
    expect(result).toMatchObject({ ok: false, output: { error: expect.stringContaining("unknown_evidence") } });
  });

  it("forbids semantic claims against inactive inventory-only entities", async () => {
    const inactiveObservation = (context: MechanicContext): MechanicObservation => ({
      ...observation(context), activeItemIds: [], activeModifierIds: [],
    });
    const facts = extractMechanicFacts(snapshot(), {
      weaponSet1: inactiveObservation("weaponSet1"),
      weaponSet2: inactiveObservation("weaponSet2"),
    });
    const source = facts.entities.find(({ kind, context }) => kind === "modifierLine" && context === "weaponSet1")!;
    const target = facts.entities.find(({ kind, context }) => kind === "metric" && context === "weaponSet1")!;
    const session = { phase: "analyst" as const, facts, proofs: [], existingClaims: [], inspectedEntityIds: new Set([source.id]) };
    const result = await new MechanicToolDispatcher().execute(toolCall("claims", "submit_mechanic_claims", {
      complete: true,
      claims: [{
        sourceId: source.id, relation: "scales", targetId: target.id, context: "weaponSet1",
        statement: "inactive inventory must remain inventory only", evidenceIds: [source.id],
      }],
    }), session);
    expect(result).toMatchObject({ ok: false, output: { error: "inactive_entity_relation_forbidden" } });
  });

  it("binds item-granted skills and supports to each worker-observed weapon context", () => {
    const build = snapshot();
    const itemGrant = {
      id: "2", name: "Weapon-set 2 grant", equipped: true, active: false, references: [], state: {},
      legality: { version: 1 as const, status: "valid" as const, findings: [] },
      modifierLines: [{
        id: "item:2:explicit:1", section: "explicit" as const, ordinal: 1,
        rawText: "Grants Death Aura and Item Support", active: false, disabled: false,
        flags: [], modTags: [], parseStatus: "parsed" as const,
        provenance: { sourceFamily: "explicit", sourceTable: "mods", sourceModId: "Set2Grant", resolution: "exact" as const, evidence: ["mods:Set2Grant"] },
        parsedMods: [
          { name: "ExtraSkill", type: "LIST", classification: "structured" as const, value: { skillId: "DeathAura", skillName: "Death Aura" }, flags: 0, keywordFlags: 0, tags: [] },
          { name: "ExtraSupport", type: "LIST", classification: "structured" as const, value: { skillId: "ItemSupport", skillName: "Item Support" }, flags: 0, keywordFlags: 0, tags: [] },
        ],
      }],
    };
    const set2Observation: MechanicObservation = {
      ...observation("weaponSet2"),
      activeItemIds: ["2"],
      activeModifierIds: ["item:2:explicit:1"],
      skills: [{
        id: "DeathAura", name: "Death Aura", group: 1, enabled: true, includeInFullDps: true, fromItem: true,
        supports: [{ id: "ItemSupport", name: "Item Support", fromItem: true }],
      }],
    };
    const facts = extractMechanicFacts({
      ...build,
      mechanicProjection: {
        ...build.mechanicProjection,
        items: [...build.mechanicProjection.items, itemGrant],
        modifierCount: 2,
      },
    }, { weaponSet1: observation("weaponSet1"), weaponSet2: set2Observation });
    const skill = facts.entities.find(({ kind, context }) => kind === "skill" && context === "weaponSet2")!;
    const support = facts.entities.find(({ kind, context }) => kind === "support" && context === "weaponSet2")!;
    expect(skill.data.sourceModifier).toMatchObject({ itemId: "2", section: "explicit", ordinal: 1 });
    expect(support.data.sourceModifier).toMatchObject({ itemId: "2", section: "explicit", ordinal: 1 });
  });

  it("compiles worker-only interventions and cannot parse them as BuildAction", () => {
    const facts = extractMechanicFacts(snapshot(), { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const source = facts.entities.find(({ kind, context }) => kind === "modifierLine" && context === "weaponSet1")!;
    const target = facts.entities.find(({ kind, context }) => kind === "metric" && context === "weaponSet1")!;
    const compiled = compileMechanicExperiments(facts, [{
      id: "claim:test", sourceId: source.id, relation: "scales", targetId: target.id,
      context: "weaponSet1", statement: "test", evidenceIds: [source.id], critical: true, ambiguous: false, effectState: "active",
    }]);
    expect(compiled[0]?.experiment?.intervention).toEqual({ kind: "suppress_item_modifier", itemId: "1", section: "explicit", ordinal: 1 });
    expect(MechanicExperimentSchema.safeParse(compiled[0]?.experiment).success).toBe(true);
    expect(BuildActionSchema.safeParse(compiled[0]?.experiment).success).toBe(false);
  });

  it("records intervention structure without treating source removal as mechanic contribution", () => {
    const baseline = observation("weaponSet1");
    const diagnostic = { ...observation("weaponSet1", true), metrics: baseline.metrics, contributions: baseline.contributions };
    const delta = diffMechanicObservations(baseline, diagnostic);
    expect(delta.changed).toBe(true);
    expect(delta.contributionChanged).toBe(false);
    expect(delta.metricChanges).toEqual({});
    expect(delta.removedModifierIds).toEqual(["item:1:explicit:1"]);
  });

  it("scopes Support deltas to the affected skill when another skill keeps the same Support", () => {
    const baseline: MechanicObservation = {
      ...observation("weaponSet1"),
      skills: [
        { id: "DeathAura", name: "Death Aura", group: 1, enabled: true, includeInFullDps: false, fromItem: true, supports: [{ id: "SupportLifetap", name: "Lifetap", fromItem: false }] },
        { id: "Blight", name: "Blight", group: 2, enabled: true, includeInFullDps: true, fromItem: false, supports: [{ id: "SupportLifetap", name: "Lifetap", fromItem: false }] },
      ],
    };
    const diagnostic: MechanicObservation = {
      ...baseline,
      fingerprint: HASH_C,
      skills: [
        { id: "DeathAura", name: "Death Aura", group: 1, enabled: true, includeInFullDps: false, fromItem: true, supports: [] },
        { id: "Blight", name: "Blight", group: 2, enabled: true, includeInFullDps: true, fromItem: false, supports: [{ id: "SupportLifetap", name: "Lifetap", fromItem: false }] },
      ],
    };
    const delta = diffMechanicObservations(baseline, diagnostic);
    expect(delta.contributionChanged).toBe(true);
    expect(delta.removedSupportIds).toEqual(["DeathAura:SupportLifetap"]);
  });

  it("compiles a cross-group effective Support to its exact source gem", () => {
    const build = snapshot();
    const withCrossGroup = {
      ...build,
      contentCatalog: build.contentCatalog?.map((entry) => entry.id === "pob:skills" ? {
        ...entry,
        data: { nativeLinkProbe: { complete: true, truncated: false, groups: [
          { index: 1, gems: [] },
          { index: 2, gems: [{ index: 1, support: true, grantedEffectId: "SupportLifetap" }] },
        ] } },
      } : entry),
    };
    const observed: MechanicObservation = {
      ...observation("weaponSet1"),
      skills: [{
        id: "DeathAura", name: "Death Aura", group: 1, enabled: true, includeInFullDps: false, fromItem: true,
        supports: [{ id: "SupportLifetap", name: "Lifetap", fromItem: false, sourceGroup: 2, sourceGem: 1 }],
      }],
    };
    const facts = extractMechanicFacts(withCrossGroup, { weaponSet1: observed, weaponSet2: observation("weaponSet2") });
    const source = facts.entities.find(({ kind }) => kind === "support")!;
    const target = facts.entities.find(({ kind, context }) => kind === "metric" && context === "weaponSet1")!;
    const compiled = compileMechanicExperiments(facts, [{
      id: "claim:cross-support", sourceId: source.id, relation: "scales", targetId: target.id,
      context: "weaponSet1", statement: "Lifetap supports Death Aura", evidenceIds: [source.id],
      critical: true, ambiguous: false, effectState: "active",
    }]);
    expect(source.data).toMatchObject({ group: 2, gem: 1 });
    expect(compiled[0]?.experiment?.intervention).toEqual({ kind: "suppress_support", group: 2, gem: 1 });
  });

  it("classifies a changed native contribution with capped final outputs as redundant", () => {
    const baseline = observation("weaponSet1");
    const diagnostic = {
      ...observation("weaponSet1", true),
      metrics: baseline.metrics,
      contributions: { FullDPS: 70 },
    };
    const delta = diffMechanicObservations(baseline, diagnostic);
    expect(delta.changed).toBe(true);
    expect(delta.contributionChanged).toBe(true);
    expect(delta.metricChanges).toEqual({});
    expect(delta.contributionChanges.FullDPS).toMatchObject({ before: 100, after: 70 });
  });

  it("blocks before any LLM call when a required Fact Bundle scope is missing", async () => {
    const build = snapshot();
    const incomplete = {
      ...build,
      contentCatalog: build.contentCatalog?.filter(({ id }) => id !== "pob:config"),
    };
    const adapter = new ScriptedAdapter([], []);
    const engine = new MechanicUnderstandingEngine({
      provider: adapter,
      providerDescriptor: { providerId: "test", endpoint: "local", model: "fixture", apiMode: "test", reasoningMode: "test" },
      worker: new FixtureRunner(),
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
    });
    const report = await engine.understand(incomplete, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/pob:config|Fact Bundle is incomplete/);
    expect(adapter.callsUsed).toBe(0);
  });

  it("requires coverage of active non-player Actors", async () => {
    const build = snapshot();
    const withMinion = {
      ...build,
      contentCatalog: build.contentCatalog?.map((entry) => entry.id === "pob:actors" ? {
        ...entry,
        data: {
          actorSeason: {
            actors: [
              { id: "actor:player", kind: "player", source: "Build" },
              { id: "actor:minion:Sentinel", kind: "minion", source: "Skills", name: "Sentinel", active: true },
            ],
            season: {},
            truncated: false,
          },
        },
      } : entry),
    };
    const facts = extractMechanicFacts(withMinion, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds),
      providerDescriptor: { providerId: "test", endpoint: "local", model: "actor-gap", apiMode: "test", reasoningMode: "test" },
      worker: new FixtureRunner(),
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
      maxRepairRounds: 0,
    });
    const report = await engine.understand(withMinion, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/actor:minion:Sentinel/);
  });

  it("blocks a critical experiment when only the intervention marker disappears", async () => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const runner = new TransformingRunner((result) => ({
      ...result,
      diagnostic: {
        ...result.diagnostic,
        metrics: result.baseline.metrics,
        contributions: result.baseline.contributions,
      },
    }));
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds),
      providerDescriptor: { providerId: "test", endpoint: "local", model: "zero-delta", apiMode: "test", reasoningMode: "test" },
      worker: runner,
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
      maxRepairRounds: 0,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("blocked");
    expect(report.proofs.filter(({ type }) => type === "counterfactual").every(({ status }) => status === "indeterminate")).toBe(true);
    expect(report.blockers.join(" ")).toMatch(/did not change the claimed target contribution/);
  });

  it("does not use an unrelated metric delta to prove the claimed target", async () => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const runner = new TransformingRunner((result) => ({
      ...result,
      diagnostic: {
        ...result.diagnostic,
        metrics: { ...result.baseline.metrics, Armour: 10 },
        contributions: { ...result.baseline.contributions, Armour: 10 },
      },
    }));
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds),
      providerDescriptor: { providerId: "test", endpoint: "local", model: "wrong-target", apiMode: "test", reasoningMode: "test" },
      worker: runner,
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
      maxRepairRounds: 0,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/did not change the claimed target contribution/);
  });

  it("keeps numeric source contribution proof when capped final metrics do not move", async () => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const runner = new TransformingRunner((result) => ({
      ...result,
      diagnostic: { ...result.diagnostic, metrics: result.baseline.metrics, contributions: { FullDPS: 70 } },
    }));
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds),
      providerDescriptor: { providerId: "test", endpoint: "local", model: "redundant", apiMode: "test", reasoningMode: "test" },
      worker: runner,
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("verified");
    expect(report.claims.filter(({ critical }) => critical).every(({ effectState }) => effectState === "redundant")).toBe(true);
    expect(report.proofs.filter(({ type }) => type === "counterfactual")
      .every(({ status, delta }) => status === "proven" && delta?.contributionChanged === true)).toBe(true);
  });

  it.each([
    ["mismatched experiment ID", (result: MechanicExperimentResult, index: number): MechanicExperimentResult =>
      index === 0 ? { ...result, experimentId: `stale:${result.experimentId}` } : result, /does not match/],
    ["stale baseline fingerprint", (result: MechanicExperimentResult, index: number): MechanicExperimentResult =>
      index === 0 ? { ...result, baseline: { ...result.baseline, fingerprint: HASH_A } } : result, /baseline fingerprint is stale/],
    ["cross-context diagnostic", (result: MechanicExperimentResult, index: number): MechanicExperimentResult =>
      index === 0 ? { ...result, diagnostic: {
        ...result.diagnostic,
        context: result.context === "weaponSet1" ? "weaponSet2" : "weaponSet1",
      } } : result, /diagnostic context/],
  ])("rejects worker proof with %s", async (_label, transform, blockerPattern) => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds),
      providerDescriptor: { providerId: "test", endpoint: "local", model: `invalid-${String(_label)}`, apiMode: "test", reasoningMode: "test" },
      worker: new TransformingRunner(transform),
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
      maxRepairRounds: 0,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(blockerPattern);
  });

  it("rejects duplicate Worker results for the same critical Claim", async () => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds),
      providerDescriptor: { providerId: "test", endpoint: "local", model: "duplicate-result", apiMode: "test", reasoningMode: "test" },
      worker: new DuplicateResultRunner(),
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
      maxRepairRounds: 0,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("blocked");
    expect(report.blockers.join(" ")).toMatch(/duplicate counterfactual results/);
  });

  it("runs analyst, PoB counterfactual, critic, exact cache, and proof-deletion fail closed", async () => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) => facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const adapter = new ScriptedAdapter(modifierIds, metricIds);
    const cache = new Map<string, unknown>();
    const engine = new MechanicUnderstandingEngine({
      provider: adapter,
      providerDescriptor: { providerId: "test", endpoint: "local", model: "fixture", apiMode: "test", reasoningMode: "test" },
      worker: new FixtureRunner(),
      store: { getCache: <T>(key: string) => cache.get(key) as T | undefined, setCache: (key, value) => { cache.set(key, value); } },
      checkpointer: false,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("verified");
    expect(report.claims).toHaveLength(4);
    expect(report.claims.filter(({ sourceId }) => sourceId.includes(":item:") && !sourceId.includes(":explicit:"))).toHaveLength(2);
    expect(report.proofs.filter(({ type }) => type === "counterfactual").every(({ status }) => status === "proven")).toBe(true);
    expect(report.proofs.filter(({ type }) => type === "native_exact").every(({ status }) => status === "proven")).toBe(true);
    const calls = adapter.callsUsed;
    const cached = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(cached.analysisFingerprint).toBe(report.analysisFingerprint);
    expect(adapter.callsUsed).toBe(calls);
    const audited = auditMechanicReport({ ...report, proofs: [] });
    expect(audited.status).toBe("blocked");
    expect(audited.blockers.join(" ")).toMatch(/no valid proven proof/);
    const wrongProofType = auditMechanicReport({
      ...report,
      proofs: report.proofs.map((proof) => ({ ...proof, type: "native_exact" as const })),
    });
    expect(wrongProofType.status).toBe("blocked");
    expect(wrongProofType.blockers.join(" ")).toMatch(/no valid proven proof|does not exactly match/);
    cache.set(report.cacheKey, { ...report, snapshotFingerprint: "stale-cache-build" });
    const callsBeforeTamperedCache = adapter.callsUsed;
    const regenerated = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(regenerated.status).toBe("verified");
    expect(adapter.callsUsed).toBeGreaterThan(callsBeforeTamperedCache);
  });

  it("requires inspection but not a fabricated claim for standalone Config and condition roots", async () => {
    const build = snapshot();
    const runner = new StandaloneConditionRunner();
    const observed = {
      weaponSet1: await runner.observe(build, "weaponSet1"),
      weaponSet2: await runner.observe(build, "weaponSet2"),
    };
    const facts = extractMechanicFacts(build, observed);
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const standaloneIds = facts.entities
      .filter(({ kind }) => kind === "config" || kind === "condition")
      .map(({ id }) => id);
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds, "complete", standaloneIds),
      providerDescriptor: { providerId: "test", endpoint: "local", model: "standalone-roots", apiMode: "test", reasoningMode: "test" },
      worker: runner,
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("verified");
    expect(report.coverage.every(({ missingEntityIds }) => missingEntityIds.length === 0)).toBe(true);
    expect(report.claims.some(({ sourceId, targetId }) => standaloneIds.includes(sourceId) || standaloneIds.includes(targetId))).toBe(false);
  });

  it("finalizes blocked after the full three-round repair budget", async () => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const runner = new FixtureRunner();
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds, "repair"),
      providerDescriptor: { providerId: "test", endpoint: "local", model: "repair-fixture", apiMode: "test", reasoningMode: "test" },
      worker: runner,
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
      maxModelCalls: 99,
      maxRepairRounds: 99,
      maxExperiments: 1,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("blocked");
    expect(report.repairRounds).toBe(3);
    expect(report.modelCalls).toBe(11);
    expect(report.modelCalls).toBeLessThanOrEqual(16);
    expect(report.experimentCount).toBe(1);
    expect(runner.experimentsRun).toBe(1);
    expect(report.blockers).toContain("Critic requested repair: The critic still requires repair.");
  });

  it("resumes an interrupted mechanic checkpoint without extracting PoB facts again", async () => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const adapter = new FailOnceAdapter(new ScriptedAdapter(modifierIds, metricIds));
    const runner = new FixtureRunner();
    const cache = new Map<string, unknown>();
    const saver = new MemorySaver();
    const engine = new MechanicUnderstandingEngine({
      provider: adapter,
      providerDescriptor: { providerId: "test", endpoint: "local", model: "fixture", apiMode: "test", reasoningMode: "test" },
      worker: runner,
      store: { getCache: <T>(key: string) => cache.get(key) as T | undefined, setCache: (key, value) => { cache.set(key, value); } },
      checkpointer: saver,
    });
    await expect(engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal))
      .rejects.toMatchObject({ name: "MechanicProviderError", retryable: true });
    expect(runner.observeCalls).toBe(2);
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("verified");
    expect(runner.observeCalls).toBe(2);
  });

  it("invalidates the report cache when Build, PoB rules, engine, or model identity changes", async () => {
    const cache = new Map<string, unknown>();
    const cacheKeys: string[] = [];
    const run = async (build: BuildSnapshot, model: string) => {
      const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
      const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
      const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
        facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
      const adapter = new ScriptedAdapter(modifierIds, metricIds);
      const engine = new MechanicUnderstandingEngine({
        provider: adapter,
        providerDescriptor: { providerId: "test", endpoint: "local", model, apiMode: "test", reasoningMode: "test" },
        worker: new FixtureRunner(),
        store: { getCache: <T>(key: string) => cache.get(key) as T | undefined, setCache: (key, value) => { cache.set(key, value); } },
        checkpointer: false,
      });
      const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
      expect(adapter.callsUsed).toBeGreaterThan(0);
      cacheKeys.push(report.cacheKey);
    };
    const base = snapshot();
    await run(base, "fixture");
    await run({ ...base, fingerprint: "different-build" }, "fixture");
    await run({ ...base, ruleset: "3_29_ruthless", dataVersion: "3_29_ruthless" }, "fixture");
    await run({ ...base, engineVersion: "different-pob-engine" }, "fixture");
    await run(base, "fixture-2");
    expect(new Set(cacheKeys).size).toBe(5);
  });
});
