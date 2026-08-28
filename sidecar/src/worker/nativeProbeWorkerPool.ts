import {
  isCompleteNativeProbe,
  nativeEvidenceFingerprint,
  parseNativeProbe,
  resolveNativeCandidateEvidence,
} from "../domain/nativeProbe.js";
import type { BuildAction, ConditionEvidence } from "../schemas.js";
import type { NativeProbeBundle } from "../domain/nativeProbe.js";
import type {
  PobWorkerEvaluatePayload,
  WorkerEvaluation,
  WorkerJob,
  WorkerPool,
  WorkerPoolStats,
} from "./types.js";

/** Enforces the candidate -> native probe -> scenario evaluation barrier. */
export class NativeProbeWorkerPool
implements WorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation> {
  public constructor(
    private readonly delegate: WorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation>,
  ) {}

  public async evaluate(
    job: WorkerJob<PobWorkerEvaluatePayload<BuildAction>>,
    signal?: AbortSignal,
  ): Promise<WorkerEvaluation> {
    const probeRaw = await this.delegate.evaluate({
      ...job,
      id: `${job.id}:native-probe`,
      payload: { ...job.payload, operation: "probe", evidence: [] },
    }, signal);
    const bundle = parseNativeProbe(probeRaw);
    if (!isCompleteNativeProbe(bundle)) {
      throw new Error(`Native proof incomplete for candidate: ${job.candidateId}`);
    }
    assertNativeLinkCompatibility(job.payload.actions, bundle);
    const evidenceByScenario: Record<string, readonly ConditionEvidence[]> = {};
    const combined: ConditionEvidence[] = [];
    for (const scenario of job.payload.scenarios) {
      const resolution = resolveNativeCandidateEvidence(bundle, scenario);
      const key = `${scenario.id}:${scenario.profile}`;
      const originalEvidence = job.payload.evidence;
      const scenarioEvidence = originalEvidence !== null && typeof originalEvidence === "object"
        && !Array.isArray(originalEvidence)
        ? (originalEvidence as Readonly<Record<string, unknown>>)[key]
          ?? (originalEvidence as Readonly<Record<string, unknown>>)[scenario.id]
        : undefined;
      if (scenarioEvidence !== undefined && !Array.isArray(scenarioEvidence)) {
        throw new Error(`Native evidence map is invalid for scenario: ${key}`);
      }
      const existing: readonly ConditionEvidence[] = Array.isArray(originalEvidence)
        ? originalEvidence as readonly ConditionEvidence[]
        : scenarioEvidence as readonly ConditionEvidence[] | undefined ?? [];
      const merged = [...existing, ...resolution.evidence];
      evidenceByScenario[key] = merged;
      combined.push(...merged);
    }
    const uniqueEvidence = [...new Map(combined.map((entry) => [
      `${entry.scenario}:${entry.condition}:${entry.sourceFingerprint ?? ""}`,
      entry,
    ])).values()];
    const evaluated = await this.delegate.evaluate({
      ...job,
      payload: { ...job.payload, operation: "evaluate", evidence: evidenceByScenario },
    }, signal);
    if (evaluated.candidateFingerprint !== undefined
      && evaluated.candidateFingerprint !== bundle.candidateFingerprint) {
      throw new Error(`Native evaluation fingerprint mismatch for candidate: ${job.candidateId}`);
    }
    return {
      ...evaluated,
      operation: "evaluate",
      candidateFingerprint: bundle.candidateFingerprint,
      nativeProbeFingerprint: bundle.nativeProbeFingerprint
        ?? bundle.nativeLinkProbe.nativeProbeFingerprint
        ?? bundle.nativeLinkProbe.probeFingerprint,
      evidenceFingerprint: nativeEvidenceFingerprint(bundle, uniqueEvidence),
      resolvedEvidence: uniqueEvidence,
    };
  }

  public async evaluateBatch(
    jobs: readonly WorkerJob<PobWorkerEvaluatePayload<BuildAction>>[],
    signal?: AbortSignal,
  ): Promise<readonly WorkerEvaluation[]> {
    return await Promise.all(jobs.map((job) => this.evaluate(job, signal)));
  }

  public cancel(runId: string): void { this.delegate.cancel(runId); }
  public stats(): WorkerPoolStats { return this.delegate.stats(); }
  public async close(): Promise<void> { await this.delegate.close(); }
}

function assertNativeLinkCompatibility(
  actions: readonly BuildAction[],
  bundle: NativeProbeBundle,
): void {
  for (const action of actions) {
    if (action.kind !== "replaceSkillLinks") continue;
    const groupIndex = typeof action.payload["group"] === "number" ? action.payload["group"] : undefined;
    const group = bundle.nativeLinkProbe.groups.find((entry) => entry.index === groupIndex);
    if (group === undefined || group.noSupports) {
      throw new Error(`Native link group rejected candidate action: ${action.id}`);
    }
    const replacementGems = action.payload["gems"];
    if (Array.isArray(replacementGems) && replacementGems.length > group.capacity) {
      throw new Error(`Native link capacity rejected candidate action: ${action.id}`);
    }
    const accepted = new Set(group.activeSkills.flatMap((skill) => skill.acceptedSupportIds));
    for (const gem of group.gems) {
      if (!gem.support || !gem.enabled) continue;
      if (gem.grantedEffectId === undefined || !accepted.has(gem.grantedEffectId)) {
        throw new Error(`Native link compatibility rejected ${gem.name ?? gem.grantedEffectId ?? "support"}`);
      }
    }
  }
}
