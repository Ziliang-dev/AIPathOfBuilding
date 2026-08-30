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
  if (claim.relation === "triggers" || claim.relation === "consumes" || claim.relation === "requires") return true;
  const source = facts.get(claim.sourceId);
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

function requiredClaimEntity(entity: MechanicFact): boolean {
  return entity.active && [
    "modifierLine", "skill", "support", "passive", "config", "condition", "actorBuff", "seasonMechanic",
  ].includes(entity.kind);
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
      const required = entities.filter(requiredClaimEntity);
      const missingInspection = required.filter(({ id }) => !inspected.has(id)).map(({ id }) => id);
      const missingClaims = required.filter(({ id }) => !claimed.has(id)).map(({ id }) => id);
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
  if (claims.length === 0) blockers.push("LLM submitted no mechanic claims");
  if (!facts.complete) blockers.push(...facts.missingScopes.map((scope) => `Required PoB fact scope missing: ${scope}`));
  blockers.push(...facts.truncatedScopes.map((scope) => `Required PoB fact scope truncated: ${scope}`));
  return { claims, coverage, blockers: [...new Set(blockers)].sort(), warnings };
}

function sourceIsExact(source: MechanicFact | undefined): boolean {
  if (source === undefined || source.provenance.length === 0) return false;
  if (source.kind === "modifierLine") {
    if (source.data.parseStatus !== "parsed") return false;
    const value = source.data.modifierProvenance;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).resolution === "exact";
  }
  if (source.kind === "parsedModifier") return source.data.classification !== "unknown";
  return source.provenance.every(({ kind }) => kind !== "projection" || source.active);
}

function verifyClaims(
  facts: MechanicFactBundle,
  compiled: readonly CompiledMechanicExperiment[],
  results: readonly MechanicExperimentResult[],
): { claims: MechanicClaim[]; proofs: MechanicProof[]; blockers: string[]; warnings: string[] } {
  const entities = new Map(facts.entities.map((entity) => [entity.id, entity]));
  const resultByClaim = new Map(results.filter(({ claimId }) => claimId !== undefined).map((result) => [result.claimId as string, result]));
  const proofs: MechanicProof[] = [];
  const claims: MechanicClaim[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  for (const entry of compiled) {
    let claim = entry.claim;
    if (entry.experiment !== undefined) {
      const result = resultByClaim.get(claim.id);
      if (result === undefined) {
        blockers.push(`Critical claim ${claim.id} has no counterfactual result`);
        proofs.push(MechanicProofSchema.parse({
          id: `proof:${claim.id}:counterfactual`, claimId: claim.id, type: "counterfactual",
          status: "indeterminate", context: claim.context, sourceFingerprint: facts.fingerprint,
          evidenceIds: [], experimentId: entry.experiment.id,
        }));
      } else {
        const delta = diffMechanicObservations(result.baseline, result.diagnostic);
        const finalMetricChanged = Object.keys(delta.metricChanges).length > 0
          || Object.keys(delta.resourceChanges).length > 0
          || Object.keys(delta.cooldownChanges).length > 0
          || Object.keys(delta.durationChanges).length > 0;
        const status = delta.changed ? "proven" : "indeterminate";
        if (!delta.changed) blockers.push(`Counterfactual produced zero contribution delta for critical claim ${claim.id}`);
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
      const exact = sourceIsExact(entities.get(claim.sourceId)) && entry.exactEvidenceIds.length > 0;
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
): Promise<{ claims: readonly MechanicClaimInput[]; inspected: readonly string[]; modelCalls: number }> {
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
  const remaining = Math.max(0, (dependencies.maxModelCalls ?? 16) - state.modelCalls);
  if (remaining === 0) return { claims: [], inspected: [...inspected], modelCalls: 0 };
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
      duplicateCallLimit: dependencies.duplicateCallLimit ?? 3,
      wallTimeMs: Number.MAX_SAFE_INTEGER,
    },
    signal,
    stopAfterTool: (_toolResult, current) => current.submittedClaims !== undefined,
  });
  if (result.fallback !== undefined) {
    throw new MechanicProviderError(result.fallback.detail, result.fallback.retryable);
  }
  if (session.submittedClaims === undefined || session.claimsComplete !== true) {
    return { claims: [], inspected: [...inspected].sort(), modelCalls: result.modelCalls };
  }
  return { claims: session.submittedClaims, inspected: [...inspected].sort(), modelCalls: result.modelCalls };
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
  const remaining = Math.max(0, (dependencies.maxModelCalls ?? 16) - state.modelCalls);
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
      duplicateCallLimit: dependencies.duplicateCallLimit ?? 3,
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

export function auditMechanicReport(raw: unknown): VerifiedBuildMechanicReport {
  const report = VerifiedBuildMechanicReportSchema.parse(raw);
  const proofById = new Map(report.proofs.map((proof) => [proof.id, proof]));
  const provenClaims = new Set(report.proofs.filter(({ status }) => status === "proven").map(({ claimId }) => claimId));
  const claimIds = new Set(report.claims.map(({ id }) => id));
  const auditBlockers: string[] = [];
  for (const claim of report.claims) {
    if (!provenClaims.has(claim.id)) auditBlockers.push(`Claim ${claim.id} has no valid proven proof`);
  }
  for (const edge of report.graph.edges) {
    if (!claimIds.has(edge.claimId)) auditBlockers.push(`Semantic edge ${edge.id} references unknown claim ${edge.claimId}`);
    for (const proofId of edge.proofIds) {
      const proof = proofById.get(proofId);
      if (proof === undefined || proof.claimId !== edge.claimId || proof.status !== "proven") {
        auditBlockers.push(`Semantic edge ${edge.id} references invalid proof ${proofId}`);
      }
    }
  }
  if (auditBlockers.length === 0) return report;
  const blockers = [...new Set([...report.blockers, ...auditBlockers])].sort();
  const audited = {
    ...report,
    status: "blocked" as const,
    blockers,
    findings: [
      ...report.findings,
      ...auditBlockers.map((message) => reportFinding(message, "blocker")),
    ],
    graph: {
      ...report.graph,
      edges: report.graph.edges.filter((edge) => edge.proofIds.every((proofId) => {
        const proof = proofById.get(proofId);
        return proof !== undefined && proof.claimId === edge.claimId && proof.status === "proven";
      })),
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
  const blockers = [...new Set([...state.blockers, ...criticBlockers])].sort();
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
    const report = cached?.success === true ? auditMechanicReport(cached.data) : undefined;
    progress(dependencies, { ...state, facts }, "ExtractFacts", 0.15, report === undefined ? "PoB fact bundle ready" : "Exact mechanic report cache hit");
    return { facts, report, phase: "ExtractFacts", trace: "ExtractFacts" };
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
    const max = dependencies.maxExperiments ?? 1024;
    const blockers = experiments.length > max
      ? [...state.blockers, `Critical experiment count ${experiments.length} exceeds limit ${max}`]
      : state.blockers;
    progress(dependencies, state, "CompileCriticalExperiments", 0.45, `Compiled ${experiments.length} critical experiments`);
    return { compiled, blockers, phase: "CompileCriticalExperiments", trace: "CompileCriticalExperiments" };
  };

  const runNode = async (state: GraphState): Promise<GraphUpdate> => {
    const facts = state.facts;
    if (facts === undefined) throw new Error("Mechanic facts are unavailable");
    const max = dependencies.maxExperiments ?? 1024;
    const experiments = state.compiled.flatMap(({ experiment }) => experiment === undefined ? [] : [experiment]).slice(0, max);
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
    return {
      submittedClaims: output.claims,
      inspectedEntityIds: output.inspected,
      modelCalls: state.modelCalls + output.modelCalls,
      repairRounds: state.repairRounds + 1,
      blockers: [],
      warnings: [],
      proofs: [],
      experimentResults: [],
      review: undefined,
      phase: "RepairClaims",
      trace: "RepairClaims",
    };
  };

  const finalizeNode = (state: GraphState): GraphUpdate => {
    const report = state.report ?? finalizeReport(dependencies, state);
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
      const maxRepair = dependencies.maxRepairRounds ?? 3;
      const maxCalls = dependencies.maxModelCalls ?? 16;
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
    const maxRepairRounds = Math.max(0, this.#dependencies.maxRepairRounds ?? 3);
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
    return auditMechanicReport(result.report);
  }
}
