import { z } from "zod";
import {
  ConditionSourceSchema,
  resolveConditionEvidence,
  type ConditionClaimInput,
  type ConditionResolution,
  type ConditionSource,
} from "./evidence.js";
import { canonicalHash } from "../search/canonical.js";
import { ConditionEvidenceSchema, type ScenarioSpec } from "../schemas.js";

export const NATIVE_PROBE_SCHEMA_VERSION = 1 as const;

const JsonRecordSchema = z.record(z.string(), z.unknown());

export const NativeLinkActiveSkillSchema = z.object({
  index: z.number().int().positive(),
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  support: z.boolean().optional(),
  unsupported: z.boolean().optional(),
  cannotBeSupported: z.boolean().optional(),
  fromItem: z.boolean().optional(),
  actor: z.string().min(1).optional(),
  skillTypes: z.array(z.string()).default([]),
  minionSkillTypes: z.array(z.string()).default([]),
  acceptedSupportIds: z.array(z.string()).default([]),
  acceptedSupportNames: z.array(z.string()).default([]),
});
export type NativeLinkActiveSkill = z.infer<typeof NativeLinkActiveSkillSchema>;

export const NativeLinkSupportSchema = z.object({
  id: z.string().min(1),
  gemId: z.string().min(1),
  gameId: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
  grantedEffectId: z.string().min(1),
  name: z.string().min(1).optional(),
  acceptedBy: z.array(z.number().int().positive()).default([]),
  acceptedByIds: z.array(z.string().min(1)).default([]),
  available: z.boolean().default(true),
});
export type NativeLinkSupport = z.infer<typeof NativeLinkSupportSchema>;

export const NativeLinkGemSchema = z.object({
  index: z.number().int().positive(),
  name: z.string().min(1).optional(),
  gemId: z.string().min(1).optional(),
  gameId: z.string().min(1).optional(),
  variantId: z.string().min(1).optional(),
  grantedEffectId: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  support: z.boolean().default(false),
});

export const NativeLinkGroupSchema = z.object({
  index: z.number().int().positive(),
  slot: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  crossLinkedSupportSlots: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
  noSupports: z.boolean().default(false),
  capacity: z.number().int().nonnegative(),
  gems: z.array(NativeLinkGemSchema).default([]),
  activeSkills: z.array(NativeLinkActiveSkillSchema).default([]),
  currentSupports: z.array(z.object({
    grantedEffectId: z.string().min(1),
    name: z.string().min(1).optional(),
    context: JsonRecordSchema.default({}),
  })).default([]),
  supports: z.array(NativeLinkSupportSchema).default([]),
});
export type NativeLinkGroup = z.infer<typeof NativeLinkGroupSchema>;

export const NativeLinkProbeSchema = z.object({
  schemaVersion: z.literal(NATIVE_PROBE_SCHEMA_VERSION),
  complete: z.boolean(),
  truncated: z.boolean().default(false),
  engineVersion: z.string().min(1),
  dataVersion: z.string().min(1),
  groups: z.array(NativeLinkGroupSchema),
  probeFingerprint: z.string().min(1),
  nativeProbeFingerprint: z.string().min(1).optional(),
});
export type NativeLinkProbe = z.infer<typeof NativeLinkProbeSchema>;

export const NativeConditionSourceSchema = ConditionSourceSchema.extend({
  actor: z.string().min(1).optional(),
}).passthrough();
export type NativeConditionSource = z.infer<typeof NativeConditionSourceSchema>;

export const NativeConditionClaimSchema = z.object({
  condition: z.string().min(1),
  configKey: z.string().min(1).optional(),
  value: z.unknown().optional(),
  actor: z.string().min(1).optional(),
  sources: z.array(NativeConditionSourceSchema).default([]),
}).passthrough();
export type NativeConditionClaim = z.infer<typeof NativeConditionClaimSchema>;

export const NativeEvidenceProbeSchema = z.object({
  schemaVersion: z.literal(NATIVE_PROBE_SCHEMA_VERSION),
  complete: z.boolean(),
  truncated: z.boolean().default(false),
  engineVersion: z.string().min(1),
  dataVersion: z.string().min(1),
  claims: z.array(NativeConditionClaimSchema).default([]),
  nativeUptime: z.record(z.string(), z.number().finite()).default({}),
  probeFingerprint: z.string().min(1),
  evidenceFingerprint: z.string().min(1).optional(),
});
export type NativeEvidenceProbe = z.infer<typeof NativeEvidenceProbeSchema>;

export const NativeProbeBundleSchema = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
  operation: z.literal("probe"),
  candidateFingerprint: z.string().min(1),
  nativeProbeFingerprint: z.string().min(1).optional(),
  evidenceFingerprint: z.string().min(1).optional(),
  nativeLinkProbe: NativeLinkProbeSchema,
  nativeEvidence: NativeEvidenceProbeSchema,
  nativeEvidenceByScenario: z.record(z.string(), NativeEvidenceProbeSchema).default({}),
  diagnostics: z.array(z.string()).default([]),
});
export type NativeProbeBundle = z.infer<typeof NativeProbeBundleSchema>;

export function parseNativeProbe(value: unknown): NativeProbeBundle {
  return NativeProbeBundleSchema.parse(value);
}

export function isCompleteNativeProbe(value: NativeProbeBundle): boolean {
  return value.nativeLinkProbe.complete
    && !value.nativeLinkProbe.truncated
    && value.nativeEvidence.complete
    && !value.nativeEvidence.truncated
    && Object.values(value.nativeEvidenceByScenario).every((entry) => entry.complete && !entry.truncated);
}

export function supportId(gemId: string, grantedEffectId: string): string {
  return `${gemId}#${grantedEffectId}`;
}

export function compatibleSupports(probe: NativeLinkProbe, groupIndex: number): readonly NativeLinkSupport[] {
  const group = probe.groups.find((entry) => entry.index === groupIndex);
  if (!group || group.noSupports || !probe.complete || probe.truncated) return [];
  return group.supports.filter((support) =>
    support.available && (support.acceptedBy.length > 0 || support.acceptedByIds.length > 0));
}

/** Merge native facts into resolver input while preserving deterministic IDs. */
export function nativeClaimsAsConditionInputs(
  probes: readonly NativeEvidenceProbe[],
): readonly ConditionClaimInput[] {
  const merged = new Map<string, {
    condition: string;
    configKey?: string;
    value?: unknown;
    sources: Map<string, ConditionSource>;
  }>();
  for (const probe of probes) {
    if (!probe.complete || probe.truncated) continue;
    for (const rawClaim of probe.claims) {
      const existing = merged.get(rawClaim.condition) ?? {
        condition: rawClaim.condition,
        ...(rawClaim.configKey === undefined ? {} : { configKey: rawClaim.configKey }),
        ...(rawClaim.value === undefined ? {} : { value: rawClaim.value }),
        sources: new Map<string, ConditionSource>(),
      };
      for (const source of rawClaim.sources) existing.sources.set(source.id, source);
      merged.set(rawClaim.condition, existing);
    }
  }
  return [...merged.values()]
    .sort((left, right) => left.condition.localeCompare(right.condition))
    .map((claim) => ({
      condition: claim.condition,
      ...(claim.configKey === undefined ? {} : { configKey: claim.configKey }),
      ...(claim.value === undefined ? {} : { value: claim.value }),
      sources: [...claim.sources.values()].sort((left, right) => left.id.localeCompare(right.id)),
    }));
}

export function nativeEvidenceFingerprint(
  probe: NativeProbeBundle,
  scenarioEvidence: readonly unknown[] = [],
): string {
  return canonicalHash({
    candidateFingerprint: probe.candidateFingerprint,
    linkProbe: probe.nativeProbeFingerprint
      ?? probe.nativeLinkProbe.nativeProbeFingerprint
      ?? probe.nativeLinkProbe.probeFingerprint,
    evidenceProbe: probe.evidenceFingerprint
      ?? probe.nativeEvidence.evidenceFingerprint
      ?? probe.nativeEvidence.probeFingerprint,
    scenarioEvidence: [...scenarioEvidence],
  });
}

/**
 * Resolve candidate-native facts for one Scenario. Incomplete or truncated
 * native output returns no enabled conditions (fail-closed). Evidence carries
 * the link-probe and per-source fingerprints so a Candidate cannot reuse
 * facts from a different build or calculator run.
 */
export function resolveNativeCandidateEvidence(
  bundle: NativeProbeBundle,
  scenario: ScenarioSpec,
): ConditionResolution {
  if (!isCompleteNativeProbe(bundle)) return { evidence: [], enabledConditions: [] };
  const key = `${scenario.id}:${scenario.profile}`;
  const scenarioProbe = bundle.nativeEvidenceByScenario[key];
  // Ranked scenarios require their own post-Scenario.Apply native output. A
  // candidate baseline cannot stand in for a missing scenario probe.
  if (scenarioProbe === undefined) return { evidence: [], enabledConditions: [] };
  if (!scenarioProbe.complete || scenarioProbe.truncated) return { evidence: [], enabledConditions: [] };
  const claims = nativeClaimsAsConditionInputs([bundle.nativeEvidence, scenarioProbe]);
  const resolved = resolveConditionEvidence(claims, scenario);
  const linkFingerprint = bundle.nativeLinkProbe.nativeProbeFingerprint
    ?? bundle.nativeLinkProbe.probeFingerprint;
  const evidenceFingerprint = nativeEvidenceFingerprint(bundle, [key, scenarioProbe.probeFingerprint]);
  return {
    enabledConditions: resolved.enabledConditions,
    evidence: resolved.evidence.map((entry) => ConditionEvidenceSchema.parse({
      ...entry,
      nativeProbeFingerprint: linkFingerprint,
      sourceFingerprint: canonicalHash({
        candidateFingerprint: bundle.candidateFingerprint,
        evidenceFingerprint,
        scenario: key,
        condition: entry.condition,
        sources: entry.sources,
      }),
      coverageStatus: "proven",
    })),
  };
}
