import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { BuildSnapshot, Candidate, OptimizationRun, TransactionResult } from "../schemas.js";
import {
  BuildSnapshotSchema,
  CandidateSchema,
  OptimizationRunSchema,
  TransactionResultSchema,
} from "../schemas.js";
import type { PlannerStore } from "./types.js";

export class SidecarDatabase implements PlannerStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  saveSnapshot(snapshot: BuildSnapshot): void {
    const parsed = BuildSnapshotSchema.parse(snapshot);
    this.db.prepare(`
      INSERT INTO build_snapshots(fingerprint, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
    `).run(parsed.fingerprint, JSON.stringify(parsed), new Date().toISOString());
  }

  getSnapshot(fingerprint: string): BuildSnapshot | undefined {
    const row = this.db.prepare("SELECT payload FROM build_snapshots WHERE fingerprint = ?")
      .get(fingerprint) as { payload: string } | undefined;
    return row === undefined ? undefined : BuildSnapshotSchema.parse(JSON.parse(row.payload));
  }

  saveRun(run: OptimizationRun, pinned = false): void {
    const parsed = OptimizationRunSchema.parse(run);
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO optimization_runs(id, fingerprint, status, payload, pinned, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload,
          pinned=excluded.pinned, updated_at=excluded.updated_at
      `).run(parsed.id, parsed.buildFingerprint, parsed.status, JSON.stringify(parsed), pinned ? 1 : 0, parsed.updatedAt);
      this.db.prepare("DELETE FROM candidates WHERE run_id = ?").run(parsed.id);
      const insert = this.db.prepare("INSERT OR REPLACE INTO candidates(id, run_id, payload) VALUES (?, ?, ?)");
      for (const candidate of parsed.frontier) insert.run(candidate.id, parsed.id, JSON.stringify(candidate));
      for (const candidate of parsed.selected) {
        insert.run(candidate.id, parsed.id, JSON.stringify(candidate));
      }
    });
    transaction();
  }

  getRun(id: string): OptimizationRun | undefined {
    const row = this.db.prepare("SELECT payload FROM optimization_runs WHERE id = ?").get(id) as { payload: string } | undefined;
    return row === undefined ? undefined : OptimizationRunSchema.parse(JSON.parse(row.payload));
  }

  getCandidate(runId: string, candidateId: string): Candidate | undefined {
    const row = this.db.prepare("SELECT payload FROM candidates WHERE run_id = ? AND id = ?")
      .get(runId, candidateId) as { payload: string } | undefined;
    return row === undefined ? undefined : CandidateSchema.parse(JSON.parse(row.payload));
  }

  saveTransaction(result: TransactionResult): void {
    const parsed = TransactionResultSchema.parse(result);
    this.db.prepare(`
      INSERT INTO transaction_audit(run_id, candidate_id, payload, created_at)
      VALUES (?, ?, ?, ?)
    `).run(parsed.runId, parsed.candidateId, JSON.stringify(parsed), new Date().toISOString());
  }

  getCache<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT payload FROM evaluation_cache WHERE key = ?").get(key) as { payload: string } | undefined;
    if (row === undefined) return undefined;
    this.db.prepare("UPDATE evaluation_cache SET accessed_at = ? WHERE key = ?").run(new Date().toISOString(), key);
    return JSON.parse(row.payload) as T;
  }

  setCache(key: string, payload: unknown): void {
    const json = JSON.stringify(payload);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO evaluation_cache(key, payload, size_bytes, accessed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, size_bytes=excluded.size_bytes,
        accessed_at=excluded.accessed_at
    `).run(key, json, Buffer.byteLength(json), now);
  }

  prune(options: { maxCacheBytes?: number; olderThanDays?: number } = {}): { cacheRows: number; runRows: number } {
    const maxCacheBytes = options.maxCacheBytes ?? 2 * 1024 * 1024 * 1024;
    const olderThanDays = options.olderThanDays ?? 30;
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const runRows = this.db.prepare("DELETE FROM optimization_runs WHERE pinned = 0 AND updated_at < ?").run(cutoff).changes;
    let total = (this.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS size FROM evaluation_cache").get() as { size: number }).size;
    let cacheRows = 0;
    const oldest = this.db.prepare("SELECT key, size_bytes FROM evaluation_cache ORDER BY accessed_at ASC");
    for (const row of oldest.iterate() as Iterable<{ key: string; size_bytes: number }>) {
      if (total <= maxCacheBytes) break;
      cacheRows += this.db.prepare("DELETE FROM evaluation_cache WHERE key = ?").run(row.key).changes;
      total -= row.size_bytes;
    }
    return { cacheRows, runRows };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS build_snapshots(
        fingerprint TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS optimization_runs(
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL REFERENCES build_snapshots(fingerprint),
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS candidates(
        id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES optimization_runs(id) ON DELETE CASCADE,
        payload TEXT NOT NULL,
        PRIMARY KEY(run_id, id)
      );
      CREATE TABLE IF NOT EXISTS transaction_audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS evaluation_cache(
        key TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        accessed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_updated ON optimization_runs(updated_at);
      CREATE INDEX IF NOT EXISTS idx_cache_accessed ON evaluation_cache(accessed_at);
    `);
  }
}
