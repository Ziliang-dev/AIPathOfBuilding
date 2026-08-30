import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { runAgentLoop } from "../agent/loop.js";
import type { ModelAdapter } from "../llm/types.js";
import {
  MechanicClaimSchema,
  MechanicProofSchema,
  VerifiedBuildMechanicReportSchema,
  type BuildSnapshot,
  type MechanicClaim,
  type MechanicContext,
  type MechanicCoverageEntrySchema,
  type MechanicFact,
  type MechanicFactBundle,
  type MechanicObservationDelta,
  type MechanicProof,
  type VerifiedBuildMechanicReport,
} from "../schemas.js";
import { canonicalHash } from "../search/canonical.js";
import {
  compileMechanicExperiments,
  diffMechanicObservations,
  type CompiledMechanicExperiment,
  type MechanicExperimentResult,
  type MechanicExperimentRunner,
} from "./experiments.js";
import { compactFactManifest, extractMechanicFacts } from "./facts.js";
import {
  MechanicToolDispatcher,
  type MechanicClaimInput,
  type MechanicReview,
  type MechanicToolName,
  type MechanicToolSession,
} from "./tools.js";

export const UNDERSTANDING_ENGINE_VERSION = "1";
export const MECHANIC_PROMPT_VERSION = "1";
export const MECHANIC_TOOL_SCHEMA_VERSION = "1";
export const STANDARD_MECHANIC_SCENARIO_MATRIX = [
  "current",
  "mapping:sustainable",
  "standardBoss:sustainable",
  "pinnacle:sustainable",
  "uber:sustainable",
  "mapping:peak",
  "standardBoss:peak",
  "pinnacle:peak",
  "uber:peak",
] as const;

export interface MechanicUnderstandingOptions {
  readonly contexts: readonly ["weaponSet1", "weaponSet2"];
  readonly force?: boolean;
}

export interface MechanicProviderDescriptor {
  readonly providerId: string;
  readonly endpoint: string;
  readonly model: string;
  readonly apiMode: string;
  readonly reasoningMode: string;
}

export interface MechanicReportStore {
  getCache<T>(key: string): T | undefined;
  setCache(key: string, payload: unknown): void;
}

export interface MechanicProgress {
  readonly phase: string;
  readonly progress: number;
  readonly entityCount: number;
  readonly inspectedCount: number;
  readonly modelCalls: number;
  readonly experimentCount: number;
  readonly repairRounds: number;
  readonly message: string;
}

export interface MechanicUnderstandingDependencies {
  readonly provider: ModelAdapter<MechanicToolName>;
  readonly providerDescriptor: MechanicProviderDescriptor;
  readonly worker: MechanicExperimentRunner;
  readonly store: MechanicReportStore;
  readonly checkpointer?: BaseCheckpointSaver | false;
  readonly maxModelCalls?: number;
  readonly maxRepairRounds?: number;
  readonly maxExperiments?: number;
  readonly duplicateCallLimit?: number;
  readonly now?: () => Date;
  readonly onProgress?: (progress: MechanicProgress) => void;
}

export class MechanicProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "MechanicProviderError";
    this.retryable = retryable;
  }
}

interface LocalValidation {
  claims: readonly MechanicClaim[];
  coverage: readonly CoverageEntry[];
  blockers: readonly string[];
  warnings: readonly string[];
}

type CoverageEntry = typeof MechanicCoverageEntrySchema._output;

function replace<Value>(defaultValue: () => Value) {
  return Annotation<Value>({ reducer: (_current, update) => update, default: defaultValue });
}

const MechanicStateAnnotation = Annotation.Root({
  snapshot: Annotation<BuildSnapshot>(),
  options: Annotation<MechanicUnderstandingOptions>(),
  facts: replace<MechanicFactBundle | undefined>(() => undefined),
  submittedClaims: replace<readonly MechanicClaimInput[]>(() => []),
  claims: replace<readonly MechanicClaim[]>(() => []),
  compiled: replace<readonly CompiledMechanicExperiment[]>(() => []),
  experimentResults: replace<readonly MechanicExperimentResult[]>(() => []),
  proofs: replace<readonly MechanicProof[]>(() => []),
  coverage: replace<readonly CoverageEntry[]>(() => []),
  inspectedEntityIds: replace<readonly string[]>(() => []),
  blockers: replace<readonly string[]>(() => []),
  warnings: replace<readonly string[]>(() => []),
  review: replace<MechanicReview | undefined>(() => undefined),
  report: replace<VerifiedBuildMechanicReport | undefined>(() => undefined),
  modelCalls: replace(() => 0),
  experimentCount: replace(() => 0),
  repairRounds: replace(() => 0),
  phase: replace(() => "idle"),
  trace: Annotation<string[], string>({ reducer: (current, update) => current.concat(update), default: () => [] }),
});

type GraphState = typeof MechanicStateAnnotation.State;
type GraphUpdate = typeof MechanicStateAnnotation.Update;

export const MECHANIC_ANALYST_POLICY = [
  "You are the analyst inside AIPathOfBuilding's mechanic-understanding loop.",
  "Use only the supplied local PoB fact tools; never use network knowledge or infer unsupported game rules.",
  "Inspect the complete active Build for both weapon contexts: every enabled skill and Full DPS skill, supports, equipment modifiers, allocated passives, config, actors, resources, defences, conditions, triggers, auras, curses and rotations.",
  "Inactive saved item/tree/skill sets are inventory only.",
  "Submit typed claims only with grants/requires/triggers/scales/consumes/conflicts.",
  "You cannot request mutations. Finish by calling submit_mechanic_claims with the complete replacement claim set.",
].join(" ");

export const MECHANIC_CRITIC_POLICY = [
  "You are the critic inside AIPathOfBuilding's mechanic-understanding loop.",
  "Use only supplied local facts, claims and PoB proofs.",
  "Audit both weapon contexts for missing entities, contradictions, invalid proofs and unsupported critical chains.",
  "Never accept prose as proof. Finish by calling submit_mechanic_review.",
].join(" ");

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function progress(
  dependencies: MechanicUnderstandingDependencies,
  state: Pick<GraphState, "facts" | "inspectedEntityIds" | "modelCalls" | "experimentCount" | "repairRounds">,
  phase: string,
  value: number,
  message: string,
): void {
  dependencies.onProgress?.({
    phase,
    progress: value,
    entityCount: state.facts?.entities.length ?? 0,
    inspectedCount: state.inspectedEntityIds.length,
    modelCalls: state.modelCalls,
    experimentCount: state.experimentCount,
    repairRounds: state.repairRounds,
    message,
  });
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number, minimum = 0): number {
  const candidate = value ?? fallback;
  return Number.isFinite(candidate)
    ? Math.min(maximum, Math.max(minimum, Math.floor(candidate)))
    : Math.min(maximum, Math.max(minimum, fallback));
}

function modelCallLimit(dependencies: MechanicUnderstandingDependencies): number {
  return boundedLimit(dependencies.maxModelCalls, 16, 16);
}

function repairRoundLimit(dependencies: MechanicUnderstandingDependencies): number {
  return boundedLimit(dependencies.maxRepairRounds, 3, 3);
}

function experimentLimit(dependencies: MechanicUnderstandingDependencies): number {
  return boundedLimit(dependencies.maxExperiments, 1024, 1024);
}

function repeatedToolCallLimit(dependencies: MechanicUnderstandingDependencies): number {
  return boundedLimit(dependencies.duplicateCallLimit, 3, 3, 1);
}

function cacheKey(snapshot: BuildSnapshot, facts: MechanicFactBundle, descriptor: MechanicProviderDescriptor): string {
  return `sha256:${canonicalHash({
    namespace: "mechanic-understanding:v4",
    build: snapshot.fingerprint,
    projection: snapshot.mechanicProjectionFingerprint,
    factBundle: facts.fingerprint,
    engine: snapshot.engineVersion,
    data: snapshot.dataVersion,
    ruleset: snapshot.ruleset,
    contexts: facts.contexts,
    scenarios: STANDARD_MECHANIC_SCENARIO_MATRIX,
    understandingEngine: UNDERSTANDING_ENGINE_VERSION,
    prompt: MECHANIC_PROMPT_VERSION,
    tools: MECHANIC_TOOL_SCHEMA_VERSION,
    provider: descriptor,
  })}`;
}

function checkpointThreadId(
  snapshot: BuildSnapshot,
  options: MechanicUnderstandingOptions,
  descriptor: MechanicProviderDescriptor,
): string {
  return `mechanics:${canonicalHash({
    namespace: "mechanic-understanding-checkpoint:v4",
    build: snapshot.fingerprint,
    projection: snapshot.mechanicProjectionFingerprint,
    engine: snapshot.engineVersion,
    data: snapshot.dataVersion,
    ruleset: snapshot.ruleset,
    contexts: options.contexts,
    understandingEngine: UNDERSTANDING_ENGINE_VERSION,
    prompt: MECHANIC_PROMPT_VERSION,
    tools: MECHANIC_TOOL_SCHEMA_VERSION,
    provider: descriptor,
  })}`;
}

function isRoot(entity: MechanicFact | undefined): boolean {
  if (entity === undefined || !entity.active) return false;
  return entity.kind === "metric" || entity.kind === "resource" || entity.kind === "cooldown"
    || entity.kind === "duration" || entity.kind === "skill" || entity.kind === "condition";
}

function localCriticality(
  claim: MechanicClaimInput,
  facts: ReadonlyMap<string, MechanicFact>,
  rawClaims: readonly MechanicClaimInput[],
): boolean {
  const source = facts.get(claim.sourceId);
  const target = facts.get(claim.targetId);
  if (source?.kind === "item" && target?.kind === "modifierLine" && claim.relation === "grants") return false;
  if (claim.relation === "triggers" || claim.relation === "consumes" || claim.relation === "requires") return true;
  if (source?.kind === "config") {
    const nativeSources = source.data.nativeSources;
    if (!Array.isArray(nativeSources) || nativeSources.length === 0) return true;
  }
  if (source?.kind === "modifierLine"
    && (source.data.parseStatus === "partial" || source.data.parseStatus === "unknown")) return true;
  if (claim.scenario !== undefined) return true;
  const outgoing = new Map<string, string[]>();
  for (const entry of rawClaims) {
    const targets = outgoing.get(entry.sourceId) ?? [];
    targets.push(entry.targetId);
    outgoing.set(entry.sourceId, targets);
  }
  const pending = [claim.targetId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (isRoot(facts.get(current))) return true;
    pending.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

function isAmbiguous(claim: MechanicClaimInput, source: MechanicFact | undefined): boolean {
  if (source === undefined || claim.evidenceIds.length === 0) return true;
  if (source.kind === "modifierLine") {
    if (source.data.parseStatus === "partial" || source.data.parseStatus === "unknown") return true;
    const modifierProvenance = source.data.modifierProvenance;
    if (modifierProvenance !== null && typeof modifierProvenance === "object"
      && !Array.isArray(modifierProvenance)
      && (modifierProvenance as Record<string, unknown>).resolution !== "exact") return true;
  }
  return claim.relation === "triggers" || claim.relation === "consumes";
}

function normalizeClaims(facts: MechanicFactBundle, inputs: readonly MechanicClaimInput[]): MechanicClaim[] {
  const entities = new Map(facts.entities.map((entity) => [entity.id, entity]));
  const seen = new Set<string>();
  const claims: MechanicClaim[] = [];
  for (const input of inputs) {
    const signature = canonicalHash(input);
    if (seen.has(signature)) continue;
    seen.add(signature);
    const critical = localCriticality(input, entities, inputs);
    const ambiguous = isAmbiguous(input, entities.get(input.sourceId));
    const source = entities.get(input.sourceId);
    claims.push(MechanicClaimSchema.parse({
      ...input,
      id: `claim:${signature.slice(0, 32)}`,
      critical,
      ambiguous,
      effectState: input.relation === "conflicts"
        ? "conflicting"
        : input.scenario !== undefined || input.relation === "requires" || input.relation === "triggers"
          ? "conditional"
          : source?.active === true ? "active" : "latent",
    }));
  }
  return claims.sort((left, right) => left.id.localeCompare(right.id));
}

function requiredInspectionEntity(entity: MechanicFact): boolean {
  if (!entity.active) return false;
  if (entity.kind === "actor") return entity.data.kind !== "player";
  return [
    "item",
    "modifierLine", "skill", "support", "passive", "config", "condition", "actorBuff", "seasonMechanic",
  ].includes(entity.kind);
}

function requiredClaimEntity(entity: MechanicFact): boolean {
  if (!requiredInspectionEntity(entity)) return false;
  if (entity.kind === "config") return Array.isArray(entity.data.nativeSources) && entity.data.nativeSources.length > 0;
  if (entity.kind === "condition") return Array.isArray(entity.data.sources) && entity.data.sources.length > 0;
  return true;
}

function factBundleBlockers(facts: MechanicFactBundle): string[] {
  return [...new Set([
    ...facts.missingScopes.map((scope) => `Required PoB fact scope missing: ${scope}`),
    ...facts.truncatedScopes.map((scope) => `Required PoB fact scope truncated: ${scope}`),
    ...(facts.complete ? [] : ["Required PoB fact bundle is incomplete"]),
  ])].sort();
}

function validateCoverage(
  facts: MechanicFactBundle,
  claims: readonly MechanicClaim[],
  inspectedEntityIds: readonly string[],
): LocalValidation {
  const inspected = new Set(inspectedEntityIds);
  const claimed = new Set(claims.flatMap(({ sourceId, targetId }) => [sourceId, targetId]));
  const proven = new Set<string>();
  const blockers: string[] = [];
  const warnings: string[] = [];
  const coverage: CoverageEntry[] = [];
  for (const context of facts.contexts) {
    for (const domain of ["skills", "gear", "tree", "config", "actor", "offence", "resource", "defence", "condition", "inventory"] as const) {
      const entities = facts.entities.filter((entity) => entity.context === context && entity.domain === domain && entity.active);
      const requiredInspection = entities.filter(requiredInspectionEntity);
      const requiredClaims = entities.filter(requiredClaimEntity);
      const missingInspection = requiredInspection.filter(({ id }) => !inspected.has(id)).map(({ id }) => id);
      const missingClaims = requiredClaims.filter(({ id }) => !claimed.has(id)).map(({ id }) => id);
      for (const id of missingInspection) blockers.push(`LLM did not inspect required entity ${id}`);
      for (const id of missingClaims) blockers.push(`LLM submitted no mechanism claim for required entity ${id}`);
      coverage.push({
        context,
        domain,
        entityCount: entities.length,
        inspectedCount: entities.filter(({ id }) => inspected.has(id)).length,
        claimedCount: entities.filter(({ id }) => claimed.has(id)).length,
        provenCount: entities.filter(({ id }) => proven.has(id)).length,
        missingEntityIds: [...new Set([...missingInspection, ...missingClaims])].sort(),
      });
    }
  }
  const pairRelations = new Map<string, Set<string>>();
  for (const claim of claims) {
    const key = `${claim.context}:${claim.sourceId}:${claim.targetId}`;
    const relations = pairRelations.get(key) ?? new Set<string>();
    relations.add(claim.relation);
    pairRelations.set(key, relations);
  }
  for (const [key, relations] of pairRelations) {
    if (relations.has("conflicts") && relations.size > 1) blockers.push(`Contradictory relations for ${key}`);
  }
  const entityById = new Map(facts.entities.map((entity) => [entity.id, entity]));
  for (const claim of claims) {
    const source = entityById.get(claim.sourceId);
    const target = entityById.get(claim.targetId);
    if (source === undefined || target === undefined) {
      blockers.push(`Claim ${claim.id} references an unknown mechanic entity`);
    } else if (source.context !== claim.context || target.context !== claim.context) {
      blockers.push(`Claim ${claim.id} crosses mechanic contexts`);
    } else if (!source.active || !target.active) {
      blockers.push(`Claim ${claim.id} references inactive inventory-only state`);
    }
  }
  if (claims.length === 0) blockers.push("LLM submitted no mechanic claims");
  blockers.push(...factBundleBlockers(facts));
  return { claims, coverage, blockers: [...new Set(blockers)].sort(), warnings };
}

function sourceIsExact(source: MechanicFact | undefined): boolean {
  if (source === undefined || !source.active || source.provenance.length === 0) return false;
  if (source.kind === "modifierLine") {
    if (source.data.parseStatus !== "parsed") return false;
    const value = source.data.modifierProvenance;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).resolution === "exact";
  }
  if (source.kind === "parsedModifier") return source.data.classification !== "unknown";
  return source.provenance.every(({ kind }) => kind !== "projection" || source.active);
}

function changed(record: Readonly<Record<string, unknown>>, key: unknown): boolean {
  return typeof key === "string" && Object.hasOwn(record, key);
}

function deltaChangesTarget(target: MechanicFact | undefined, delta: MechanicObservationDelta): boolean {
  if (target === undefined) return false;
  const key = target.data.key ?? target.name;
  if (target.kind === "metric") return changed(delta.metricChanges, key) || changed(delta.contributionChanges, key);
  if (target.kind === "resource") return changed(delta.resourceChanges, key) || changed(delta.contributionChanges, key);
  if (target.kind === "cooldown") return changed(delta.cooldownChanges, key) || changed(delta.contributionChanges, key);
  if (target.kind === "duration") return changed(delta.durationChanges, key) || changed(delta.contributionChanges, key);
  if (target.kind === "skill") {
    const observationId = target.data.observationId;
    return typeof observationId === "string" && (
      delta.addedSkillIds.includes(observationId)
      || delta.removedSkillIds.includes(observationId)
      || delta.addedSupportIds.some((id) => id.startsWith(`${observationId}:`))
      || delta.removedSupportIds.some((id) => id.startsWith(`${observationId}:`))
    );
  }
  if (target.kind === "support") {
    const observationId = target.data.observationId;
    return typeof observationId === "string"
      && (delta.addedSupportIds.includes(observationId) || delta.removedSupportIds.includes(observationId));
  }
  if (target.kind === "condition") {
    const observationId = target.data.observationId;
    return typeof observationId === "string"
      && (delta.addedConditionIds.includes(observationId) || delta.removedConditionIds.includes(observationId));
  }
  if (target.kind === "modifierLine") {
    const modifierId = target.data.modifierId;
    return typeof modifierId === "string"
      && (delta.addedModifierIds.includes(modifierId) || delta.removedModifierIds.includes(modifierId));
  }
  if (target.kind === "item") {
    const itemId = target.data.itemId;
    return typeof itemId === "string"
      && (delta.addedItemIds.includes(itemId) || delta.removedItemIds.includes(itemId));
  }
  if (target.kind === "passive") {
    const nodeId = String(target.data.nodeId ?? "");
    return nodeId.length > 0 && (delta.addedPassiveIds.includes(nodeId) || delta.removedPassiveIds.includes(nodeId));
  }
  if (target.kind === "config") return changed(delta.configChanges, target.data.configKey);
  return false;
}

function exactStructuralBinding(claim: MechanicClaim, source: MechanicFact | undefined, target: MechanicFact | undefined): boolean {
  if (source === undefined || target === undefined) return false;
  if (claim.relation === "grants" && source.kind === "item" && target.kind === "modifierLine") {
    return target.data.itemEntityId === source.id;
  }
  if (claim.relation === "grants" && source.kind === "modifierLine") {
    const sourceModifier = target.data.sourceModifier;
    return sourceModifier !== null && typeof sourceModifier === "object" && !Array.isArray(sourceModifier)
      && (sourceModifier as Record<string, unknown>).lineId === source.data.modifierId;
  }
  if (claim.relation === "scales" && source.kind === "support" && target.kind === "skill") {
    return source.data.supportedSkillEntityId === target.id;
  }
  if (claim.relation === "requires" && source.kind === "skill" && target.kind === "support") {
    return target.data.supportedSkillEntityId === source.id;
  }
  if (["grants", "requires", "scales"].includes(claim.relation)
    && source.kind === "config" && target.kind === "condition") {
    const configKey = source.data.configKey;
    const observationId = target.data.observationId;
    return typeof configKey === "string" && typeof observationId === "string"
      && observationId.split(":").slice(1).join(":") === configKey;
  }
  return claim.relation === "grants" && source.kind === "modifierLine"
    && target.kind === "parsedModifier" && target.id.startsWith(`${source.id}:parsed:`);
}

function counterfactualProvesClaim(
  claim: MechanicClaim,
  source: MechanicFact | undefined,
  target: MechanicFact | undefined,
  delta: MechanicObservationDelta,
): boolean {
  return delta.changed && delta.contributionChanged
    && (deltaChangesTarget(target, delta) || exactStructuralBinding(claim, source, target));
}

function verifyClaims(
  facts: MechanicFactBundle,
  compiled: readonly CompiledMechanicExperiment[],
  results: readonly MechanicExperimentResult[],
): { claims: MechanicClaim[]; proofs: MechanicProof[]; blockers: string[]; warnings: string[] } {
  const entities = new Map(facts.entities.map((entity) => [entity.id, entity]));
  const compiledByClaim = new Map(compiled.map((entry) => [entry.claim.id, entry]));
  const resultsByClaim = new Map<string, MechanicExperimentResult[]>();
  const proofs: MechanicProof[] = [];
  const claims: MechanicClaim[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const result of results) {
    if (result.claimId === undefined) {
      blockers.push(`Worker returned unbound mechanic result ${result.experimentId}`);
      continue;
    }
    if (!compiledByClaim.has(result.claimId)) {
      blockers.push(`Worker returned result for unknown claim ${result.claimId}`);
      continue;
    }
    const grouped = resultsByClaim.get(result.claimId) ?? [];
    grouped.push(result);
    resultsByClaim.set(result.claimId, grouped);
  }
  for (const entry of compiled) {
    let claim = entry.claim;
    if (entry.experiment !== undefined) {
      const matchingResults = resultsByClaim.get(claim.id) ?? [];
      const result = matchingResults.length === 1 ? matchingResults[0] : undefined;
      const expectedBaseline = facts.observations[claim.context];
      const resultErrors = result === undefined ? [] : [
        ...(result.experimentId === entry.experiment.id ? [] : [`experiment ${result.experimentId} does not match ${entry.experiment.id}`]),
        ...(result.claimId === claim.id ? [] : [`claim ${String(result.claimId)} does not match ${claim.id}`]),
        ...(result.context === claim.context ? [] : [`result context ${result.context} does not match ${claim.context}`]),
        ...(result.baseline.context === claim.context ? [] : [`baseline context ${result.baseline.context} does not match ${claim.context}`]),
        ...(result.diagnostic.context === claim.context ? [] : [`diagnostic context ${result.diagnostic.context} does not match ${claim.context}`]),
        ...(result.baseline.fingerprint === expectedBaseline.fingerprint ? [] : ["baseline fingerprint is stale"]),
        ...(result.baseline.projectionFingerprint === expectedBaseline.projectionFingerprint ? [] : ["baseline projection fingerprint is stale"]),
        ...(result.baseline.nativeProbeFingerprint === expectedBaseline.nativeProbeFingerprint ? [] : ["baseline native-probe fingerprint is stale"]),
        ...(result.baseline.evidenceFingerprint === expectedBaseline.evidenceFingerprint ? [] : ["baseline evidence fingerprint is stale"]),
      ];
      if (matchingResults.length !== 1 || result === undefined || resultErrors.length > 0) {
        const reason = matchingResults.length === 0
          ? "has no counterfactual result"
          : matchingResults.length > 1
            ? `has ${matchingResults.length} duplicate counterfactual results`
            : `has an invalid counterfactual result: ${resultErrors.join("; ")}`;
        blockers.push(`Critical claim ${claim.id} ${reason}`);
        proofs.push(MechanicProofSchema.parse({
          id: `proof:${claim.id}:counterfactual`, claimId: claim.id, type: "counterfactual",
          status: "indeterminate", context: claim.context, sourceFingerprint: facts.fingerprint,
          evidenceIds: [], experimentId: entry.experiment.id,
        }));
      } else {
        const delta = diffMechanicObservations(result.baseline, result.diagnostic);
        const source = entities.get(claim.sourceId);
        const target = entities.get(claim.targetId);
        const decisive = counterfactualProvesClaim(claim, source, target, delta);
        const finalMetricChanged = Object.keys(delta.metricChanges).length > 0
          || Object.keys(delta.resourceChanges).length > 0
          || Object.keys(delta.cooldownChanges).length > 0
          || Object.keys(delta.durationChanges).length > 0;
        const status = decisive ? "proven" : "indeterminate";
        if (!decisive) blockers.push(
          `Counterfactual did not change the claimed target contribution for critical claim ${claim.id} (${claim.sourceId} -> ${claim.targetId})`,
        );
        if (delta.contributionChanged && !finalMetricChanged) {
          claim = MechanicClaimSchema.parse({ ...claim, effectState: "redundant" });
          warnings.push(`Claim ${claim.id} is structurally proven but redundant in current outputs`);
        }
        proofs.push(MechanicProofSchema.parse({
          id: `proof:${claim.id}:counterfactual`, claimId: claim.id, type: "counterfactual", status,
          context: claim.context, sourceFingerprint: result.diagnostic.fingerprint,
          evidenceIds: [result.baseline.fingerprint, result.diagnostic.fingerprint],
          experimentId: result.experimentId, delta,
        }));
      }
    } else if (claim.critical || claim.ambiguous) {
      blockers.push(`Critical or ambiguous claim ${claim.id} has no compilable diagnostic intervention`);
      proofs.push(MechanicProofSchema.parse({
        id: `proof:${claim.id}:counterfactual`, claimId: claim.id, type: "counterfactual",
        status: "indeterminate", context: claim.context, sourceFingerprint: facts.fingerprint,
        evidenceIds: entry.exactEvidenceIds,
      }));
    } else {
      const exact = sourceIsExact(entities.get(claim.sourceId))
        && sourceIsExact(entities.get(claim.targetId))
        && entry.exactEvidenceIds.includes(claim.sourceId)
        && entry.exactEvidenceIds.includes(claim.targetId);
      if (!exact) blockers.push(`Noncritical claim ${claim.id} lacks exact native provenance`);
      proofs.push(MechanicProofSchema.parse({
        id: `proof:${claim.id}:native`, claimId: claim.id, type: "native_exact",
        status: exact ? "proven" : "indeterminate", context: claim.context,
        sourceFingerprint: entities.get(claim.sourceId)?.fingerprint ?? facts.fingerprint,
        evidenceIds: entry.exactEvidenceIds,
      }));
    }
    claims.push(claim);
  }
  return { claims, proofs, blockers: [...new Set(blockers)].sort(), warnings: [...new Set(warnings)].sort() };
}

async function callAnalyst(
  dependencies: MechanicUnderstandingDependencies,
  state: GraphState,
  phase: "analyst" | "repair",
  signal: AbortSignal,
): Promise<{ claims: readonly MechanicClaimInput[]; inspected: readonly string[]; modelCalls: number; submitted: boolean }> {
  const facts = state.facts;
  if (facts === undefined) throw new Error("Mechanic facts are unavailable");
  const inspected = new Set(state.inspectedEntityIds);
  const session: MechanicToolSession = {
    phase,
    facts,
    proofs: state.proofs,
    existingClaims: state.claims,
    inspectedEntityIds: inspected,
  };
  const remaining = Math.max(0, modelCallLimit(dependencies) - state.modelCalls);
  if (remaining === 0) return { claims: [], inspected: [...inspected], modelCalls: 0, submitted: false };
  const dispatcher = new MechanicToolDispatcher();
  const result = await runAgentLoop({
    adapter: dependencies.provider,
    dispatcher,
    messages: [
      { role: "system", content: MECHANIC_ANALYST_POLICY },
      {
        role: "user",
        content: phase === "analyst"
          ? "Discover the complete Build mechanism model. Page and inspect all required active entities in both contexts, then submit the complete typed claim set."
          : `Repair the complete claim set. Replace it after addressing these blockers and critic findings: ${JSON.stringify({ blockers: state.blockers, review: state.review })}`,
      },
    ],
    context: session,
    modelContext: {
      phase,
      manifest: compactFactManifest(facts),
      existingClaimCount: state.claims.length,
      proofCount: state.proofs.length,
      repairRound: state.repairRounds,
    },
    limits: {
      recursionLimit: Math.max(1, remaining),
      modelCallLimit: remaining,
      duplicateCallLimit: repeatedToolCallLimit(dependencies),
      wallTimeMs: Number.MAX_SAFE_INTEGER,
    },
    signal,
    stopAfterTool: (_toolResult, current) => current.submittedClaims !== undefined,
  });
  if (result.fallback !== undefined) {
    throw new MechanicProviderError(result.fallback.detail, result.fallback.retryable);
  }
  if (session.submittedClaims === undefined || session.claimsComplete !== true) {
    return { claims: [], inspected: [...inspected].sort(), modelCalls: result.modelCalls, submitted: false };
  }
  return { claims: session.submittedClaims, inspected: [...inspected].sort(), modelCalls: result.modelCalls, submitted: true };
}

async function callCritic(
  dependencies: MechanicUnderstandingDependencies,
  state: GraphState,
  signal: AbortSignal,
): Promise<{ review?: MechanicReview; modelCalls: number }> {
  const facts = state.facts;
  if (facts === undefined) throw new Error("Mechanic facts are unavailable");
  const session: MechanicToolSession = {
    phase: "critic",
    facts,
    proofs: state.proofs,
    existingClaims: state.claims,
    inspectedEntityIds: new Set(state.inspectedEntityIds),
  };
  const remaining = Math.max(0, modelCallLimit(dependencies) - state.modelCalls);
  if (remaining === 0) return { modelCalls: 0 };
  const result = await runAgentLoop({
    adapter: dependencies.provider,
    dispatcher: new MechanicToolDispatcher(),
    messages: [
      { role: "system", content: MECHANIC_CRITIC_POLICY },
      {
        role: "user",
        content: "Audit claim coverage and every proof. Inspect proof details as needed, then submit complete or repair with exact IDs.",
      },
    ],
    context: session,
    modelContext: {
      phase: "critic",
      manifest: compactFactManifest(facts),
      claims: state.claims,
      coverage: state.coverage,
      proofSummary: state.proofs.map(({ id, claimId, type, status }) => ({ id, claimId, type, status })),
      localBlockers: state.blockers,
    },
    limits: {
      recursionLimit: Math.max(1, remaining),
      modelCallLimit: remaining,
      duplicateCallLimit: repeatedToolCallLimit(dependencies),
      wallTimeMs: Number.MAX_SAFE_INTEGER,
    },
    signal,
    stopAfterTool: (_toolResult, current) => current.review !== undefined,
  });
  if (result.fallback !== undefined) throw new MechanicProviderError(result.fallback.detail, result.fallback.retryable);
  return {
    ...(session.review === undefined ? {} : { review: session.review }),
    modelCalls: result.modelCalls,
  };
}

function updateCoverageWithProofs(
  facts: MechanicFactBundle,
  coverage: readonly CoverageEntry[],
  claims: readonly MechanicClaim[],
  proofs: readonly MechanicProof[],
): CoverageEntry[] {
  const provenClaims = new Set(proofs.filter(({ status }) => status === "proven").map(({ claimId }) => claimId));
  const provenEntities = new Set(claims.filter(({ id }) => provenClaims.has(id)).flatMap(({ sourceId, targetId }) => [sourceId, targetId]));
  return coverage.map((entry) => ({
    ...entry,
    provenCount: facts.entities.filter((entity) => entity.context === entry.context
      && entity.domain === entry.domain && entity.active && provenEntities.has(entity.id)).length,
  }));
}

function reportFinding(message: string, severity: "warning" | "blocker") {
  return {
    id: `finding:${canonicalHash({ message, severity }).slice(0, 32)}`,
    severity,
    code: severity === "blocker" ? "mechanic_verification_blocked" : "mechanic_verification_warning",
    message,
    evidenceIds: [],
  } as const;
}

interface ExpectedMechanicReportIdentity {
  readonly snapshotFingerprint: string;
  readonly projectionFingerprint: string;
  readonly factBundleFingerprint: string;
  readonly cacheKey: string;
  readonly contexts: readonly MechanicContext[];
}

function duplicateIds(entries: readonly { readonly id: string }[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const { id } of entries) {
    if (seen.has(id)) duplicate.add(id);
    seen.add(id);
  }
  return [...duplicate].sort();
}

export function auditMechanicReport(
  raw: unknown,
  expected?: ExpectedMechanicReportIdentity,
): VerifiedBuildMechanicReport {
  const report = VerifiedBuildMechanicReportSchema.parse(raw);
  const claimById = new Map(report.claims.map((claim) => [claim.id, claim]));
  const proofById = new Map(report.proofs.map((proof) => [proof.id, proof]));
  const nodeById = new Map(report.graph.nodes.map((node) => [node.id, node]));
  const auditBlockers: string[] = [];
  const expectedAnalysisFingerprint = `sha256:${canonicalHash({
    ...report,
    analysisFingerprint: undefined,
    createdAt: undefined,
  })}`;
  if (report.analysisFingerprint !== expectedAnalysisFingerprint) {
    auditBlockers.push("Mechanic report analysis fingerprint is invalid");
  }
  if (expected !== undefined) {
    if (report.snapshotFingerprint !== expected.snapshotFingerprint) auditBlockers.push("Cached mechanic report Build fingerprint mismatch");
    if (report.projectionFingerprint !== expected.projectionFingerprint) auditBlockers.push("Cached mechanic report Projection fingerprint mismatch");
    if (report.factBundleFingerprint !== expected.factBundleFingerprint) auditBlockers.push("Cached mechanic report Fact Bundle fingerprint mismatch");
    if (report.cacheKey !== expected.cacheKey) auditBlockers.push("Cached mechanic report key mismatch");
    if (report.contexts[0] !== expected.contexts[0] || report.contexts[1] !== expected.contexts[1]) {
      auditBlockers.push("Cached mechanic report context mismatch");
    }
  }
  for (const id of duplicateIds(report.claims)) auditBlockers.push(`Duplicate mechanic claim ID ${id}`);
  for (const id of duplicateIds(report.proofs)) auditBlockers.push(`Duplicate mechanic proof ID ${id}`);
  for (const id of duplicateIds(report.graph.nodes)) auditBlockers.push(`Duplicate mechanic graph node ID ${id}`);
  for (const id of duplicateIds(report.graph.edges)) auditBlockers.push(`Duplicate mechanic graph edge ID ${id}`);
  if (report.claims.length === 0) auditBlockers.push("Mechanic report contains no claims");
  if (report.modelCalls > 16) auditBlockers.push(`Mechanic report exceeds model-call limit: ${report.modelCalls}`);
  if (report.experimentCount > 1024) auditBlockers.push(`Mechanic report exceeds experiment limit: ${report.experimentCount}`);
  if (report.repairRounds > 3) auditBlockers.push(`Mechanic report exceeds repair-round limit: ${report.repairRounds}`);
  if (report.status === "verified" && report.blockers.length > 0) auditBlockers.push("Verified mechanic report contains blockers");
  if (report.status === "verified" && report.findings.some(({ severity }) => severity === "blocker")) {
    auditBlockers.push("Verified mechanic report contains blocker findings");
  }
  if (report.status === "blocked" && report.blockers.length === 0) auditBlockers.push("Blocked mechanic report has no blocker reason");
  const knownEvidence = new Set(report.graph.nodes.flatMap((node) => [
    node.id,
    node.fingerprint,
    ...node.provenance.flatMap(({ sourceId, fingerprint, evidence }) => [sourceId, fingerprint, ...evidence]),
  ]));
  for (const proof of report.proofs) {
    const claim = claimById.get(proof.claimId);
    if (claim === undefined) {
      auditBlockers.push(`Proof ${proof.id} references unknown claim ${proof.claimId}`);
      continue;
    }
    if (proof.context !== claim.context) auditBlockers.push(`Proof ${proof.id} crosses mechanic contexts`);
    if (proof.type === "counterfactual" && proof.status === "proven"
      && (proof.experimentId === undefined || proof.delta === undefined
        || !counterfactualProvesClaim(claim, nodeById.get(claim.sourceId), nodeById.get(claim.targetId), proof.delta))) {
      auditBlockers.push(`Counterfactual proof ${proof.id} lacks a decisive experiment delta`);
    }
    if (proof.type === "native_exact" && proof.status === "proven") {
      const source = nodeById.get(claim.sourceId);
      const target = nodeById.get(claim.targetId);
      if (!sourceIsExact(source) || !sourceIsExact(target) || proof.sourceFingerprint !== source?.fingerprint
        || !proof.evidenceIds.includes(claim.sourceId) || !proof.evidenceIds.includes(claim.targetId)) {
        auditBlockers.push(`Native proof ${proof.id} lacks exact active source provenance`);
      }
    }
  }
  const proofValidForClaim = (proof: MechanicProof | undefined, claim: MechanicClaim): boolean => {
    if (proof === undefined || proof.claimId !== claim.id || proof.context !== claim.context || proof.status !== "proven") return false;
    if ((claim.critical || claim.ambiguous) && proof.type !== "counterfactual") return false;
    if (proof.type === "counterfactual") return proof.experimentId !== undefined && proof.delta !== undefined
      && counterfactualProvesClaim(claim, nodeById.get(claim.sourceId), nodeById.get(claim.targetId), proof.delta);
    const source = nodeById.get(claim.sourceId);
    const target = nodeById.get(claim.targetId);
    return sourceIsExact(source) && sourceIsExact(target) && proof.sourceFingerprint === source?.fingerprint
      && proof.evidenceIds.includes(claim.sourceId) && proof.evidenceIds.includes(claim.targetId);
  };
  for (const claim of report.claims) {
    const source = nodeById.get(claim.sourceId);
    const target = nodeById.get(claim.targetId);
    if (source === undefined || target === undefined) {
      auditBlockers.push(`Claim ${claim.id} references an unknown graph node`);
    } else if (source.context !== claim.context || target.context !== claim.context) {
      auditBlockers.push(`Claim ${claim.id} crosses mechanic contexts`);
    } else if (!source.active || !target.active) {
      auditBlockers.push(`Claim ${claim.id} references inactive inventory-only state`);
    }
    if (claim.evidenceIds.some((id) => !knownEvidence.has(id))) {
      auditBlockers.push(`Claim ${claim.id} references unknown local evidence`);
    }
    const validProofs = report.proofs.filter((proof) => proofValidForClaim(proof, claim));
    if (validProofs.length === 0) auditBlockers.push(`Claim ${claim.id} has no valid proven proof`);
    const matchingEdges = report.graph.edges.filter((edge) => edge.claimId === claim.id);
    if (report.status === "verified" && matchingEdges.length !== 1) {
      auditBlockers.push(`Verified claim ${claim.id} does not have exactly one semantic edge`);
    }
  }
  const edgeIsValid = (edge: VerifiedBuildMechanicReport["graph"]["edges"][number]): boolean => {
    const claim = claimById.get(edge.claimId);
    if (claim === undefined || !nodeById.has(edge.sourceId) || !nodeById.has(edge.targetId)) return false;
    if (edge.sourceId !== claim.sourceId || edge.targetId !== claim.targetId || edge.relation !== claim.relation
      || edge.context !== claim.context || edge.scenario !== claim.scenario || edge.effectState !== claim.effectState) return false;
    return edge.proofIds.every((proofId) => proofValidForClaim(proofById.get(proofId), claim));
  };
  for (const edge of report.graph.edges) {
    if (!edgeIsValid(edge)) auditBlockers.push(`Semantic edge ${edge.id} does not exactly match a locally proven claim`);
  }
  if (report.status === "verified") {
    for (const entry of report.coverage) {
      if (entry.missingEntityIds.length > 0) auditBlockers.push(`Verified coverage ${entry.context}:${entry.domain} has missing entities`);
      if (entry.provenCount < entry.claimedCount) auditBlockers.push(`Verified coverage ${entry.context}:${entry.domain} has unproven claimed entities`);
    }
  }
  if (auditBlockers.length === 0) return report;
  const blockers = [...new Set([...report.blockers, ...auditBlockers])].sort();
  const findings = new Map([
    ...report.findings,
    ...auditBlockers.map((message) => reportFinding(message, "blocker")),
  ].map((finding) => [finding.id, finding]));
  const audited = {
    ...report,
    status: "blocked" as const,
    blockers,
    findings: [...findings.values()],
    graph: {
      ...report.graph,
      edges: report.graph.edges.filter(edgeIsValid),
    },
    summary: `blocked: ${report.claims.length} claims, ${report.proofs.filter(({ status }) => status === "proven").length} proven, ${blockers.length} blockers`,
  };
  return VerifiedBuildMechanicReportSchema.parse({
    ...audited,
    analysisFingerprint: `sha256:${canonicalHash({ ...audited, analysisFingerprint: undefined, createdAt: undefined })}`,
  });
}

function finalizeReport(
  dependencies: MechanicUnderstandingDependencies,
  state: GraphState,
): VerifiedBuildMechanicReport {
  const facts = state.facts;
  if (facts === undefined) throw new Error("Mechanic facts are unavailable");
  const criticBlockers = state.review === undefined
    ? ["LLM critic did not submit a mechanic review"]
    : state.review.verdict === "repair"
      ? [
          `Critic requested repair: ${state.review.summary}`,
          ...state.review.missingEntityIds.map((id) => `Critic reports missing entity ${id}`),
          ...state.review.conflictingClaimIds.map((id) => `Critic reports conflicting claim ${id}`),
          ...state.review.invalidProofIds.map((id) => `Critic reports invalid proof ${id}`),
        ]
      : [];
  const blockers = [...new Set([...state.blockers, ...factBundleBlockers(facts), ...criticBlockers])].sort();
  const proven = new Map(state.proofs.filter(({ status }) => status === "proven").map((proof) => [proof.claimId, proof]));
  const edges = state.claims.flatMap((claim) => {
    const proof = proven.get(claim.id);
    if (proof === undefined) return [];
    return [{
      id: `edge:${claim.id}`,
      sourceId: claim.sourceId,
      targetId: claim.targetId,
      relation: claim.relation,
      context: claim.context,
      ...(claim.scenario === undefined ? {} : { scenario: claim.scenario }),
      claimId: claim.id,
      proofIds: [proof.id],
      effectState: claim.effectState,
    }];
  });
  const key = cacheKey(state.snapshot, facts, dependencies.providerDescriptor);
  const status = blockers.length === 0 ? "verified" : "blocked";
  const llmSummary = state.review?.summary ?? "LLM review unavailable before a configured safety limit was reached.";
  const withoutFingerprint = {
    schemaVersion: state.snapshot.schemaVersion,
    status,
    snapshotFingerprint: state.snapshot.fingerprint,
    projectionFingerprint: state.snapshot.mechanicProjectionFingerprint,
    factBundleFingerprint: facts.fingerprint,
    cacheKey: key,
    contexts: [...facts.contexts],
    claims: state.claims,
    proofs: state.proofs,
    graph: { nodes: facts.entities, edges },
    coverage: updateCoverageWithProofs(facts, state.coverage, state.claims, state.proofs),
    findings: [
      ...blockers.map((message) => reportFinding(message, "blocker")),
      ...state.warnings.map((message) => reportFinding(message, "warning")),
    ],
    blockers,
    summary: `${status}: ${state.claims.length} claims, ${state.proofs.filter(({ status: proofStatus }) => proofStatus === "proven").length} proven, ${blockers.length} blockers`,
    llmSummary,
    modelCalls: state.modelCalls,
    experimentCount: state.experimentCount,
    repairRounds: state.repairRounds,
    createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
  return VerifiedBuildMechanicReportSchema.parse({
    ...withoutFingerprint,
    analysisFingerprint: `sha256:${canonicalHash({ ...withoutFingerprint, createdAt: undefined })}`,
  });
}

function createGraph(dependencies: MechanicUnderstandingDependencies, signal: AbortSignal) {
  const extractFactsNode = async (state: GraphState): Promise<GraphUpdate> => {
    progress(dependencies, state, "ExtractFacts", 0.05, "Reading both weapon contexts from isolated PoB workers");
    const observations = await Promise.all(state.options.contexts.map(async (context) => [
      context,
      await dependencies.worker.observe(state.snapshot, context, signal),
    ] as const));
    const facts = extractMechanicFacts(state.snapshot, Object.fromEntries(observations) as Record<MechanicContext, typeof observations[number][1]>);
    const key = cacheKey(state.snapshot, facts, dependencies.providerDescriptor);
    const cached = state.options.force === true
      ? undefined
      : VerifiedBuildMechanicReportSchema.safeParse(dependencies.store.getCache<unknown>(key));
    const expectedIdentity = {
      snapshotFingerprint: state.snapshot.fingerprint,
      projectionFingerprint: state.snapshot.mechanicProjectionFingerprint,
      factBundleFingerprint: facts.fingerprint,
      cacheKey: key,
      contexts: facts.contexts,
    };
    const auditedCache = cached?.success === true ? auditMechanicReport(cached.data, expectedIdentity) : undefined;
    const cachedAnalysisFingerprint = cached?.success === true ? cached.data.analysisFingerprint : undefined;
    const report = auditedCache !== undefined && auditedCache.analysisFingerprint === cachedAnalysisFingerprint
      ? auditedCache
      : undefined;
    progress(dependencies, { ...state, facts }, "ExtractFacts", 0.15, report === undefined ? "PoB fact bundle ready" : "Exact mechanic report cache hit");
    return {
      facts,
      report,
      blockers: report === undefined ? factBundleBlockers(facts) : report.blockers,
      phase: "ExtractFacts",
      trace: "ExtractFacts",
    };
  };

  const discoverClaimsNode = async (state: GraphState): Promise<GraphUpdate> => {
    progress(dependencies, state, "DiscoverClaims", 0.2, "LLM analyst is discovering typed mechanism claims");
    const output = await callAnalyst(dependencies, state, "analyst", signal);
    return {
      submittedClaims: output.claims,
      inspectedEntityIds: output.inspected,
      modelCalls: state.modelCalls + output.modelCalls,
      phase: "DiscoverClaims",
      trace: "DiscoverClaims",
    };
  };

  const validateCoverageNode = (state: GraphState): GraphUpdate => {
    const facts = state.facts;
    if (facts === undefined) throw new Error("Mechanic facts are unavailable");
    const claims = normalizeClaims(facts, state.submittedClaims);
    const validation = validateCoverage(facts, claims, state.inspectedEntityIds);
    progress(dependencies, state, "ValidateCoverage", 0.35, `Validated ${claims.length} typed claims`);
    return {
      claims,
      coverage: validation.coverage,
      blockers: validation.blockers,
      warnings: validation.warnings,
      phase: "ValidateCoverage",
      trace: "ValidateCoverage",
    };
  };

  const compileNode = (state: GraphState): GraphUpdate => {
    const facts = state.facts;
    if (facts === undefined) throw new Error("Mechanic facts are unavailable");
    const compiled = compileMechanicExperiments(facts, state.claims);
    const experiments = compiled.filter(({ experiment }) => experiment !== undefined);
    const max = experimentLimit(dependencies);
    const remaining = Math.max(0, max - state.experimentCount);
    const blockers = experiments.length > remaining
      ? [...state.blockers, "Critical experiment count " + experiments.length
          + " exceeds remaining total budget " + remaining + " of " + max]
      : state.blockers;
    progress(dependencies, state, "CompileCriticalExperiments", 0.45, `Compiled ${experiments.length} critical experiments`);
    return { compiled, blockers, phase: "CompileCriticalExperiments", trace: "CompileCriticalExperiments" };
  };

  const runNode = async (state: GraphState): Promise<GraphUpdate> => {
    const facts = state.facts;
    if (facts === undefined) throw new Error("Mechanic facts are unavailable");
    const max = experimentLimit(dependencies);
    const remaining = Math.max(0, max - state.experimentCount);
    const experiments = state.compiled.flatMap(({ experiment }) => experiment === undefined ? [] : [experiment]).slice(0, remaining);
    progress(dependencies, state, "RunExperiments", 0.55, `Running ${experiments.length} isolated counterfactuals`);
    const results = experiments.length === 0 ? [] : await dependencies.worker.run(state.snapshot, experiments, signal);
    return {
      experimentResults: results,
      experimentCount: state.experimentCount + results.length,
      phase: "RunExperiments",
      trace: "RunExperiments",
    };
  };

  const verifyNode = (state: GraphState): GraphUpdate => {
    const facts = state.facts;
    if (facts === undefined) throw new Error("Mechanic facts are unavailable");
    const verified = verifyClaims(facts, state.compiled, state.experimentResults);
    progress(dependencies, state, "VerifyClaims", 0.7, `PoB verified ${verified.proofs.filter(({ status }) => status === "proven").length} claims`);
    return {
      claims: verified.claims,
      proofs: verified.proofs,
      blockers: [...new Set([...state.blockers, ...verified.blockers])].sort(),
      warnings: [...new Set([...state.warnings, ...verified.warnings])].sort(),
      phase: "VerifyClaims",
      trace: "VerifyClaims",
    };
  };

  const critiqueNode = async (state: GraphState): Promise<GraphUpdate> => {
    progress(dependencies, state, "CritiqueCoverage", 0.8, "LLM critic is auditing coverage and PoB proofs");
    const output = await callCritic(dependencies, state, signal);
    return {
      review: output.review,
      modelCalls: state.modelCalls + output.modelCalls,
      phase: "CritiqueCoverage",
      trace: "CritiqueCoverage",
    };
  };

  const repairNode = async (state: GraphState): Promise<GraphUpdate> => {
    progress(dependencies, state, "RepairClaims", 0.85, `Repairing claim set, round ${state.repairRounds + 1}`);
    const output = await callAnalyst(dependencies, state, "repair", signal);
    const submittedClaims = output.submitted ? output.claims : state.submittedClaims;
    return {
      submittedClaims,
      inspectedEntityIds: output.inspected,
      modelCalls: state.modelCalls + output.modelCalls,
      repairRounds: state.repairRounds + 1,
      blockers: output.submitted
        ? []
        : [...state.blockers, "LLM repair did not submit a complete replacement claim set"],
      warnings: [],
      proofs: [],
      experimentResults: [],
      review: undefined,
      phase: "RepairClaims",
      trace: "RepairClaims",
    };
  };

  const finalizeNode = (state: GraphState): GraphUpdate => {
    const facts = state.facts;
    if (facts === undefined) throw new Error("Mechanic facts are unavailable");
    const expectedIdentity = {
      snapshotFingerprint: state.snapshot.fingerprint,
      projectionFingerprint: state.snapshot.mechanicProjectionFingerprint,
      factBundleFingerprint: facts.fingerprint,
      cacheKey: cacheKey(state.snapshot, facts, dependencies.providerDescriptor),
      contexts: facts.contexts,
    };
    const report = state.report ?? auditMechanicReport(finalizeReport(dependencies, state), expectedIdentity);
    if (state.report === undefined) dependencies.store.setCache(report.cacheKey, report);
    progress(dependencies, state, "FinalizeReport", 1, report.status === "verified" ? "Mechanic report verified" : "Mechanic report blocked");
    return { report, phase: "FinalizeReport", trace: "FinalizeReport" };
  };

  const graph = new StateGraph(MechanicStateAnnotation)
    .addNode("ExtractFacts", extractFactsNode)
    .addNode("DiscoverClaims", discoverClaimsNode)
    .addNode("ValidateCoverage", validateCoverageNode)
    .addNode("CompileCriticalExperiments", compileNode)
    .addNode("RunExperiments", runNode)
    .addNode("VerifyClaims", verifyNode)
    .addNode("CritiqueCoverage", critiqueNode)
    .addNode("RepairClaims", repairNode)
    .addNode("FinalizeReport", finalizeNode)
    .addEdge(START, "ExtractFacts")
    .addConditionalEdges("ExtractFacts", (state) => {
      if (state.report !== undefined || state.facts?.complete !== true) return "FinalizeReport";
      return "DiscoverClaims";
    }, ["DiscoverClaims", "FinalizeReport"])
    .addEdge("DiscoverClaims", "ValidateCoverage")
    .addEdge("ValidateCoverage", "CompileCriticalExperiments")
    .addEdge("CompileCriticalExperiments", "RunExperiments")
    .addEdge("RunExperiments", "VerifyClaims")
    .addEdge("VerifyClaims", "CritiqueCoverage")
    .addConditionalEdges("CritiqueCoverage", (state) => {
      const maxRepair = repairRoundLimit(dependencies);
      const maxCalls = modelCallLimit(dependencies);
      const needsRepair = state.review?.verdict === "repair" || state.blockers.length > 0;
      return needsRepair && state.repairRounds < maxRepair && state.modelCalls < maxCalls
        ? "RepairClaims"
        : "FinalizeReport";
    }, ["RepairClaims", "FinalizeReport"])
    .addEdge("RepairClaims", "ValidateCoverage")
    .addEdge("FinalizeReport", END);
  return graph.compile({
    ...(dependencies.checkpointer === false ? {} : { checkpointer: dependencies.checkpointer }),
    name: "MechanicUnderstandingEngine",
  });
}

export class MechanicUnderstandingEngine {
  readonly #dependencies: MechanicUnderstandingDependencies;

  constructor(dependencies: MechanicUnderstandingDependencies) {
    this.#dependencies = dependencies;
  }

  async understand(
    snapshot: BuildSnapshot,
    options: MechanicUnderstandingOptions,
    signal: AbortSignal,
  ): Promise<VerifiedBuildMechanicReport> {
    if (options.contexts[0] !== "weaponSet1" || options.contexts[1] !== "weaponSet2") {
      throw new Error("Mechanic understanding requires weaponSet1 and weaponSet2 in canonical order");
    }
    signal.throwIfAborted();
    const graph = createGraph(this.#dependencies, signal);
    const maxRepairRounds = repairRoundLimit(this.#dependencies);
    const graphConfig = {
      configurable: {
        thread_id: checkpointThreadId(snapshot, options, this.#dependencies.providerDescriptor),
      },
      // Initial discovery uses seven nodes. Each repair adds six, then the
      // report still needs one finalization step. Keep graph plumbing above
      // that path while the domain limits continue to enforce three repairs.
      recursionLimit: 9 + (maxRepairRounds * 6),
      signal,
    };
    let result: GraphState;
    try {
      const initial: GraphUpdate = {
        snapshot,
        options,
        submittedClaims: [],
        claims: [],
        compiled: [],
        experimentResults: [],
        proofs: [],
        coverage: [],
        inspectedEntityIds: [],
        blockers: [],
        warnings: [],
        modelCalls: 0,
        experimentCount: 0,
        repairRounds: 0,
        phase: "idle",
      };
      const previous = this.#dependencies.checkpointer === false
        ? undefined
        : await graph.getState(graphConfig);
      const input = previous !== undefined && previous.next.length > 0 ? null : initial;
      result = await graph.invoke(input as never, graphConfig) as GraphState;
    } catch (error) {
      if (error instanceof MechanicProviderError) throw error;
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Mechanic analysis cancelled");
      throw new Error(`Mechanic understanding failed: ${errorText(error)}`);
    }
    if (result.report === undefined) throw new Error("Mechanic understanding produced no report");
    if (result.facts === undefined) throw new Error("Mechanic understanding produced no fact bundle");
    return auditMechanicReport(result.report, {
      snapshotFingerprint: snapshot.fingerprint,
      projectionFingerprint: snapshot.mechanicProjectionFingerprint,
      factBundleFingerprint: result.facts.fingerprint,
      cacheKey: cacheKey(snapshot, result.facts, this.#dependencies.providerDescriptor),
      contexts: result.facts.contexts,
    });
  }
}
