import { describe, expect, it } from "vitest";
import {
  NativeProbeBundleSchema,
  compatibleSupports,
  isCompleteNativeProbe,
  nativeClaimsAsConditionInputs,
  nativeEvidenceFingerprint,
  parseNativeProbe,
  resolveNativeCandidateEvidence,
  supportId,
} from "../src/domain/nativeProbe.js";
import { generateStandardScenarios } from "../src/domain/scenarios.js";

function probeValue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const source = {
    id: "player:conditionOnslaught:item:1",
    trigger: "always",
    triggerChain: ["item:1"],
    uptime: 1,
    confidence: 1,
    valid: true,
    resourcesSustainable: true,
    requiresAdds: false,
    peakOnly: false,
  };
  const evidence = {
    schemaVersion: 1,
    complete: true,
    truncated: false,
    engineVersion: "2.67.2",
    dataVersion: "3.29",
    claims: [{
      condition: "conditionOnslaught", configKey: "conditionOnslaught", value: true, active: true, actor: "player", sources: [source],
      dependencies: [{
        id: "dependency:player:conditionOnslaught:consumer:1",
        name: "Damage",
        source: "consumer:1",
        reason: "PoB modifier consumes this condition",
      }],
    }],
    nativeUptime: { OnslaughtUptime: 1 },
    probeFingerprint: "evidence-fingerprint",
  };
  const links = {
    schemaVersion: 1,
    complete: true,
    truncated: false,
    engineVersion: "2.67.2",
    dataVersion: "3.29",
    groups: [{
      index: 1,
      enabled: true,
      noSupports: false,
      crossLinkedSupportSlots: [],
      capacity: 2,
      gems: [{ index: 1, name: "Fireball", enabled: true, support: false }],
      activeSkills: [{ index: 1, id: "Fireball", name: "Fireball", skillTypes: [], minionSkillTypes: [], acceptedSupportIds: [], acceptedSupportNames: [] }],
      currentSupports: [],
      supports: [{
        id: supportId("SupportGemSpellEcho", "SupportSpellEcho"),
        gemId: "SupportGemSpellEcho",
        gameId: "Metadata/Items/Gems/SupportGemSpellEcho",
        variantId: "SpellEcho",
        grantedEffectId: "SupportSpellEcho",
        name: "Spell Echo",
        acceptedBy: [1],
        acceptedByIds: ["Fireball"],
        available: true,
      }],
    }],
    probeFingerprint: "links-fingerprint",
  };
  return {
    jobId: "run:probe:candidate",
    candidateId: "candidate",
    operation: "probe",
    candidateFingerprint: "candidate-fingerprint",
    nativeLinkProbe: links,
    nativeEvidence: evidence,
    nativeEvidenceByScenario: { "mapping:sustainable": evidence },
    diagnostics: [],
    ...overrides,
  };
}

describe("native worker probe domain", () => {
  it("parses complete native link/evidence bundles and filters compatible supports", () => {
    const probe = parseNativeProbe(probeValue());
    expect(NativeProbeBundleSchema.parse(probe)).toEqual(probe);
    expect(isCompleteNativeProbe(probe)).toBe(true);
    expect(compatibleSupports(probe.nativeLinkProbe, 1).map(({ name }) => name)).toEqual(["Spell Echo"]);
    expect(compatibleSupports(probe.nativeLinkProbe, 9)).toEqual([]);
  });

  it("merges duplicate native claims by stable source id and skips incomplete facts", () => {
    const value = probeValue();
    const duplicateValue = probeValue();
    const duplicateEvidence = duplicateValue.nativeEvidence as Record<string, unknown>;
    const duplicateClaims = duplicateEvidence.claims as Record<string, unknown>[];
    const duplicateClaim = duplicateClaims[0];
    if (duplicateClaim === undefined) throw new Error("fixture claim missing");
    duplicateClaim.sources = [{
      id: "player:conditionOnslaught:item:1",
      trigger: "always",
      triggerChain: ["duplicate"],
      uptime: 1,
      confidence: 1,
      valid: true,
      resourcesSustainable: true,
      requiresAdds: false,
      peakOnly: false,
    }];
    const parsed = parseNativeProbe(value);
    const parsedDuplicate = parseNativeProbe(duplicateValue);
    const claims = nativeClaimsAsConditionInputs([parsed.nativeEvidence, parsedDuplicate.nativeEvidence]);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.sources).toHaveLength(1);
    expect(claims[0]?.sources?.[0]?.id).not.toContain("dependency:");
    const inactive = parseNativeProbe({
      ...value,
      nativeEvidence: {
        ...parsed.nativeEvidence,
        claims: parsed.nativeEvidence.claims.map((claim) => ({ ...claim, active: false })),
      },
    });
    expect(nativeClaimsAsConditionInputs([inactive.nativeEvidence])).toEqual([]);
    const incomplete = parseNativeProbe({ ...value, nativeEvidence: { ...parsed.nativeEvidence, complete: false } });
    expect(nativeClaimsAsConditionInputs([incomplete.nativeEvidence])).toEqual([]);
  });

  it("binds evidence fingerprint to candidate and native probe fingerprints", () => {
    const probe = parseNativeProbe(probeValue());
    const first = nativeEvidenceFingerprint(probe, [{ scenario: "mapping", profile: "sustainable" }]);
    const second = nativeEvidenceFingerprint(probe, [{ scenario: "mapping", profile: "sustainable" }]);
    const changed = nativeEvidenceFingerprint(probe, [{ scenario: "uber", profile: "sustainable" }]);
    expect(first).toBe(second);
    expect(changed).not.toBe(first);
  });

  it("rejects an incomplete or truncated link probe for safe search", () => {
    const value = probeValue({ nativeLinkProbe: { ...probeValue().nativeLinkProbe as object, complete: false } });
    const parsed = parseNativeProbe(value);
    expect(isCompleteNativeProbe(parsed)).toBe(false);
    expect(compatibleSupports(parsed.nativeLinkProbe, 1)).toEqual([]);
  });

  it("resolves candidate-native claims and binds evidence fingerprints", () => {
    const probe = parseNativeProbe(probeValue());
    const scenario = generateStandardScenarios()[0];
    if (scenario === undefined) throw new Error("scenario fixture missing");
    const resolved = resolveNativeCandidateEvidence(probe, scenario);
    expect(resolved.enabledConditions).toEqual(["conditionOnslaught"]);
    expect(resolved.evidence[0]?.status).toBe("proven_sustainable");
    expect(resolved.evidence[0]?.nativeProbeFingerprint).toBe("links-fingerprint");
    expect(resolved.evidence[0]?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
