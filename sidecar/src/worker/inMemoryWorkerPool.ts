import {
  WorkerCancelledError,
  type WorkerContext,
  type WorkerEvaluation,
  type WorkerEvaluator,
  type WorkerJob,
  type WorkerPool,
  type WorkerPoolStats,
} from "./types.js";

interface QueuedJob<Payload, Result extends WorkerEvaluation> {
  readonly job: WorkerJob<Payload>;
  readonly externalSignal?: AbortSignal;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
}

interface WorkerLane<Payload, Result extends WorkerEvaluation> {
  readonly id: number;
  readonly queue: QueuedJob<Payload, Result>[];
  active?: { readonly runId: string; readonly controller: AbortController };
  running: boolean;
}

function abortError(): WorkerCancelledError {
  return new WorkerCancelledError();
}

export class InMemoryWorkerPool<Payload = unknown, Result extends WorkerEvaluation = WorkerEvaluation>
implements WorkerPool<Payload, Result> {
  readonly #lanes: WorkerLane<Payload, Result>[];
  readonly #evaluator: WorkerEvaluator<Payload, Result>;
  readonly #cancelledRuns = new Set<string>();
  #sequence = 0;
  #completed = 0;
  #cancelled = 0;
  #closed = false;

  public constructor(workerCount: number, evaluator: WorkerEvaluator<Payload, Result>) {
    if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 8) {
      throw new RangeError("workerCount must be an integer from 1 to 8");
    }
    this.#evaluator = evaluator;
    this.#lanes = Array.from({ length: workerCount }, (_, id) => ({ id, queue: [], running: false }));
  }

  public evaluate(job: WorkerJob<Payload>, signal?: AbortSignal): Promise<Result> {
    if (this.#closed) return Promise.reject(new Error("Worker pool is closed"));
    if (signal?.aborted || this.#cancelledRuns.has(job.runId)) return Promise.reject(abortError());
    const lane = this.#lanes[this.#sequence % this.#lanes.length];
    this.#sequence += 1;
    if (!lane) return Promise.reject(new Error("No worker lane available"));
    return new Promise<Result>((resolve, reject) => {
      lane.queue.push({ job, resolve, reject, ...(signal ? { externalSignal: signal } : {}) });
      void this.#drain(lane);
    });
  }

  public async evaluateBatch(jobs: readonly WorkerJob<Payload>[], signal?: AbortSignal): Promise<readonly Result[]> {
    return Promise.all(jobs.map((job) => this.evaluate(job, signal)));
  }

  public cancel(runId: string): void {
    this.#cancelledRuns.add(runId);
    for (const lane of this.#lanes) {
      const retained: QueuedJob<Payload, Result>[] = [];
      for (const entry of lane.queue) {
        if (entry.job.runId === runId) {
          this.#cancelled += 1;
          entry.reject(abortError());
        } else retained.push(entry);
      }
      lane.queue.splice(0, lane.queue.length, ...retained);
      if (lane.active?.runId === runId) lane.active.controller.abort();
    }
  }

  public stats(): WorkerPoolStats {
    return {
      workerCount: this.#lanes.length,
      queued: this.#lanes.reduce((sum, lane) => sum + lane.queue.length, 0),
      active: this.#lanes.filter((lane) => lane.running).length,
      completed: this.#completed,
      cancelled: this.#cancelled,
    };
  }

  public async close(): Promise<void> {
    this.#closed = true;
    const runIds = new Set<string>();
    for (const lane of this.#lanes) {
      for (const entry of lane.queue) runIds.add(entry.job.runId);
      if (lane.active) runIds.add(lane.active.runId);
    }
    for (const runId of runIds) this.cancel(runId);
    await Promise.all(this.#lanes.map(async (lane) => {
      while (lane.running) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }));
  }

  async #drain(lane: WorkerLane<Payload, Result>): Promise<void> {
    if (lane.running) return;
    lane.running = true;
    try {
      while (lane.queue.length) {
        const entry = lane.queue.shift();
        if (!entry) break;
        if (entry.externalSignal?.aborted || this.#cancelledRuns.has(entry.job.runId)) {
          this.#cancelled += 1;
          entry.reject(abortError());
          continue;
        }
        const controller = new AbortController();
        lane.active = { runId: entry.job.runId, controller };
        const onAbort = (): void => controller.abort();
        entry.externalSignal?.addEventListener("abort", onAbort, { once: true });
        const context: WorkerContext = { workerId: lane.id, signal: controller.signal };
        try {
          const result = await this.#evaluator(entry.job, context);
          if (controller.signal.aborted) throw abortError();
          this.#completed += 1;
          entry.resolve(result);
        } catch (error) {
          if (controller.signal.aborted || error instanceof WorkerCancelledError) this.#cancelled += 1;
          entry.reject(error);
        } finally {
          entry.externalSignal?.removeEventListener("abort", onAbort);
          delete lane.active;
        }
      }
    } finally {
      lane.running = false;
    }
  }
}
