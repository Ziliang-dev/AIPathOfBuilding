import { z } from "zod";
import { credentialTarget } from "../credentials/wincredClient.js";
import {
  ProviderApiModeSchema,
  ProviderAuthModeSchema,
  ProviderCompatibilityResolutionSchema,
  ProviderReasoningModeSchema,
  ResolvedProviderApiModeSchema,
  ResolvedProviderReasoningSchema,
  assertProviderAuthAllowed,
  resolveProviderCompatibility,
  type ProviderCompatibilityResolution,
} from "./compatibility.js";

export const DEFAULT_PROVIDER_BASE_URL = "https://api.openai.com/v1";
export const PRIVACY_POLICY_VERSION = "1";
export const REDACTION_POLICY_VERSION = "2";

export const ConsentDataCategorySchema = z.enum([
  "objective",
  "build_snapshot",
  "metrics",
  "tool_outputs",
  "chat_messages",
  "mechanic_report",
  "mechanic_facts",
  "mechanic_experiment_results",
  "connection_probe",
]);
export type ConsentDataCategory = z.infer<typeof ConsentDataCategorySchema>;

export const DEFAULT_CONSENT_DATA_CATEGORIES: readonly ConsentDataCategory[] = [
  "objective",
  "build_snapshot",
  "metrics",
  "tool_outputs",
  "chat_messages",
  "mechanic_report",
  "mechanic_facts",
  "mechanic_experiment_results",
];

export const ProviderProfileIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Provider id contains unsupported characters");

export const ProviderProfileSchema = z
  .object({
    profileVersion: z.literal(2),
    providerId: ProviderProfileIdSchema,
    baseURL: z.string().url(),
    model: z.string().min(1).max(256),
    authMode: ProviderAuthModeSchema,
    apiMode: ProviderApiModeSchema,
    resolvedApiMode: ResolvedProviderApiModeSchema,
    reasoningMode: ProviderReasoningModeSchema,
    resolvedReasoning: ResolvedProviderReasoningSchema,
    credentialTarget: z.string().min(1),
    maxCalls: z.number().int().min(1).max(128),
    maxOutputTokens: z.number().int().min(1).max(65_536),
    timeoutMs: z.number().int().min(100).max(600_000),
    dataCategories: z.array(ConsentDataCategorySchema).min(1),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.credentialTarget !== credentialTarget(value.providerId)) {
      context.addIssue({ code: "custom", path: ["credentialTarget"], message: "Credential target is not an LLM target" });
    }
    try {
      assertProviderAuthAllowed(value.baseURL, value.authMode);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["authMode"],
        message: error instanceof Error ? error.message : "Invalid provider authentication mode",
      });
    }
  });
export type ProviderProfile = z.infer<typeof ProviderProfileSchema>;

export const ProviderConfigureInputSchema = z
  .object({
    testId: z.string().uuid(),
    providerId: ProviderProfileIdSchema,
    model: z.string().min(1).max(256),
    baseURL: z.string().url().optional(),
    authMode: ProviderAuthModeSchema.default("bearer"),
    apiMode: ProviderApiModeSchema.default("auto"),
    reasoningMode: ProviderReasoningModeSchema.default("auto"),
    apiKey: z.string().min(1).max(16_384).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      message: "API key cannot contain control characters",
    }).optional(),
    clearCredential: z.boolean().default(false),
    maxCalls: z.number().int().min(1).max(128).default(16),
    maxOutputTokens: z.number().int().min(1).max(65_536).default(4096),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
    dataCategories: z.array(ConsentDataCategorySchema).min(1).default([...DEFAULT_CONSENT_DATA_CATEGORIES]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.clearCredential && value.apiKey !== undefined) {
      context.addIssue({ code: "custom", path: ["apiKey"], message: "clearCredential cannot be combined with apiKey" });
    }
    try {
      assertProviderAuthAllowed(canonicalProviderBaseURL(value.baseURL), value.authMode);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["authMode"],
        message: error instanceof Error ? error.message : "Invalid provider authentication mode",
      });
    }
  });
export type ProviderConfigureInput = z.input<typeof ProviderConfigureInputSchema>;
export type ProviderProfileInput = Omit<ProviderConfigureInput, "testId"> & { testId?: string };

export const ProviderTestSettingsSchema = z.object({
  providerId: ProviderProfileIdSchema,
  model: z.string().min(1).max(256),
  baseURL: z.string().url(),
  authMode: ProviderAuthModeSchema.default("bearer"),
  apiMode: ProviderApiModeSchema.default("auto"),
  reasoningMode: ProviderReasoningModeSchema.default("auto"),
}).strict().superRefine((value, context) => {
  try {
    assertProviderAuthAllowed(canonicalProviderBaseURL(value.baseURL), value.authMode);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["authMode"],
      message: error instanceof Error ? error.message : "Invalid provider authentication mode",
    });
  }
});
export type ProviderTestSettings = z.infer<typeof ProviderTestSettingsSchema>;

export interface ProviderProfileStore {
  get(providerId: string): Promise<ProviderProfile | undefined>;
  put(profile: ProviderProfile): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export class MemoryProviderProfileStore implements ProviderProfileStore {
  readonly #profiles = new Map<string, ProviderProfile>();

  async get(providerId: string): Promise<ProviderProfile | undefined> {
    return this.#profiles.get(providerId);
  }

  async put(profile: ProviderProfile): Promise<void> {
    this.#profiles.set(profile.providerId, profile);
  }

  async delete(providerId: string): Promise<void> {
    this.#profiles.delete(providerId);
  }
}

export function canonicalProviderBaseURL(value: string | undefined): string {
  const url = new URL(value ?? DEFAULT_PROVIDER_BASE_URL);
  const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(localHost && url.protocol === "http:")) {
    throw new Error("Provider baseURL must use HTTPS (HTTP is allowed only for loopback development endpoints)");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("Provider baseURL must not include credentials, query, or fragment");
  }
  url.hostname = url.hostname.toLowerCase();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function providerProfileWithDefaults(
  input: ProviderProfileInput,
  resolution?: ProviderCompatibilityResolution,
  now = new Date(),
): ProviderProfile {
  const parsed = ProviderConfigureInputSchema.parse({
    ...input,
    testId: input.testId ?? "00000000-0000-4000-8000-000000000000",
  });
  const baseURL = canonicalProviderBaseURL(parsed.baseURL);
  const resolved = ProviderCompatibilityResolutionSchema.parse(resolution ?? resolveProviderCompatibility({
    baseURL,
    model: parsed.model,
    apiMode: parsed.apiMode,
    reasoningMode: parsed.reasoningMode,
  }));
  return ProviderProfileSchema.parse({
    profileVersion: 2,
    providerId: parsed.providerId,
    baseURL,
    model: parsed.model,
    authMode: parsed.authMode,
    apiMode: parsed.apiMode,
    resolvedApiMode: resolved.apiMode,
    reasoningMode: parsed.reasoningMode,
    resolvedReasoning: resolved.reasoning,
    credentialTarget: credentialTarget(parsed.providerId),
    maxCalls: parsed.maxCalls,
    maxOutputTokens: parsed.maxOutputTokens,
    timeoutMs: parsed.timeoutMs,
    dataCategories: parsed.dataCategories,
    updatedAt: now.toISOString(),
  });
}

/** Upgrade protocol-v2 provider rows without changing their effective request path. */
export function migrateProviderProfile(value: unknown): ProviderProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ProviderProfileSchema.parse(value);
  }
  const source = value as Record<string, unknown>;
  if (source.profileVersion === 2) return ProviderProfileSchema.parse(source);
  return ProviderProfileSchema.parse({
    ...source,
    profileVersion: 2,
    authMode: source.authMode ?? "bearer",
    apiMode: source.apiMode ?? "chat_completions",
    resolvedApiMode: source.resolvedApiMode ?? "chat_completions",
    reasoningMode: source.reasoningMode ?? "auto",
    resolvedReasoning: source.resolvedReasoning ?? "provider_default",
  });
}

export interface ProviderStatus {
  readonly configured: boolean;
  readonly credentialConfigured: boolean;
  readonly consent: "required" | "granted" | "revoked";
  readonly profile?: ProviderProfile;
}
