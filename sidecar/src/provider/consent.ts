import { createHash } from "node:crypto";
import { redactForModel, stringifyForModel } from "../llm/redaction.js";
import {
  DEFAULT_CONSENT_DATA_CATEGORIES,
  PRIVACY_POLICY_VERSION,
  REDACTION_POLICY_VERSION,
  canonicalProviderBaseURL,
  type ConsentDataCategory,
  type ProviderProfile,
} from "./types.js";
import type {
  ProviderApiMode,
  ProviderAuthMode,
  ProviderReasoningMode,
  ResolvedProviderApiMode,
  ResolvedProviderReasoning,
} from "./compatibility.js";

export interface ConsentRecord {
  readonly providerId: string;
  readonly consentKey: string;
  readonly decision: "granted" | "revoked";
  readonly dataCategories?: readonly ConsentDataCategory[];
  readonly grantedAt?: string;
  readonly revokedAt?: string;
}

export interface ConsentRecordStore {
  get(providerId: string): Promise<ConsentRecord | undefined>;
  put(record: ConsentRecord): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export class MemoryConsentRecordStore implements ConsentRecordStore {
  readonly #records = new Map<string, ConsentRecord>();

  async get(providerId: string): Promise<ConsentRecord | undefined> {
    return this.#records.get(providerId);
  }

  async put(record: ConsentRecord): Promise<void> {
    this.#records.set(record.providerId, record);
  }

  async delete(providerId: string): Promise<void> {
    this.#records.delete(providerId);
  }
}

export interface ConsentDescriptorInput {
  readonly providerId: string;
  readonly baseURL: string;
  readonly model: string;
  readonly authMode: ProviderAuthMode;
  readonly apiMode: ProviderApiMode;
  readonly resolvedApiMode: ResolvedProviderApiMode;
  readonly reasoningMode: ProviderReasoningMode;
  readonly resolvedReasoning: ResolvedProviderReasoning;
  readonly dataCategories?: readonly ConsentDataCategory[];
  readonly privacyPolicyVersion?: string;
  readonly redactionPolicyVersion?: string;
}

export interface ProviderConsentPreview {
  readonly providerId: string;
  readonly endpoint: string;
  readonly model: string;
  readonly authMode: ProviderAuthMode;
  readonly apiMode: ProviderApiMode;
  readonly resolvedApiMode: ResolvedProviderApiMode;
  readonly reasoningMode: ProviderReasoningMode;
  readonly resolvedReasoning: ResolvedProviderReasoning;
  readonly dataCategories: readonly ConsentDataCategory[];
  readonly privacyPolicyVersion: string;
  readonly redactionPolicyVersion: string;
  readonly consentKey: string;
  readonly payloadPreview: {
    readonly kind: "redacted_metadata";
    readonly estimatedBytes: number;
    readonly redactedHash: string;
  };
}

function sortedUnique(values: readonly ConsentDataCategory[]): ConsentDataCategory[] {
  return [...new Set(values)].sort() as ConsentDataCategory[];
}

function effectiveCategories(values: readonly ConsentDataCategory[] | undefined): ConsentDataCategory[] {
  return sortedUnique(values === undefined || values.length === 0 ? DEFAULT_CONSENT_DATA_CATEGORIES : values);
}

function canonicalDescriptor(input: ConsentDescriptorInput): string {
  const categories = sortedUnique(input.dataCategories ?? DEFAULT_CONSENT_DATA_CATEGORIES);
  return JSON.stringify({
    providerId: input.providerId,
    endpoint: canonicalProviderBaseURL(input.baseURL),
    model: input.model,
    authMode: input.authMode,
    apiMode: input.apiMode,
    resolvedApiMode: input.resolvedApiMode,
    reasoningMode: input.reasoningMode,
    resolvedReasoning: input.resolvedReasoning,
    dataCategories: categories,
    privacyPolicyVersion: input.privacyPolicyVersion ?? PRIVACY_POLICY_VERSION,
    redactionPolicyVersion: input.redactionPolicyVersion ?? REDACTION_POLICY_VERSION,
  });
}

export function createConsentKey(input: ConsentDescriptorInput): string {
  return `sha256:${createHash("sha256").update(canonicalDescriptor(input), "utf8").digest("hex")}`;
}

export function createRedactedPayloadPreview(payload: unknown): ProviderConsentPreview["payloadPreview"] {
  const redacted = stringifyForModel(payload) ?? "null";
  return {
    kind: "redacted_metadata",
    estimatedBytes: Buffer.byteLength(redacted, "utf8"),
    redactedHash: `sha256:${createHash("sha256").update(redacted, "utf8").digest("hex")}`,
  };
}

export class ConsentManager {
  readonly #store: ConsentRecordStore;
  readonly #now: () => Date;

  constructor(store: ConsentRecordStore = new MemoryConsentRecordStore(), now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  async get(providerId: string): Promise<ConsentRecord | undefined> {
    return this.#store.get(providerId);
  }

  async state(
    profile: ProviderProfile,
    dataCategories?: readonly ConsentDataCategory[],
  ): Promise<"required" | "granted" | "revoked"> {
    const record = await this.#store.get(profile.providerId);
    if (record === undefined) return "required";
    if (record.decision === "revoked") return "revoked";
    return record.consentKey === createConsentKey(profileDescriptor(profile, dataCategories ?? record.dataCategories))
      ? "granted"
      : "required";
  }

  async isGranted(profile: ProviderProfile, dataCategories?: readonly ConsentDataCategory[]): Promise<boolean> {
    return (await this.state(profile, dataCategories)) === "granted";
  }

  preview(profile: ProviderProfile, payload?: unknown, dataCategories?: readonly ConsentDataCategory[]): ProviderConsentPreview {
    const descriptor = profileDescriptor(profile, dataCategories);
    return {
      providerId: profile.providerId,
      endpoint: profile.baseURL,
      model: profile.model,
      authMode: profile.authMode,
      apiMode: profile.apiMode,
      resolvedApiMode: profile.resolvedApiMode,
      reasoningMode: profile.reasoningMode,
      resolvedReasoning: profile.resolvedReasoning,
      dataCategories: effectiveCategories(descriptor.dataCategories),
      privacyPolicyVersion: PRIVACY_POLICY_VERSION,
      redactionPolicyVersion: REDACTION_POLICY_VERSION,
      consentKey: createConsentKey(descriptor),
      payloadPreview: createRedactedPayloadPreview(payload ?? { dataCategories: descriptor.dataCategories }),
    };
  }

  async grant(profile: ProviderProfile, consentKey: string, dataCategories?: readonly ConsentDataCategory[]): Promise<ConsentRecord> {
    const descriptor = profileDescriptor(profile, dataCategories);
    const expected = createConsentKey(descriptor);
    if (consentKey !== expected) throw new Error("Consent key does not match the current provider profile");
    const record: ConsentRecord = {
      providerId: profile.providerId,
      consentKey: expected,
      decision: "granted",
      dataCategories: effectiveCategories(descriptor.dataCategories),
      grantedAt: this.#now().toISOString(),
    };
    await this.#store.put(record);
    return record;
  }

  async revoke(providerId: string): Promise<void> {
    const existing = await this.#store.get(providerId);
    if (existing === undefined) {
      await this.#store.put({ providerId, consentKey: "", decision: "revoked", revokedAt: this.#now().toISOString() });
      return;
    }
    await this.#store.put({ ...existing, decision: "revoked", revokedAt: this.#now().toISOString() });
  }
}

function profileDescriptor(profile: ProviderProfile, dataCategories?: readonly ConsentDataCategory[]): ConsentDescriptorInput {
  return {
    providerId: profile.providerId,
    baseURL: profile.baseURL,
    model: profile.model,
    authMode: profile.authMode,
    apiMode: profile.apiMode,
    resolvedApiMode: profile.resolvedApiMode,
    reasoningMode: profile.reasoningMode,
    resolvedReasoning: profile.resolvedReasoning,
    dataCategories: dataCategories === undefined || dataCategories.length === 0
      ? profile.dataCategories
      : effectiveCategories(dataCategories),
  };
}

/** Redact model input before it reaches any provider adapter, including test adapters. */
export function redactChatPayload(value: unknown): unknown {
  return redactForModel(value);
}
