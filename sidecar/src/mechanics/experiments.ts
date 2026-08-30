import { z } from "zod";
import {
  MechanicContextSchema,
  MechanicObservationDeltaSchema,
  MechanicObservationSchema,
  type BuildSnapshot,
  type MechanicClaim,
  type MechanicFactBundle,
  type MechanicObservation,
  type MechanicObservationDelta,
} from "../schemas.js";
import { canonicalHash } from "../search/canonical.js";
import type { WorkerEvaluation, WorkerJob, WorkerPool } from "../worker/types.js";

export const MechanicInterventionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("suppress_item_modifier"),
    itemId: z.union([z.string(), z.number()]),
    section: z.string().min(1),
    ordinal: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("suppress_skill_effect"),
    group: z.number().int().positive(),
    gem: z.number().int().positive().optional(),
  }).strict(),
  z.object({
    kind: z.literal("suppress_support"),
    group: z.number().int().positive(),
    gem: z.number().int().positive(),
  }).strict(),
  z.object({ kind: z.literal("suppress_passive_source"), nodeId: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("suppress_config_source"), configKey: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("suppress_actor_buff"), buffer: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("switch_weapon_set"), context: MechanicContextSchema }).strict(),
]);
export type MechanicIntervention = z.infer<typeof MechanicInterventionSchema>;

export const MechanicExperimentSchema = z.object({
  id: z.string().min(1).max(512),
  claimId: z.string().min(1).max(512).optional(),
  context: MechanicContextSchema,
  intervention: MechanicInterventionSchema.optional(),
}).strict();
export type MechanicExperiment = z.infer<typeof MechanicExperimentSchema>;

export const MechanicExperimentResultSchema = z.object({
  experimentId: z.string().min(1),
  claimId: z.string().min(1).optional(),
  context: MechanicContextSchema,
  baseline: MechanicObservationSchema,
  diagnostic: MechanicObservationSchema,
});
export type MechanicExperimentResult = z.infer<typeof MechanicExperimentResultSchema>;

export interface PobWorkerMechanicPayload {
  readonly operation: "mechanic_experiment";
  readonly xml: string;
  readonly actions: readonly [];
  readonly scenarios: readonly [];
  readonly evidence: readonly [];
  readonly mechanicExperiment: MechanicExperiment;
  readonly probeOptions?: Readonly<Record<string, unknown>>;
}

type MechanicPool = WorkerPool<PobWorkerMechanicPayload, WorkerEvaluation>;

export interface MechanicExperimentRunner {
  observe(snapshot: BuildSnapshot, context: z.infer<typeof MechanicContextSchema>, signal: AbortSignal): Promise<MechanicObservation>;
  run(snapshot: BuildSnapshot, experiments: readonly MechanicExperiment[], signal: AbortSignal): Promise<readonly MechanicExperimentResult[]>;
}

export class PoolMechanicExperimentRunner implements MechanicExperimentRunner {
  readonly #pool: MechanicPool;
  readonly #runId: string;

  constructor(pool: MechanicPool, runId: string) {
    this.#pool = pool;
    this.#runId = runId;
  }

  async observe(
    snapshot: BuildSnapshot,
    context: z.infer<typeof MechanicContextSchema>,
    signal: AbortSignal,
  ): Promise<MechanicObservation> {
    const [result] = await this.run(snapshot, [{ id: `observe:${context}`, context }], signal);
    if (result === undefined) throw new Error(`PoB worker returned no ${context} mechanic observation`);
    return result.baseline;
  }

  async run(
    snapshot: BuildSnapshot,
    experiments: readonly MechanicExperiment[],
    signal: AbortSignal,
  ): Promise<readonly MechanicExperimentResult[]> {
    const jobs: WorkerJob<PobWorkerMechanicPayload>[] = experiments.map((rawExperiment) => {
      const experiment = MechanicExperimentSchema.parse(rawExperiment);
      return {
        id: `${this.#runId}:${experiment.id}`,
        runId: this.#runId,
        candidateId: experiment.claimId ?? experiment.id,
        buildFingerprint: snapshot.fingerprint,
        scenarios: [],
        payload: {
          operation: "mechanic_experiment",
          xml: snapshot.xml,
          actions: [],
          scenarios: [],
          evidence: [],
          mechanicExperiment: experiment,
        },
      };
    });
    const evaluations = await this.#pool.evaluateBatch(jobs, signal);
    return evaluations.map((evaluation) => {
      if (evaluation.mechanicExperimentResult === undefined) {
        throw new Error(`PoB worker omitted mechanic experiment result for ${evaluation.jobId}`);
      }
      return MechanicExperimentResultSchema.parse(evaluation.mechanicExperimentResult);
    });
  }
}

function stringSetDelta(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    added: [...afterSet].filter((value) => !beforeSet.has(value)).sort(),
    removed: [...beforeSet].filter((value) => !afterSet.has(value)).sort(),
  };
}

function numericChanges(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): Record<string, { before?: number; after?: number; delta?: number }> {
  const result: Record<string, { before?: number; after?: number; delta?: number }> = {};
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const left = before[key];
    const right = after[key];
    if (left === right) continue;
    result[key] = {
      ...(left === undefined ? {} : { before: left }),
      ...(right === undefined ? {} : { after: right }),
      ...(left === undefined || right === undefined ? {} : { delta: right - left }),
    };
  }
  return result;
}

function valueChanges(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): Record<string, { before?: unknown; after?: unknown }> {
  const result: Record<string, { before?: unknown; after?: unknown }> = {};
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const left = before[key];
    const right = after[key];
    const equal = left === undefined && right === undefined
      || left !== undefined && right !== undefined && canonicalHash(left) === canonicalHash(right);
    if (equal) continue;
    result[key] = {
      ...(left === undefined ? {} : { before: left }),
      ...(right === undefined ? {} : { after: right }),
    };
  }
  return result;
}

export function diffMechanicObservations(
  baseline: MechanicObservation,
  diagnostic: MechanicObservation,
): MechanicObservationDelta {
  const skillDelta = stringSetDelta(baseline.skills.map(({ id }) => id), diagnostic.skills.map(({ id }) => id));
  const supportDelta = stringSetDelta(
    baseline.skills.flatMap((skill) => skill.supports.map(({ id }) => `${skill.id}:${id}`)),
    diagnostic.skills.flatMap((skill) => skill.supports.map(({ id }) => `${skill.id}:${id}`)),
  );
  const conditionDelta = stringSetDelta(baseline.conditions.map(({ id }) => id), diagnostic.conditions.map(({ id }) => id));
  const modifierDelta = stringSetDelta(baseline.activeModifierIds, diagnostic.activeModifierIds);
  const itemDelta = stringSetDelta(baseline.activeItemIds, diagnostic.activeItemIds);
  const passiveDelta = stringSetDelta(baseline.activePassiveIds, diagnostic.activePassiveIds);
  const metricChanges = numericChanges(baseline.metrics, diagnostic.metrics);
  const resourceChanges = numericChanges(baseline.resources, diagnostic.resources);
  const cooldownChanges = numericChanges(baseline.cooldowns, diagnostic.cooldowns);
  const durationChanges = numericChanges(baseline.durations, diagnostic.durations);
  const contributionChanges = numericChanges(baseline.contributions, diagnostic.contributions);
  const configChanges = valueChanges(baseline.configValues, diagnostic.configValues);
  const contributionChanged = supportDelta.added.length + supportDelta.removed.length
    + conditionDelta.added.length + conditionDelta.removed.length
    + skillDelta.added.length + skillDelta.removed.length
    + Object.keys(contributionChanges).length > 0;
  const changed = contributionChanged
    || modifierDelta.added.length + modifierDelta.removed.length
      + itemDelta.added.length + itemDelta.removed.length
      + passiveDelta.added.length + passiveDelta.removed.length > 0
    || Object.keys(configChanges).length > 0
    || Object.keys(metricChanges).length + Object.keys(resourceChanges).length
      + Object.keys(cooldownChanges).length + Object.keys(durationChanges).length > 0;
  const withoutFingerprint = {
    changed,
    contributionChanged,
    metricChanges,
    addedSkillIds: skillDelta.added,
    removedSkillIds: skillDelta.removed,
    addedSupportIds: supportDelta.added,
    removedSupportIds: supportDelta.removed,
    addedConditionIds: conditionDelta.added,
    removedConditionIds: conditionDelta.removed,
    addedModifierIds: modifierDelta.added,
    removedModifierIds: modifierDelta.removed,
    addedItemIds: itemDelta.added,
    removedItemIds: itemDelta.removed,
    addedPassiveIds: passiveDelta.added,
    removedPassiveIds: passiveDelta.removed,
    contributionChanges,
    configChanges,
    resourceChanges,
    cooldownChanges,
    durationChanges,
  };
  return MechanicObservationDeltaSchema.parse({
    ...withoutFingerprint,
    fingerprint: `sha256:${canonicalHash(withoutFingerprint)}`,
  });
}

export interface CompiledMechanicExperiment {
  readonly claim: MechanicClaim;
  readonly experiment?: MechanicExperiment;
  readonly exactEvidenceIds: readonly string[];
}

export function compileMechanicExperiments(
  facts: MechanicFactBundle,
  claims: readonly MechanicClaim[],
): readonly CompiledMechanicExperiment[] {
  const entities = new Map(facts.entities.map((entity) => [entity.id, entity]));
  return claims.map((claim) => {
    const source = entities.get(claim.sourceId);
    const target = entities.get(claim.targetId);
    if (source === undefined) return { claim, exactEvidenceIds: [] };
    const data = source.data;
    let intervention: MechanicIntervention | undefined;
    if (source.kind === "modifierLine") {
      const { itemId, section, ordinal } = data;
      if ((typeof itemId === "string" || typeof itemId === "number")
        && typeof section === "string" && typeof ordinal === "number") {
        intervention = { kind: "suppress_item_modifier", itemId, section, ordinal };
      }
    } else if (source.kind === "support") {
      const sourceModifier = typeof data.sourceModifier === "object" && data.sourceModifier !== null
        ? data.sourceModifier as Record<string, unknown>
        : undefined;
      if ((typeof sourceModifier?.itemId === "string" || typeof sourceModifier?.itemId === "number")
        && typeof sourceModifier.section === "string" && typeof sourceModifier.ordinal === "number") {
        intervention = {
          kind: "suppress_item_modifier",
          itemId: sourceModifier.itemId,
          section: sourceModifier.section,
          ordinal: sourceModifier.ordinal,
        };
      } else {
        const { group, gem } = data;
        if (typeof group === "number" && typeof gem === "number") intervention = { kind: "suppress_support", group, gem };
      }
    } else if (source.kind === "skill") {
      const sourceModifier = typeof data.sourceModifier === "object" && data.sourceModifier !== null
        ? data.sourceModifier as Record<string, unknown>
        : undefined;
      if ((typeof sourceModifier?.itemId === "string" || typeof sourceModifier?.itemId === "number")
        && typeof sourceModifier.section === "string" && typeof sourceModifier.ordinal === "number") {
        intervention = {
          kind: "suppress_item_modifier",
          itemId: sourceModifier.itemId,
          section: sourceModifier.section,
          ordinal: sourceModifier.ordinal,
        };
      } else {
        const { group, gem } = data;
        if (typeof group === "number") intervention = {
          kind: "suppress_skill_effect", group, ...(typeof gem === "number" ? { gem } : {}),
        };
      }
    } else if (source.kind === "passive") {
      if (typeof data.nodeId === "number") intervention = { kind: "suppress_passive_source", nodeId: data.nodeId };
    } else if (source.kind === "config") {
      if (typeof data.configKey === "string") intervention = { kind: "suppress_config_source", configKey: data.configKey };
    } else if (source.kind === "actorBuff") {
      if (typeof data.buffer === "string") intervention = { kind: "suppress_actor_buff", buffer: data.buffer };
    }
    const needsCounterfactual = claim.critical || claim.ambiguous;
    const requiredEvidenceIds = [source.id, ...(target === undefined ? [] : [target.id])];
    const supplementalEvidenceIds = [...new Set([
      source.fingerprint,
      ...source.provenance.flatMap(({ evidence, sourceId, fingerprint }) => [sourceId, fingerprint, ...evidence]),
      ...(target === undefined ? [] : [
        target.fingerprint,
        ...target.provenance.flatMap(({ evidence, sourceId, fingerprint }) => [sourceId, fingerprint, ...evidence]),
      ]),
    ])].filter((id) => !requiredEvidenceIds.includes(id)).sort();
    const exactEvidenceIds = [...requiredEvidenceIds, ...supplementalEvidenceIds].slice(0, 256);
    return {
      claim,
      exactEvidenceIds,
      ...(needsCounterfactual && intervention !== undefined ? {
        experiment: { id: `experiment:${claim.id}`, claimId: claim.id, context: claim.context, intervention },
      } : {}),
    };
  });
}
