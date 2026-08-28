import type { BuildAction, ConditionEvidence, ScenarioSpec } from "../schemas.js";
import type { MetricVector } from "../search/types.js";

/** Frozen Lua worker evaluate payload. Keep secrets and account data outside it. */
export interface PobWorkerEvaluatePayload<Action = BuildAction> {
  readonly operation?: "evaluate" | "probe";
  readonly xml: string;
  readonly actions: readonly Action[];
  readonly scenarios: readonly ScenarioSpec[];
  readonly evidence: readonly ConditionEvidence[] | Readonly<Record<string, readonly ConditionEvidence[]>>;
  readonly probeOptions?: Readonly<Record<string, unknown>>;
}

export interface WorkerJob<Payload = unknown> {
  readonly id: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly buildFingerprint: string;
  readonly scenarios: readonly string[];
  readonly payload: Payload;
}

export interface WorkerEvaluation {
  readonly jobId: string;
  readonly candidateId: string;
  readonly metricsByScenario: Readonly<Record<string, MetricVector>>;
  readonly diagnostics?: readonly string[];
  readonly operation?: "evaluate" | "probe";
  readonly candidateFingerprint?: string;
  readonly nativeProbeFingerprint?: string;
  readonly evidenceFingerprint?: string;
  readonly nativeLinkProbe?: unknown;
  readonly nativeEvidence?: unknown;
  readonly nativeEvidenceByScenario?: unknown;
  readonly resolvedEvidence?: readonly ConditionEvidence[];
}

export interface WorkerContext {
  readonly workerId: number;
  readonly signal: AbortSignal;
}

export type WorkerEvaluator<Payload, Result extends WorkerEvaluation> = (
  job: WorkerJob<Payload>,
  context: WorkerContext,
) => Promise<Result> | Result;

export interface WorkerPoolStats {
  readonly workerCount: number;
  readonly queued: number;
  readonly active: number;
  readonly completed: number;
  readonly cancelled: number;
}

export interface WorkerPool<Payload = unknown, Result extends WorkerEvaluation = WorkerEvaluation> {
  evaluate(job: WorkerJob<Payload>, signal?: AbortSignal): Promise<Result>;
  evaluateBatch(jobs: readonly WorkerJob<Payload>[], signal?: AbortSignal): Promise<readonly Result[]>;
  cancel(runId: string): void;
  stats(): WorkerPoolStats;
  close(): Promise<void>;
}

export class WorkerCancelledError extends Error {
  public constructor(message = "Worker evaluation cancelled") {
    super(message);
    this.name = "WorkerCancelledError";
  }
}
