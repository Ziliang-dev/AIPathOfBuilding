import { describe, expect, it } from "vitest";
import { generateStandardScenarios } from "../src/domain/scenarios.js";
import type { BuildAction, ConditionEvidence } from "../src/schemas.js";
import {
  InMemoryWorkerPool,
  NativeProbeWorkerPool,
  type PobWorkerEvaluatePayload,
  type WorkerEvaluation,
} from "../src/worker/index.js";

function scenario() {
  const value = generateStandardScenarios().find((entry) =>
    entry.id === "mapping" && entry.profile === "sustainable");
  if (value === undefined) throw new Error("mapping scenario fixture missing");
  return value;
}

function probeResult(grantedEffectId = "SupportSpellEcho", capacity = 2): WorkerEvaluation {
  const evidence = {
    schemaVersion: 1,
    complete: true,
    truncated: false,
    engineVersion: "test-engine",
    dataVersion: "3_29",
    claims: [{
      condition: "conditionOnslaught",
      configKey: "conditionOnslaught",
      value: true,
      sources: [{
        id: "player:item:onslaught",
        trigger: "always",
        triggerChain: ["item:1"],
        uptime: 1,
        confidence: 1,
        valid: true,
        resourcesSustainable: true,
        requiresAdds: false,
        peakOnly: false,
      }],
    }],
    nativeUptime: { OnslaughtUptime: 1 },
    probeFingerprint: "native-evidence:mapping",
  };
  return {
    jobId: "probe-job",
    candidateId: "candidate:links",
    operation: "probe",
    candidateFingerprint: "candidate:fingerprint",
    nativeProbeFingerprint: "native-links:fingerprint",
    nativeLinkProbe: {
      schemaVersion: 1,
      complete: true,
      truncated: false,
      engineVersion: "test-engine",
      dataVersion: "3_29",
      groups: [{
        index: 1,
        enabled: true,
        noSupports: false,
        capacity,
        crossLinkedSupportSlots: [],
        gems: [
          { index: 1, name: "Fireball", grantedEffectId: "Fireball", enabled: true, support: false },
          { index: 2, name: "Spell Echo", grantedEffectId, enabled: true, support: true },
        ],
        activeSkills: [{
          index: 1,
          id: "Fireball",
          name: "Fireball",
          skillTypes: [],
          minionSkillTypes: [],
          acceptedSupportIds: ["SupportSpellEcho"],
          acceptedSupportNames: ["Spell Echo"],
        }],
        currentSupports: [],
        supports: [],
      }],
      probeFingerprint: "native-links:fingerprint",
    },
    nativeEvidence: evidence,
    nativeEvidenceByScenario: { "mapping:sustainable": evidence },
    diagnostics: [],
    metricsByScenario: {},
  };
}

function job() {
  const mapping = scenario();
  const staticEvidence: ConditionEvidence = {
    condition: "conditionFortified",
    scenario: "mapping",
    profile: "sustainable",
    status: "manual",
    sources: [],
    triggerChain: [],
    conflictsWith: [],
    confidence: 0,
    reason: "Golden static evidence",
  };
  const action: BuildAction = {
    id: "action:links",
    kind: "replaceSkillLinks",
    description: "Use native-compatible support",
    dependsOn: [],
    preconditions: { baseFingerprint: "build:fingerprint" },
    reversible: true,
    payload: { group: 1, gems: ["Fireball", "Spell Echo"] },
  };
  return {
    id: "job:links",
    runId: "run:links",
    candidateId: "candidate:links",
    buildFingerprint: "build:fingerprint",
    scenarios: ["mapping"],
    payload: {
      operation: "evaluate" as const,
      xml: "<PathOfBuilding/>",
      actions: [action],
      scenarios: [mapping],
      evidence: [staticEvidence],
    },
  };
}

describe("NativeProbeWorkerPool", () => {
  it("enforces probe-before-evaluate and binds merged candidate evidence", async () => {
    const operations: string[] = [];
    let evaluatedEvidence: unknown;
    const delegate = new InMemoryWorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation>(1, (entry) => {
      operations.push(entry.payload.operation ?? "evaluate");
      if (entry.payload.operation === "probe") return probeResult();
      evaluatedEvidence = entry.payload.evidence;
      return {
        jobId: entry.id,
        candidateId: entry.candidateId,
        operation: "evaluate",
        metricsByScenario: { mapping: { FullDPS: 200 } },
      };
    });
    const pool = new NativeProbeWorkerPool(delegate);
    const result = await pool.evaluate(job());
    expect(operations).toEqual(["probe", "evaluate"]);
    expect(evaluatedEvidence).toMatchObject({
      "mapping:sustainable": [
        { condition: "conditionFortified", status: "manual" },
        { condition: "conditionOnslaught", status: "proven_sustainable" },
      ],
    });
    expect(result).toMatchObject({
      candidateFingerprint: "candidate:fingerprint",
      nativeProbeFingerprint: "native-links:fingerprint",
      operation: "evaluate",
    });
    expect(result.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.resolvedEvidence?.some(({ condition }) => condition === "conditionOnslaught")).toBe(true);
    await pool.close();
  });

  it("rejects a support omitted by PoB's native acceptance matrix", async () => {
    let evaluateCalls = 0;
    const delegate = new InMemoryWorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation>(1, (entry) => {
      if (entry.payload.operation === "probe") return probeResult("SupportAddedColdDamage");
      evaluateCalls += 1;
      return { jobId: entry.id, candidateId: entry.candidateId, metricsByScenario: {} };
    });
    const pool = new NativeProbeWorkerPool(delegate);
    await expect(pool.evaluate(job())).rejects.toThrow(/Native link compatibility rejected/);
    expect(evaluateCalls).toBe(0);
    await pool.close();
  });

  it("rejects native socket-capacity overflow and stale evaluation fingerprints", async () => {
    const capacityDelegate = new InMemoryWorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation>(1, (entry) =>
      entry.payload.operation === "probe"
        ? probeResult("SupportSpellEcho", 1)
        : { jobId: entry.id, candidateId: entry.candidateId, metricsByScenario: {} });
    const capacityPool = new NativeProbeWorkerPool(capacityDelegate);
    await expect(capacityPool.evaluate(job())).rejects.toThrow(/capacity rejected/);
    await capacityPool.close();

    const staleDelegate = new InMemoryWorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation>(1, (entry) =>
      entry.payload.operation === "probe"
        ? probeResult()
        : {
            jobId: entry.id,
            candidateId: entry.candidateId,
            candidateFingerprint: "candidate:stale",
            metricsByScenario: { mapping: { FullDPS: 200 } },
          });
    const stalePool = new NativeProbeWorkerPool(staleDelegate);
    await expect(stalePool.evaluate(job())).rejects.toThrow(/fingerprint mismatch/);
    await stalePool.close();
  });

  it("rejects malformed scenario evidence maps before evaluation", async () => {
    let evaluateCalls = 0;
    const delegate = new InMemoryWorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation>(1, (entry) => {
      if (entry.payload.operation === "probe") return probeResult();
      evaluateCalls += 1;
      return { jobId: entry.id, candidateId: entry.candidateId, metricsByScenario: {} };
    });
    const pool = new NativeProbeWorkerPool(delegate);
    const malformed = job();
    (malformed.payload as { evidence: unknown }).evidence = {
      "mapping:sustainable": { condition: "conditionFortified" },
    };
    await expect(pool.evaluate(malformed)).rejects.toThrow(/evidence map is invalid/);
    expect(evaluateCalls).toBe(0);
    await pool.close();
  });
});
