import { describe, expect, it } from "vitest";
import { MemorySaver } from "@langchain/langgraph";
import type { ModelAdapter, ModelTurnInput, ModelTurnResult } from "../src/llm/types.js";
import {
  MechanicExperimentSchema,
  MechanicToolDispatcher,
  MechanicUnderstandingEngine,
  auditMechanicReport,
  compileMechanicExperiments,
  diffMechanicObservations,
  extractMechanicFacts,
  type MechanicExperiment,
  type MechanicExperimentResult,
  type MechanicExperimentRunner,
  type MechanicToolName,
} from "../src/mechanics/index.js";
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
  readonly #metricIds: string[];
  readonly #criticVerdict: "complete" | "repair";
  readonly callsByPhase = new Map<string, number>();

  constructor(modifierIds: string[], metricIds: string[], criticVerdict: "complete" | "repair" = "complete") {
    this.#modifierIds = modifierIds;
    this.#metricIds = metricIds;
    this.#criticVerdict = criticVerdict;
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
      return { kind: "message", content: "", toolCalls: [toolCall("inspect", "inspect_mechanic_entity", { entityIds: this.#modifierIds })] };
    }
    const claims = this.#modifierIds.map((sourceId, index) => ({
      sourceId, relation: "scales" as const, targetId: this.#metricIds[index],
      context: sourceId.startsWith("weaponSet1:") ? "weaponSet1" as const : "weaponSet2" as const,
      statement: "The exact glove modifier scales Full DPS.", evidenceIds: [sourceId],
    }));
    return { kind: "message", content: "", toolCalls: [toolCall("claims", "submit_mechanic_claims", { claims, complete: true })] };
  }
}

class FixtureRunner implements MechanicExperimentRunner {
  observeCalls = 0;

  async observe(_snapshot: BuildSnapshot, context: MechanicContext): Promise<MechanicObservation> {
    this.observeCalls += 1;
    return observation(context);
  }

  async run(_snapshot: BuildSnapshot, experiments: readonly MechanicExperiment[]): Promise<readonly MechanicExperimentResult[]> {
    return experiments.map((experiment) => ({
      experimentId: experiment.id, ...(experiment.claimId === undefined ? {} : { claimId: experiment.claimId }), context: experiment.context,
      baseline: observation(experiment.context), diagnostic: observation(experiment.context, true),
    }));
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

  it("classifies structural contribution changes independently from final metrics", () => {
    const baseline = observation("weaponSet1");
    const diagnostic = { ...observation("weaponSet1", true), metrics: baseline.metrics, contributions: baseline.contributions };
    const delta = diffMechanicObservations(baseline, diagnostic);
    expect(delta.changed).toBe(true);
    expect(delta.contributionChanged).toBe(true);
    expect(delta.metricChanges).toEqual({});
    expect(delta.removedModifierIds).toEqual(["item:1:explicit:1"]);
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
    expect(report.claims).toHaveLength(2);
    expect(report.proofs.every(({ type, status }) => type === "counterfactual" && status === "proven")).toBe(true);
    const calls = adapter.callsUsed;
    const cached = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(cached.analysisFingerprint).toBe(report.analysisFingerprint);
    expect(adapter.callsUsed).toBe(calls);
    const audited = auditMechanicReport({ ...report, proofs: [] });
    expect(audited.status).toBe("blocked");
    expect(audited.blockers.join(" ")).toMatch(/no valid proven proof/);
  });

  it("finalizes blocked after the full three-round repair budget", async () => {
    const build = snapshot();
    const facts = extractMechanicFacts(build, { weaponSet1: observation("weaponSet1"), weaponSet2: observation("weaponSet2") });
    const modifierIds = facts.entities.filter(({ kind }) => kind === "modifierLine").map(({ id }) => id);
    const metricIds = ["weaponSet1", "weaponSet2"].map((context) =>
      facts.entities.find(({ kind, context: factContext }) => kind === "metric" && factContext === context)!.id);
    const engine = new MechanicUnderstandingEngine({
      provider: new ScriptedAdapter(modifierIds, metricIds, "repair"),
      providerDescriptor: { providerId: "test", endpoint: "local", model: "repair-fixture", apiMode: "test", reasoningMode: "test" },
      worker: new FixtureRunner(),
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
    });
    const report = await engine.understand(build, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.status).toBe("blocked");
    expect(report.repairRounds).toBe(3);
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
