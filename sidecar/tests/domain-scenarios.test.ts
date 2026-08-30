import { describe, expect, it } from "vitest";
import {
  createConditionVariants,
  createCurrentDiagnosticScenario,
  generateStandardScenarios,
  isRankedScenario,
  resolveConditionEvidence,
  type ConditionClaimInput,
} from "../src/domain/index.js";

function scenario(id: "mapping" | "standardBoss", profile: "sustainable" | "peak") {
  const found = generateStandardScenarios().find((candidate) =>
    candidate.id === id && candidate.profile === profile);
  if (found === undefined) throw new Error(`Missing scenario ${id}:${profile}`);
  return found;
}

describe("standard scenarios", () => {
  it("creates four sustainable profiles and four non-ranking Peak profiles", () => {
    const scenarios = generateStandardScenarios({ mapModifiers: ["-12% maximum resistances"] });
    expect(scenarios).toHaveLength(8);
    expect(scenarios.filter((entry) => entry.profile === "sustainable").map((entry) => entry.id)).toEqual([
      "mapping", "standardBoss", "pinnacle", "uber",
    ]);
    expect(scenarios.filter((entry) => entry.profile === "peak")).toHaveLength(4);

    const mapping = scenarios[0];
    const boss = scenarios[1];
    expect(mapping?.enemyIsBoss).toBe("None");
    expect(mapping?.allowedEvents).toContain("onKill");
    expect(mapping?.mapModifiers).toEqual(["-12% maximum resistances"]);
    expect(boss?.enemyIsBoss).toBe("Boss");
    expect(boss?.allowedEvents).not.toContain("onKill");
    expect(boss?.assumptions.adds).toBe(false);
  });

  it("keeps Current as a diagnostic rather than a ranked scenario", () => {
    const current = createCurrentDiagnosticScenario("Pinnacle", { userCheckedBuffs: true });
    expect(current.profile).toBe("current");
    expect(current.assumptions.preserveManualConfiguration).toBe(true);
    expect(isRankedScenario(current)).toBe(false);
  });
});

describe("condition proof", () => {
  const claims: ConditionClaimInput[] = [
    {
      condition: "frenzyCharges",
      sources: [{
        id: "gain-frenzy-on-kill",
        trigger: "onKill",
        uptime: 0.95,
        requiresAdds: true,
      }],
    },
    {
      condition: "permanentAura",
      sources: [{ id: "reserved-aura", trigger: "always" }],
    },
    {
      condition: "temporaryFlask",
      sources: [{ id: "flask", trigger: "flask", uptime: 0.6 }],
    },
    { condition: "manualShock", manual: true },
    { condition: "unknownBuff", sources: [{ id: "mystery", trigger: "unknown" }] },
  ];

  it("allows on-kill proof while mapping but forbids it for bosses without adds", () => {
    const mapping = resolveConditionEvidence(claims, scenario("mapping", "sustainable"));
    const boss = resolveConditionEvidence(claims, scenario("standardBoss", "sustainable"));

    expect(mapping.enabledConditions).toEqual(["frenzyCharges", "permanentAura"]);
    expect(mapping.evidence.find((entry) => entry.condition === "frenzyCharges")?.status)
      .toBe("proven_sustainable");
    expect(boss.evidence.find((entry) => entry.condition === "frenzyCharges")?.status)
      .toBe("impossible");
    expect(boss.enabledConditions).toEqual(["permanentAura"]);
  });

  it("uses the 90% threshold and moves legal temporary conditions to Peak only", () => {
    const thresholdClaims: ConditionClaimInput[] = [
      { condition: "exact", sources: [{ id: "exact-source", trigger: "onHit", uptime: 0.9 }] },
      { condition: "below", sources: [{ id: "below-source", trigger: "onHit", uptime: 0.899 }] },
    ];
    const sustainable = resolveConditionEvidence(
      [...claims, ...thresholdClaims],
      scenario("mapping", "sustainable"),
    );
    const peak = resolveConditionEvidence(claims, scenario("mapping", "peak"));

    expect(sustainable.enabledConditions).toContain("exact");
    expect(sustainable.enabledConditions).not.toContain("below");
    expect(sustainable.evidence.find((entry) => entry.condition === "below")?.status)
      .toBe("intermittent");
    expect(peak.enabledConditions).toContain("temporaryFlask");
    expect(peak.evidence.find((entry) => entry.condition === "temporaryFlask")?.status)
      .toBe("proven_peak");
    expect(peak.evidence.find((entry) => entry.condition === "temporaryFlask")?.profile)
      .toBe("peak");
    expect(sustainable.evidence.find((entry) => entry.condition === "exact")?.profile)
      .toBe("sustainable");
  });

  it("never auto-enables manual or unknown conditions", () => {
    const result = resolveConditionEvidence(claims, scenario("mapping", "sustainable"));
    expect(result.evidence.find((entry) => entry.condition === "manualShock")?.status).toBe("manual");
    expect(result.evidence.find((entry) => entry.condition === "unknownBuff")?.status).toBe("unknown");
    expect(result.enabledConditions).not.toContain("manualShock");
    expect(result.enabledConditions).not.toContain("unknownBuff");
  });

  it("splits mutually exclusive legal states into deterministic variants", () => {
    const conflicting: ConditionClaimInput[] = [
      {
        condition: "stanceA",
        preference: 2,
        conflictsWith: ["stanceB"],
        sources: [{ id: "a", trigger: "always" }],
      },
      {
        condition: "stanceB",
        preference: 1,
        conflictsWith: ["stanceA"],
        sources: [{ id: "b", trigger: "always" }],
      },
    ];
    const variants = createConditionVariants(conflicting, scenario("mapping", "sustainable"));

    expect(variants.map((variant) => variant.enabledConditions)).toEqual([["stanceA"], ["stanceB"]]);
    expect(variants[0]?.evidence.find((entry) => entry.condition === "stanceB")?.status)
      .toBe("conflicting");
    expect(variants.every((variant) => variant.enabledConditions.length === 1)).toBe(true);
  });
});
