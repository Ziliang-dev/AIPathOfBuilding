import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { ConsentDataCategorySchema } from "./types.js";
import type { ConsentRecord, ConsentRecordStore } from "./consent.js";
import {
  migrateProviderProfile,
  ProviderProfileSchema,
  type ProviderProfile,
  type ProviderProfileStore,
} from "./types.js";

export class SqliteProviderStore implements ProviderProfileStore {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new Database(path);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS provider_profiles(
        provider_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS provider_consents(
        provider_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.#db.close();
  }

  async get(providerId: string): Promise<ProviderProfile | undefined> {
    const row = this.#db.prepare("SELECT payload FROM provider_profiles WHERE provider_id = ?")
      .get(providerId) as { payload: string } | undefined;
    return row === undefined ? undefined : migrateProviderProfile(JSON.parse(row.payload));
  }

  async put(profile: ProviderProfile): Promise<void> {
    const parsed = ProviderProfileSchema.parse(profile);
    this.#db.prepare(`
      INSERT INTO provider_profiles(provider_id, payload, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
    `).run(parsed.providerId, JSON.stringify(parsed), parsed.updatedAt);
  }

  async delete(providerId: string): Promise<void> {
    this.#db.prepare("DELETE FROM provider_profiles WHERE provider_id = ?").run(providerId);
  }

  readonly consentRecords: ConsentRecordStore = {
    get: async (providerId) => {
      const row = this.#db.prepare("SELECT payload FROM provider_consents WHERE provider_id = ?")
        .get(providerId) as { payload: string } | undefined;
      return row === undefined ? undefined : parseConsentRecord(JSON.parse(row.payload));
    },
    put: async (record) => {
      const parsed = parseConsentRecord(record);
      this.#db.prepare(`
        INSERT INTO provider_consents(provider_id, payload, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(provider_id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at
      `).run(parsed.providerId, JSON.stringify(parsed), new Date().toISOString());
    },
    delete: async (providerId) => {
      this.#db.prepare("DELETE FROM provider_consents WHERE provider_id = ?").run(providerId);
    },
  };
}

function parseConsentRecord(value: unknown): ConsentRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Consent record must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.providerId !== "string" || typeof record.consentKey !== "string") {
    throw new Error("Consent record identifiers are invalid");
  }
  if (record.decision !== "granted" && record.decision !== "revoked") {
    throw new Error("Consent record decision is invalid");
  }
  if (record.grantedAt !== undefined && typeof record.grantedAt !== "string") {
    throw new Error("Consent grantedAt is invalid");
  }
  if (record.revokedAt !== undefined && typeof record.revokedAt !== "string") {
    throw new Error("Consent revokedAt is invalid");
  }
  if (record.dataCategories !== undefined) {
    if (!Array.isArray(record.dataCategories) || record.dataCategories.length === 0) {
      throw new Error("Consent dataCategories are invalid");
    }
    for (const category of record.dataCategories) {
      if (!ConsentDataCategorySchema.safeParse(category).success) throw new Error("Consent dataCategories are invalid");
    }
  }
  return record as unknown as ConsentRecord;
}
