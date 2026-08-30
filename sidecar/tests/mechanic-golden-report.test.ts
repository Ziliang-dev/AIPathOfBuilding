import { describe, expect, it } from "vitest";
import type { ModelAdapter, ModelTurnInput, ModelTurnResult } from "../src/llm/types.js";
import { MechanicUnderstandingEngine, auditMechanicReport } from "../src/mechanics/engine.js";
import type {
  MechanicExperiment,
  MechanicExperimentResult,
  MechanicExperimentRunner,
} from "../src/mechanics/experiments.js";
import { extractMechanicFacts } from "../src/mechanics/facts.js";
import type { MechanicClaimInput, MechanicToolName } from "../src/mechanics/tools.js";
import type {
  BuildSnapshot,
  MechanicContext,
  MechanicFact,
  MechanicFactBundle,
  MechanicObservation,
} from "../src/schemas.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

function line(id: string, name: string, parsedName = "Damage", value: unknown = 1) {
  return {
    id: `item:${id}:explicit:1`,
    section: "explicit" as const,
    ordinal: 1,
    rawText: name,
    active: true,
    disabled: false,
    flags: [],
    modTags: [],
    parseStatus: "parsed" as const,
    provenance: {
      sourceFamily: "explicit",
      sourceTable: "golden",
      sourceModId: `Golden${id}`,
      resolution: "exact" as const,
      evidence: [`golden:${id}`],
    },
    parsedMods: [{
      name: parsedName,
      type: typeof value === "object" ? "LIST" : "MORE",
      classification: typeof value === "object" ? "structured" as const : "numeric" as const,
      value,
      flags: 0,
      keywordFlags: 0,
      tags: [],
    }],
  };
}

function item(id: string, name: string, modifierLines: ReturnType<typeof line>[]) {
  return {
    id,
    name,
    equipped: true,
    active: true,
    references: [{ itemSetId: "1", slot: `Golden ${id}`, active: true }],
    state: {},
    legality: { version: 1 as const, status: "valid" as const, findings: [] },
    modifierLines,
  };
}

function goldenSnapshot(): BuildSnapshot {
  const deathAura = line("death-aura", "Trigger Level 20 Death Aura when Equipped", "ExtraSkill", {
    skillId: "DeathAura",
    skillName: "Death Aura",
  });
  const withered = { ...line("withered", "35% increased Effect of Withered"), id: "item:death-aura:explicit:2", ordinal: 2 };
  const groups = [
    { index: 1, skill: "Blight", name: "Blight", supports: ["InfusedChannelling"] },
    { index: 2, skill: "DeathAura", name: "Death Aura", supports: ["VoidManipulation", "SwiftAffliction", "Efficacy", "LessDuration", "Lifetap", "ItemRarity"] },
    { index: 3, skill: "EnemyExplode", name: "On Kill Explosion", supports: [] },
    { index: 4, skill: "WitheringStep", name: "Withering Step", supports: [] },
    { index: 5, skill: "Despair", name: "Despair", supports: [] },
    { index: 6, skill: "Malevolence", name: "Malevolence", supports: [] },
  ];
  const nativeGroups = groups.map((group) => ({
    index: group.index,
    gems: [
      { index: 1, grantedEffectId: group.skill, enabled: true, support: false },
      ...group.supports.map((support, index) => ({
        index: index + 2,
        grantedEffectId: support,
        enabled: true,
        support: true,
      })),
    ],
  }));
  return {
    schemaVersion: 4,
    xml: "<PathOfBuilding/>",
    fingerprint: "user-death-aura-blight",
    engineVersion: "golden-pob-engine",
    dataVersion: "3.29",
    ruleset: "3.29",
    metrics: { FullDPS: 100 },
    config: { multiplierWitheredStackCount: 9 },
    buildState: {},
    gameplayFieldPaths: ["Build.level"],
    mechanicProjectionFingerprint: HASH_A,
    mechanicProjection: {
      version: 1,
      inventory: { version: 1, sections: ["explicit"], lineFlags: [], sourceFamilies: [] },
      items: [
        item("gloves", "Blight Gloves", [line("gloves", "30% more Damage over Time")]),
        item("infused", "Pearl of Tsoatha", [line("infused", "Skills Socketed in your Gloves are Supported by level 20 Infused Channelling", "ExtraSupport", {
          skillId: "InfusedChannelling",
          skillName: "Infused Channelling",
        })]),
        item("death-aura", "Foulborn Death's Oath", [deathAura, withered]),
        item("thread", "Thread of Hope", [line("thread", "Passives in Very Large Ring can be Allocated")]),
        item("escape", "Impossible Escape", [line("escape", "Passives near Resolute Technique can be Allocated")]),
        item("cluster", "Large Cluster Jewel", [line("cluster", "Adds 8 Passive Skills")]),
      ],
      modifierCount: 7,
      activeModifierCount: 7,
      unresolvedModifierCount: 0,
      descriptions: { entries: [], truncated: false },
      fingerprint: HASH_A,
    },
    contentCatalog: [
      {
        id: "pob:skills", domain: "skills", kind: "currentBuild", available: true,
        data: { currentGroupsTruncated: false, nativeLinkProbe: { complete: true, truncated: false, groups: nativeGroups } },
      },
      { id: "pob:items", domain: "gear", kind: "currentBuild", available: true, data: { truncated: false } },
      {
        id: "pob:tree", domain: "tree", kind: "currentBuild", available: true,
        data: {
          allocated: [
            { id: 101, name: "Thread of Hope allocated notable" },
            { id: 102, name: "Impossible Escape allocated notable" },
            { id: 103, name: "Cluster Jewel notable" },
          ],
          allocatedTruncated: false,
          truncated: false,
        },
      },
      {
        id: "pob:actors", domain: "actor", kind: "currentBuild", available: true,
        data: {
          actorSeason: {
            actors: [{ id: "actor:player", kind: "player", source: "Build" }],
            season: { secondaryAscendancy: { id: "Velka", name: "Velka Bloodline" } },
            truncated: false,
          },
        },
      },
      {
        id: "pob:config", domain: "config", kind: "currentBuild", available: true,
        data: {
          conditionClaims: [{
            condition: "multiplierWitheredStackCount",
            configKey: "multiplierWitheredStackCount",
            label: "Withered stacks",
            sourceStatus: "manual",
          }],
          valuesTruncated: false,
          conditionClaimsTruncated: false,
          truncated: false,
        },
      },
      {
        id: "pob:loadouts", domain: "progression", kind: "currentBuild", available: true,
        data: {
          itemSetIds: [1], activeItemSetId: 1,
          treeSpecIds: [1], activeTreeSpecId: 1,
          skillSetIds: [1], activeSkillSetId: 1,
          truncated: false,
        },
      },
    ],
  };
}

function goldenObservation(context: MechanicContext): MechanicObservation {
  const skills = [
    {
      id: "Blight", name: "Blight", group: 1, enabled: true, includeInFullDps: true, fromItem: false,
      supports: [{ id: "InfusedChannelling", name: "Infused Channelling", fromItem: true }],
    },
    {
      id: "DeathAura", name: "Death Aura", group: 2, enabled: true, includeInFullDps: true, fromItem: true,
      supports: ["VoidManipulation", "SwiftAffliction", "Efficacy", "LessDuration", "Lifetap", "ItemRarity"]
        .map((id) => ({ id, name: id, fromItem: false })),
    },
    { id: "EnemyExplode", name: "On Kill Explosion", group: 3, enabled: true, includeInFullDps: false, fromItem: false, supports: [] },
    { id: "WitheringStep", name: "Withering Step", group: 4, enabled: true, includeInFullDps: false, fromItem: false, supports: [] },
    { id: "Despair", name: "Despair", group: 5, enabled: true, includeInFullDps: false, fromItem: false, supports: [] },
    { id: "Malevolence", name: "Malevolence", group: 6, enabled: true, includeInFullDps: false, fromItem: false, supports: [] },
  ];
  return {
    context,
    fingerprint: context === "weaponSet1" ? HASH_B : HASH_C,
    projectionFingerprint: HASH_A,
    nativeProbeFingerprint: HASH_B,
    evidenceFingerprint: HASH_C,
    metrics: { FullDPS: 100 },
    skills,
    conditions: [{
      id: "enemy:Withered", actor: "enemy", sources: ["config:multiplierWitheredStackCount"], dependencies: [],
    }],
    activeItemIds: ["gloves", "infused", "death-aura", "thread", "escape", "cluster"],
    activeModifierIds: [
      "item:gloves:explicit:1", "item:infused:explicit:1", "item:death-aura:explicit:1",
      "item:death-aura:explicit:2", "item:thread:explicit:1", "item:escape:explicit:1", "item:cluster:explicit:1",
    ],
    activePassiveIds: ["101", "102", "103"],
    configValues: { multiplierWitheredStackCount: 9 },
    resources: { LifeCost: 35 },
    cooldowns: { WitheringStepCooldown: 3 },
    durations: { WitheredDuration: 2 },
    contributions: { FullDPS: 100 },
  };
}

function requiredFact(entity: MechanicFact): boolean {
  if (!entity.active) return false;
  if (entity.kind === "actor") return entity.data.kind !== "player";
  return ["item", "modifierLine", "skill", "support", "passive", "config", "condition", "actorBuff", "seasonMechanic"].includes(entity.kind);
}

function factBy(bundle: MechanicFactBundle, context: MechanicContext, predicate: (fact: MechanicFact) => boolean): MechanicFact {
  const found = bundle.entities.find((fact) => fact.context === context && predicate(fact));
  if (found === undefined) throw new Error(`Golden fact missing in ${context}`);
  return found;
}

function goldenClaims(bundle: MechanicFactBundle): MechanicClaimInput[] {
  const claims: MechanicClaimInput[] = [];
  for (const context of bundle.contexts) {
    const metric = factBy(bundle, context, ({ kind, name }) => kind === "metric" && name === "FullDPS");
    const condition = factBy(bundle, context, ({ kind }) => kind === "condition");
    const player = factBy(bundle, context, ({ kind, data }) => kind === "actor" && data.kind === "player");
    for (const entity of bundle.entities.filter((fact) => fact.context === context && fact.active)) {
      let relation: MechanicClaimInput["relation"] | undefined;
      let target: MechanicFact | undefined;
      if (entity.kind === "item") {
        target = bundle.entities.find((fact) => fact.context === context && fact.kind === "modifierLine"
          && fact.data.itemEntityId === entity.id);
        relation = "grants";
      } else if (entity.kind === "modifierLine") {
        const name = entity.name ?? "";
        if (name.includes("Infused Channelling")) target = factBy(bundle, context, ({ kind, name: targetName }) => kind === "support" && targetName === "Infused Channelling");
        else if (name.includes("Death Aura")) target = factBy(bundle, context, ({ kind, name: targetName }) => kind === "skill" && targetName === "Death Aura");
        else if (name.includes("Withered")) target = metric;
        else if (name.includes("Very Large Ring")) target = metric;
        else if (name.includes("Resolute Technique")) target = metric;
        else if (name.includes("Adds 8 Passive")) target = metric;
        else target = metric;
        relation = name.includes("Death Aura") || name.includes("Infused") ? "grants" : "scales";
      } else if (entity.kind === "skill") {
        target = metric;
        relation = "scales";
      } else if (entity.kind === "support") {
        const targetId = entity.data.supportedSkillEntityId;
        target = bundle.entities.find((fact) => fact.id === targetId);
        relation = "scales";
      } else if (entity.kind === "passive") {
        target = metric;
        relation = "scales";
      } else if (entity.kind === "config") {
        target = condition;
        relation = "scales";
      } else if (entity.kind === "seasonMechanic") {
        target = player;
        relation = "grants";
      }
      if (relation !== undefined && target !== undefined) {
        claims.push({
          sourceId: entity.id,
          relation,
          targetId: target.id,
          context,
          statement: `Golden local PoB fact ${entity.name ?? entity.id} participates in the verified mechanism chain.`,
          evidenceIds: [entity.id, target.id],
        });
      }
    }
  }
  return claims;
}

function toolCall(id: string, name: MechanicToolName, args: unknown) {
  return { id, name, arguments: args, rawArguments: JSON.stringify(args) };
}

class GoldenAdapter implements ModelAdapter<MechanicToolName> {
  callsUsed = 0;
  callsRemaining = 16;
  readonly #requiredIds: string[];
  readonly #claims: MechanicClaimInput[];
  readonly #callsByPhase = new Map<string, number>();

  constructor(bundle: MechanicFactBundle) {
    this.#requiredIds = bundle.entities.filter(requiredFact).map(({ id }) => id);
    this.#claims = goldenClaims(bundle);
  }

  async complete(input: ModelTurnInput): Promise<ModelTurnResult<MechanicToolName>> {
    this.callsUsed += 1;
    this.callsRemaining -= 1;
    const phase = String((input.context as { phase?: string } | undefined)?.phase ?? "analyst");
    const call = (this.#callsByPhase.get(phase) ?? 0) + 1;
    this.#callsByPhase.set(phase, call);
    if (phase === "critic") {
      return call === 1
        ? { kind: "message", content: "", toolCalls: [toolCall("proofs", "inspect_mechanic_proofs", { cursor: 0, limit: 200 })] }
        : { kind: "message", content: "", toolCalls: [toolCall("review", "submit_mechanic_review", {
            verdict: "complete",
            missingEntityIds: [],
            conflictingClaimIds: [],
            invalidProofIds: [],
            summary: "Both weapon contexts and every named Golden mechanism have local PoB proof.",
          })] };
    }
    return call === 1
      ? { kind: "message", content: "", toolCalls: [toolCall("inspect", "inspect_mechanic_entity", { entityIds: this.#requiredIds })] }
      : { kind: "message", content: "", toolCalls: [toolCall("claims", "submit_mechanic_claims", { claims: this.#claims, complete: true })] };
  }
}

class GoldenRunner implements MechanicExperimentRunner {
  async observe(_snapshot: BuildSnapshot, context: MechanicContext): Promise<MechanicObservation> {
    return goldenObservation(context);
  }

  async run(_snapshot: BuildSnapshot, experiments: readonly MechanicExperiment[]): Promise<readonly MechanicExperimentResult[]> {
    return experiments.map((experiment, index) => {
      const baseline = goldenObservation(experiment.context);
      const diagnostic = structuredClone(baseline);
      diagnostic.fingerprint = `sha256:${(index + 1).toString(16).padStart(64, "0")}`;
      diagnostic.metrics.FullDPS = 99 - index;
      diagnostic.contributions.FullDPS = 99 - index;
      const intervention = experiment.intervention;
      if (intervention?.kind === "suppress_item_modifier") {
        const id = `item:${intervention.itemId}:${intervention.section}:${intervention.ordinal}`;
        diagnostic.activeModifierIds = diagnostic.activeModifierIds.filter((value) => value !== id);
      } else if (intervention?.kind === "suppress_skill_effect") {
        diagnostic.skills = diagnostic.skills.filter(({ group }) => group !== intervention.group);
      } else if (intervention?.kind === "suppress_support") {
        diagnostic.skills = diagnostic.skills.map((skill) => skill.group !== intervention.group ? skill : {
          ...skill,
          supports: skill.supports.filter((_support, supportIndex) => supportIndex + 2 !== intervention.gem),
        });
      } else if (intervention?.kind === "suppress_passive_source") {
        diagnostic.activePassiveIds = diagnostic.activePassiveIds.filter((id) => id !== String(intervention.nodeId));
      } else if (intervention?.kind === "suppress_config_source") {
        delete diagnostic.configValues[intervention.configKey];
        diagnostic.conditions = [];
      }
      return {
        experimentId: experiment.id,
        ...(experiment.claimId === undefined ? {} : { claimId: experiment.claimId }),
        context: experiment.context,
        baseline,
        diagnostic,
      };
    });
  }
}

describe("supplied Death Aura / Blight Golden mechanic report", () => {
  it("verifies every named mechanism in both weapon contexts and fails closed when a key proof is removed", async () => {
    const snapshot = goldenSnapshot();
    const facts = extractMechanicFacts(snapshot, {
      weaponSet1: goldenObservation("weaponSet1"),
      weaponSet2: goldenObservation("weaponSet2"),
    });
    const adapter = new GoldenAdapter(facts);
    const engine = new MechanicUnderstandingEngine({
      provider: adapter,
      providerDescriptor: {
        providerId: "golden",
        endpoint: "local-fixture",
        model: "golden-critic",
        apiMode: "fixture",
        reasoningMode: "fixture",
      },
      worker: new GoldenRunner(),
      store: { getCache: () => undefined, setCache: () => undefined },
      checkpointer: false,
    });
    const report = await engine.understand(snapshot, { contexts: ["weaponSet1", "weaponSet2"] }, new AbortController().signal);
    expect(report.blockers).toEqual([]);
    expect(report.status).toBe("verified");
    expect(report.contexts).toEqual(["weaponSet1", "weaponSet2"]);
    const text = report.graph.nodes.map(({ name }) => name ?? "").join(" | ");
    for (const expected of [
      "Blight", "Infused Channelling", "Damage over Time", "Death Aura", "On Kill Explosion",
      "Withering Step", "Withered", "Despair", "Malevolence", "Velka Bloodline",
      "Thread of Hope", "Impossible Escape", "Cluster Jewel",
    ]) expect(text).toContain(expected);
    expect(report.graph.nodes.filter(({ kind, name }) => kind === "support" && name !== "Infused Channelling")).toHaveLength(12);
    expect(report.claims.filter(({ critical, ambiguous }) => critical || ambiguous).every((claim) =>
      report.proofs.some((proof) => proof.claimId === claim.id && proof.type === "counterfactual" && proof.status === "proven"))).toBe(true);
    expect(report.claims.filter(({ critical, ambiguous }) => !critical && !ambiguous).every((claim) =>
      report.proofs.some((proof) => proof.claimId === claim.id && proof.type === "native_exact" && proof.status === "proven"))).toBe(true);
    expect(report.coverage.every(({ missingEntityIds }) => missingEntityIds.length === 0)).toBe(true);
    const criticalProof = report.proofs.find(({ type }) => type === "counterfactual")!;
    const audited = auditMechanicReport({
      ...report,
      proofs: report.proofs.filter(({ id }) => id !== criticalProof.id),
    });
    expect(audited.status).toBe("blocked");
    expect(audited.blockers.join(" ")).toMatch(/no valid proven proof/);
  });
});
