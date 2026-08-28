import { z } from "zod";
import {
  ConditionEvidenceSchema,
  ScenarioSpecSchema,
  type ConditionEvidence,
  type EvidenceStatus,
  type ScenarioSpec,
} from "../schemas.js";
import { SUSTAINABLE_UPTIME_THRESHOLD } from "./scenarios.js";

export const ConditionTriggerSchema = z.enum([
  "always",
  "onKill",
  "onHit",
  "onCrit",
  "onBlock",
  "onUse",
  "recently",
  "flask",
  "manual",
  "unknown",
]);
export type ConditionTrigger = z.infer<typeof ConditionTriggerSchema>;

export const ConditionSourceSchema = z.object({
  id: z.string().min(1),
  trigger: ConditionTriggerSchema,
  triggerChain: z.array(z.string().min(1)).default([]),
  uptime: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).default(1),
  valid: z.boolean().default(true),
  resourcesSustainable: z.boolean().default(true),
  requiresAdds: z.boolean().default(false),
  peakOnly: z.boolean().default(false),
  reason: z.string().min(1).optional(),
});
export type ConditionSource = z.infer<typeof ConditionSourceSchema>;

export const ConditionClaimSchema = z.object({
  condition: z.string().min(1),
  configKey: z.string().min(1).optional(),
  value: z.unknown().optional(),
  sources: z.array(ConditionSourceSchema).default([]),
  conflictsWith: z.array(z.string().min(1)).default([]),
  manual: z.boolean().default(false),
  preference: z.number().finite().default(0),
});
export type ConditionClaim = z.infer<typeof ConditionClaimSchema>;
export type ConditionClaimInput = z.input<typeof ConditionClaimSchema>;

interface EvaluatedCondition {
  readonly claim: ConditionClaim;
  readonly evidence: ConditionEvidence;
  readonly eligible: boolean;
}

export interface ConditionResolution {
  readonly evidence: readonly ConditionEvidence[];
  readonly enabledConditions: readonly string[];
}

export interface ConditionVariant extends ConditionResolution {
  readonly id: string;
}

function booleanAssumption(scenario: ScenarioSpec, name: string, fallback: boolean): boolean {
  const value = scenario.assumptions[name];
  return typeof value === "boolean" ? value : fallback;
}

function thresholdFor(scenario: ScenarioSpec): number {
  const value = scenario.assumptions.sustainableUptimeThreshold;
  return typeof value === "number" && value >= 0 && value <= 1
    ? value
    : SUSTAINABLE_UPTIME_THRESHOLD;
}

function sourceUptime(source: ConditionSource): number | undefined {
  if (source.uptime !== undefined) return source.uptime;
  return source.trigger === "always" ? 1 : undefined;
}

function eventAllowed(source: ConditionSource, scenario: ScenarioSpec): boolean {
  if (source.trigger === "always") return true;
  if (source.trigger === "flask") return scenario.allowedEvents.includes("onUse");
  if (source.trigger === "manual" || source.trigger === "unknown") return false;
  return scenario.allowedEvents.includes(source.trigger);
}

function isSourceAvailable(source: ConditionSource, scenario: ScenarioSpec): boolean {
  if (!source.valid || !eventAllowed(source, scenario)) return false;
  if (source.requiresAdds && !booleanAssumption(scenario, "adds", false)) return false;
  if (source.trigger === "onKill" && !booleanAssumption(scenario, "onKill", false)) return false;
  return true;
}

function evidence(
  claim: ConditionClaim,
  scenario: ScenarioSpec,
  status: EvidenceStatus,
  sources: readonly ConditionSource[],
  reason: string,
  uptime?: number,
): ConditionEvidence {
  const confidence = sources.length === 0
    ? 0
    : Math.max(...sources.map((source) => source.confidence));
  const triggerSource = [...sources].sort((left, right) =>
    (sourceUptime(right) ?? -1) - (sourceUptime(left) ?? -1))[0];
  return ConditionEvidenceSchema.parse({
    condition: claim.condition,
    ...(claim.configKey === undefined ? {} : { configKey: claim.configKey }),
    ...(claim.value === undefined ? {} : { value: claim.value }),
    scenario: scenario.id,
    profile: scenario.profile,
    status,
    sources: sources.map((source) => source.id),
    triggerChain: triggerSource?.triggerChain ?? [],
    ...(uptime === undefined ? {} : { uptime }),
    conflictsWith: claim.conflictsWith,
    confidence,
    reason,
  });
}

function evaluateClaim(rawClaim: ConditionClaimInput, scenario: ScenarioSpec): EvaluatedCondition {
  const claim = ConditionClaimSchema.parse(rawClaim);
  const automaticSources = claim.sources.filter((source) => source.trigger !== "manual");
  const validSources = automaticSources.filter((source) => source.valid);
  const available = validSources.filter((source) => isSourceAvailable(source, scenario));
  const knownUptimes = available
    .map(sourceUptime)
    .filter((uptime): uptime is number => uptime !== undefined);
  const uptime = knownUptimes.length === 0 ? undefined : Math.max(...knownUptimes);
  const threshold = thresholdFor(scenario);
  const sustainable = available.filter((source) => {
    const sourceAvailability = sourceUptime(source);
    return !source.peakOnly
      && source.resourcesSustainable
      && sourceAvailability !== undefined
      && sourceAvailability >= threshold;
  });

  if (sustainable.length > 0) {
    return {
      claim,
      evidence: evidence(
        claim,
        scenario,
        "proven_sustainable",
        sustainable,
        `Legal source chain reaches at least ${(threshold * 100).toFixed(0)}% uptime`,
        Math.max(...sustainable.map((source) => sourceUptime(source) ?? 0)),
      ),
      eligible: true,
    };
  }

  const peakAvailable = available.filter((source) => (sourceUptime(source) ?? 0) > 0);
  if (scenario.profile === "peak" && peakAvailable.length > 0) {
    return {
      claim,
      evidence: evidence(
        claim,
        scenario,
        "proven_peak",
        peakAvailable,
        "Legal temporary source exists, but sustained uptime is not proven",
        Math.max(...peakAvailable.map((source) => sourceUptime(source) ?? 0)),
      ),
      eligible: true,
    };
  }

  if (peakAvailable.length > 0) {
    return {
      claim,
      evidence: evidence(
        claim,
        scenario,
        "intermittent",
        peakAvailable,
        `Available source does not reach ${(threshold * 100).toFixed(0)}% sustainable uptime`,
        uptime,
      ),
      eligible: false,
    };
  }

  if (claim.manual || claim.sources.some((source) => source.trigger === "manual")) {
    return {
      claim,
      evidence: evidence(
        claim,
        scenario,
        "manual",
        claim.sources.filter((source) => source.trigger === "manual"),
        "Condition is asserted manually and has no automatic proof",
      ),
      eligible: false,
    };
  }

  if (claim.sources.length === 0 || automaticSources.every((source) => source.trigger === "unknown")) {
    return {
      claim,
      evidence: evidence(claim, scenario, "unknown", [], "No known source chain"),
      eligible: false,
    };
  }

  const invalidOnly = validSources.length === 0;
  const blockedByBossRules = validSources.some((source) =>
    (source.trigger === "onKill" || source.requiresAdds)
    && !booleanAssumption(scenario, "adds", false));
  const reason = invalidOnly
    ? "All known sources are invalid"
    : blockedByBossRules
      ? "Source requires kills or adds, which this boss scenario forbids"
      : "No legal source is available in this scenario";
  return {
    claim,
    evidence: evidence(claim, scenario, "impossible", validSources, reason),
    eligible: false,
  };
}

function conflictSet(claim: ConditionClaim): ReadonlySet<string> {
  return new Set(claim.conflictsWith);
}

function rank(left: EvaluatedCondition, right: EvaluatedCondition): number {
  if (left.claim.preference !== right.claim.preference) return right.claim.preference - left.claim.preference;
  const uptimeDifference = (right.evidence.uptime ?? 0) - (left.evidence.uptime ?? 0);
  if (uptimeDifference !== 0) return uptimeDifference;
  if (left.evidence.confidence !== right.evidence.confidence) {
    return right.evidence.confidence - left.evidence.confidence;
  }
  return left.claim.condition.localeCompare(right.claim.condition);
}

function conflicts(left: EvaluatedCondition, right: EvaluatedCondition): boolean {
  return conflictSet(left.claim).has(right.claim.condition)
    || conflictSet(right.claim).has(left.claim.condition);
}

function resolveEvaluated(
  evaluated: readonly EvaluatedCondition[],
  preferredCondition?: string,
): ConditionResolution {
  const eligible = evaluated.filter((entry) => entry.eligible).sort(rank);
  if (preferredCondition !== undefined) {
    eligible.sort((left, right) => {
      if (left.claim.condition === preferredCondition) return -1;
      if (right.claim.condition === preferredCondition) return 1;
      return rank(left, right);
    });
  }

  const accepted: EvaluatedCondition[] = [];
  const rejected = new Set<string>();
  for (const candidate of eligible) {
    if (accepted.some((current) => conflicts(current, candidate))) {
      rejected.add(candidate.claim.condition);
    } else {
      accepted.push(candidate);
    }
  }

  const acceptedIds = new Set(accepted.map((entry) => entry.claim.condition));
  const finalEvidence = evaluated.map((entry): ConditionEvidence => {
    if (!rejected.has(entry.claim.condition)) return entry.evidence;
    const blockers = accepted
      .filter((acceptedEntry) => conflicts(acceptedEntry, entry))
      .map((acceptedEntry) => acceptedEntry.claim.condition);
    return ConditionEvidenceSchema.parse({
      ...entry.evidence,
      status: "conflicting",
      conflictsWith: [...new Set([...entry.evidence.conflictsWith, ...blockers])].sort(),
      reason: `Excluded by mutually exclusive condition: ${blockers.join(", ")}`,
    });
  });
  return {
    evidence: finalEvidence,
    enabledConditions: [...acceptedIds].sort(),
  };
}

/** Proves conditions and returns only settings safe to auto-enable for the scenario profile. */
export function resolveConditionEvidence(
  claims: readonly ConditionClaimInput[],
  scenario: ScenarioSpec,
): ConditionResolution {
  const parsedScenario = ScenarioSpecSchema.parse(scenario);
  const evaluated = claims.map((claim) => evaluateClaim(claim, parsedScenario));
  return resolveEvaluated(evaluated);
}

/**
 * Produces distinct compatible configurations for mutually exclusive conditions.
 * First entry is the deterministic primary configuration.
 */
export function createConditionVariants(
  claims: readonly ConditionClaimInput[],
  scenario: ScenarioSpec,
  maximumVariants = 8,
): ConditionVariant[] {
  if (!Number.isInteger(maximumVariants) || maximumVariants < 1) {
    throw new RangeError("maximumVariants must be a positive integer");
  }
  const parsedScenario = ScenarioSpecSchema.parse(scenario);
  const evaluated = claims.map((claim) => evaluateClaim(claim, parsedScenario));
  const primary = resolveEvaluated(evaluated);
  const candidates = evaluated.filter((entry) => entry.eligible).sort(rank);
  const resolutions = [primary, ...candidates.map((entry) =>
    resolveEvaluated(evaluated, entry.claim.condition))];
  const seen = new Set<string>();
  const variants: ConditionVariant[] = [];
  for (const resolution of resolutions) {
    const key = resolution.enabledConditions.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({
      id: `${parsedScenario.id}:${parsedScenario.profile}:${variants.length + 1}`,
      ...resolution,
    });
    if (variants.length >= maximumVariants) break;
  }
  return variants;
}
