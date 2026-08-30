import type { BuildSnapshot, Candidate, OptimizationRun, TransactionResult } from "../schemas.js";
import type { PlannerStore } from "./types.js";

export class MemoryPlannerStore implements PlannerStore {
  private readonly snapshots = new Map<string, BuildSnapshot>();
  private readonly runs = new Map<string, OptimizationRun>();
  private readonly cache = new Map<string, unknown>();
  readonly transactions: TransactionResult[] = [];

  close(): void {}
  saveSnapshot(snapshot: BuildSnapshot): void { this.snapshots.set(snapshot.fingerprint, structuredClone(snapshot)); }
  getSnapshot(fingerprint: string): BuildSnapshot | undefined {
    const value = this.snapshots.get(fingerprint);
    return value === undefined ? undefined : structuredClone(value);
  }
  saveRun(run: OptimizationRun): void { this.runs.set(run.id, structuredClone(run)); }
  getRun(id: string): OptimizationRun | undefined {
    const value = this.runs.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }
  getCandidate(runId: string, candidateId: string): Candidate | undefined {
    const run = this.runs.get(runId);
    return run?.selected.find(({ id }) => id === candidateId)
      ?? run?.frontier.find(({ id }) => id === candidateId);
  }
  saveTransaction(result: TransactionResult): void { this.transactions.push(structuredClone(result)); }
  getCache<T>(key: string): T | undefined { return this.cache.get(key) as T | undefined; }
  setCache(key: string, payload: unknown): void { this.cache.set(key, structuredClone(payload)); }
  prune(): { cacheRows: number; runRows: number } { return { cacheRows: 0, runRows: 0 }; }
}
