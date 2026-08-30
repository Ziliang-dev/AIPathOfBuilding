import type { BuildSnapshot, Candidate, OptimizationRun, TransactionResult } from "../schemas.js";

export interface PlannerStore {
  close(): void;
  saveSnapshot(snapshot: BuildSnapshot): void;
  getSnapshot(fingerprint: string): BuildSnapshot | undefined;
  saveRun(run: OptimizationRun, pinned?: boolean): void;
  getRun(id: string): OptimizationRun | undefined;
  getCandidate(runId: string, candidateId: string): Candidate | undefined;
  saveTransaction(result: TransactionResult): void;
  getCache<T>(key: string): T | undefined;
  setCache(key: string, payload: unknown): void;
  prune(options?: { maxCacheBytes?: number; olderThanDays?: number }): { cacheRows: number; runRows: number };
}
