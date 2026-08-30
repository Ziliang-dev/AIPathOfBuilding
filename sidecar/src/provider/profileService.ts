import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { type CredentialStore } from "../credentials/types.js";
import { credentialTarget } from "../credentials/wincredClient.js";
import { ConsentManager } from "./consent.js";
import {
  CONNECTION_PROBE_PAYLOAD,
  runProviderConnectionProbe,
  type ChatCompletionTransportFactory,
  type ProviderConnectionProbeResult,
} from "./connectionProbe.js";
import {
  ProviderCompatibilityResolutionSchema,
  resolveProviderCompatibility,
  type ProviderCompatibilityResolution,
} from "./compatibility.js";
import { listProviderModels } from "./modelCatalog.js";
import {
  ProviderConfigureInputSchema,
  ProviderProfileSchema,
  type ProviderConfigureInput,
  type ProviderProfile,
  type ProviderProfileStore,
  type ProviderStatus,
  ProviderTestSettingsSchema,
  type ProviderTestSettings,
  type ConsentDataCategory,
  providerProfileWithDefaults,
  canonicalProviderBaseURL,
  DEFAULT_CONSENT_DATA_CATEGORIES,
} from "./types.js";

export class ProviderConfigurationError extends Error {
  override readonly name = "ProviderConfigurationError";
}

function assertDurableConsentCategories(dataCategories?: readonly ConsentDataCategory[]): void {
  if (dataCategories?.includes("connection_probe")) {
    throw new ProviderConfigurationError("connection_probe cannot be persisted as provider data consent");
  }
}

function parseProviderTestSettings(input: ProviderTestSettings): ProviderTestSettings {
  return ProviderTestSettingsSchema.parse({
    providerId: input.providerId,
    baseURL: input.baseURL,
    model: input.model,
    authMode: input.authMode,
    apiMode: input.apiMode,
    reasoningMode: input.reasoningMode,
  });
}

/**
 * Coordinates profile and secret updates. Profile writes are rolled back if a
 * credential write succeeds but persistence fails; secrets never enter the
 * profile store or status response.
 */
export class ProviderProfileService {
  readonly #profiles: ProviderProfileStore;
  readonly #credentials: CredentialStore;
  readonly #consent: ConsentManager;
  readonly #now: () => Date;
  readonly #probeTransportFactory: ChatCompletionTransportFactory | undefined;
  readonly #successfulTests = new Map<string, {
    providerId: string;
    baseURL: string;
    model: string;
    authMode: ProviderTestSettings["authMode"];
    apiMode: ProviderTestSettings["apiMode"];
    reasoningMode: ProviderTestSettings["reasoningMode"];
    resolution: ProviderCompatibilityResolution;
    credentialFingerprint: string;
    expiresAt: number;
  }>();
  #configureChain: Promise<void> = Promise.resolve();

  constructor(options: {
    profiles: ProviderProfileStore;
    credentials: CredentialStore;
    consent: ConsentManager;
    now?: () => Date;
    probeTransportFactory?: ChatCompletionTransportFactory;
  }) {
    this.#profiles = options.profiles;
    this.#credentials = options.credentials;
    this.#consent = options.consent;
    this.#now = options.now ?? (() => new Date());
    this.#probeTransportFactory = options.probeTransportFactory;
  }

  async configure(input: ProviderConfigureInput): Promise<ProviderProfile> {
    let release!: () => void;
    const previous = this.#configureChain;
    this.#configureChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.#configureUnlocked(input);
    } finally {
      release();
    }
  }

  async #configureUnlocked(input: ProviderConfigureInput): Promise<ProviderProfile> {
    const parsed = ProviderConfigureInputSchema.parse(input);
    const ticket = this.#successfulTests.get(parsed.testId);
    this.#successfulTests.delete(parsed.testId);
    const baseURL = canonicalProviderBaseURL(parsed.baseURL);
    if (ticket === undefined || ticket.expiresAt < this.#now().getTime()
      || ticket.providerId !== parsed.providerId
      || ticket.baseURL !== baseURL
      || ticket.model !== parsed.model
      || ticket.authMode !== parsed.authMode
      || ticket.apiMode !== parsed.apiMode
      || ticket.reasoningMode !== parsed.reasoningMode) {
      throw new ProviderConfigurationError("A matching successful connection test is required before configuration");
    }
    const profile = providerProfileWithDefaults(parsed, ticket.resolution, this.#now());
    const oldProfile = await this.#profiles.get(profile.providerId);
    const target = credentialTarget(profile.providerId);
    if (parsed.authMode === "bearer" && parsed.apiKey === undefined && !parsed.clearCredential) {
      if (oldProfile === undefined) {
        throw new ProviderConfigurationError("Provider credential is required for first configuration");
      }
      if (canonicalProviderBaseURL(oldProfile.baseURL) !== canonicalProviderBaseURL(profile.baseURL)) {
        throw new ProviderConfigurationError("API key is required when changing the provider endpoint");
      }
      try {
        if (!(await this.#credentials.has(target))) {
          throw new ProviderConfigurationError("Provider credential is not configured");
        }
      } catch (error) {
        if (error instanceof ProviderConfigurationError) throw error;
        throw new ProviderConfigurationError(
          `Provider credential lookup failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    let testedSecret = "";
    if (parsed.authMode === "bearer") {
      testedSecret = parsed.apiKey ?? await this.#credentials.get(target) ?? "";
      if (testedSecret === "") throw new ProviderConfigurationError("Provider credential is not configured");
    }
    if (credentialFingerprint(parsed.authMode, testedSecret) !== ticket.credentialFingerprint) {
      throw new ProviderConfigurationError("API key changed after the successful connection test");
    }
    const shouldChangeSecret = parsed.authMode === "none" || parsed.apiKey !== undefined || parsed.clearCredential;
    let oldSecret: string | undefined;
    if (shouldChangeSecret) {
      try {
        oldSecret = await this.#credentials.get(target);
      } catch (error) {
        throw new ProviderConfigurationError(
          `Provider credential lookup failed: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
    let secretChanged = false;
    try {
      if (shouldChangeSecret) {
        if (parsed.clearCredential || parsed.authMode === "none") {
          await this.#credentials.delete(target);
        } else if (parsed.apiKey !== undefined) {
          await this.#credentials.set(target, parsed.apiKey);
        }
        secretChanged = true;
      }
      await this.#profiles.put(profile);
      return profile;
    } catch (error) {
      if (secretChanged) {
        try {
          if (oldSecret === undefined) await this.#credentials.delete(target);
          else await this.#credentials.set(target, oldSecret);
        } catch (rollbackError) {
          throw new ProviderConfigurationError(
            `Provider configuration failed and credential rollback failed: ${
              rollbackError instanceof Error ? rollbackError.message : "unknown rollback error"
            }`,
          );
        }
      }
      if (oldProfile === undefined) await this.#profiles.delete(profile.providerId);
      else await this.#profiles.put(ProviderProfileSchema.parse(oldProfile));
      throw new ProviderConfigurationError(
        `Provider configuration failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  async status(providerId: string): Promise<ProviderStatus> {
    const profile = await this.#profiles.get(providerId);
    if (profile === undefined) {
      return { configured: false, credentialConfigured: false, consent: "required" };
    }
    let credentialConfigured = false;
    try {
      credentialConfigured = profile.authMode === "none" || await this.#credentials.has(profile.credentialTarget);
    } catch {
      // A missing helper is reported as not configured; no secret or helper
      // path is exposed through status. Creation still fails closed.
      credentialConfigured = false;
    }
    return {
      configured: true,
      credentialConfigured,
      consent: await this.#consent.state(profile, DEFAULT_CONSENT_DATA_CATEGORIES),
      profile,
    };
  }

  async preview(providerId: string, payload?: unknown, dataCategories?: readonly ConsentDataCategory[]) {
    assertDurableConsentCategories(dataCategories);
    const profile = await this.#profiles.get(providerId);
    if (profile === undefined) throw new ProviderConfigurationError("Provider is not configured");
    return this.#consent.preview(profile, payload, dataCategories);
  }

  previewConnectionTest(input: ProviderTestSettings) {
    const parsed = parseProviderTestSettings(input);
    const resolution = resolveProviderCompatibility(parsed);
    const profile = providerProfileWithDefaults({
      providerId: parsed.providerId,
      baseURL: parsed.baseURL,
      model: parsed.model,
      authMode: parsed.authMode,
      apiMode: parsed.apiMode,
      reasoningMode: parsed.reasoningMode,
      dataCategories: ["connection_probe"],
      maxCalls: 1,
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
    }, resolution, this.#now());
    return this.#consent.preview(profile, {
      ...CONNECTION_PROBE_PAYLOAD,
      authMode: parsed.authMode,
      apiMode: parsed.apiMode,
      reasoningMode: parsed.reasoningMode,
      resolvedApiMode: resolution.apiMode,
      resolvedReasoning: resolution.reasoning,
    }, ["connection_probe"]);
  }

  async testConnection(input: ProviderTestSettings & {
    apiKey?: string;
    consentKey: string;
    payloadHash: string;
  }, signal?: AbortSignal): Promise<ProviderConnectionProbeResult & { testId: string }> {
    const parsed = parseProviderTestSettings(input);
    const preview = this.previewConnectionTest(parsed);
    if (preview.consentKey !== input.consentKey || preview.payloadPreview.redactedHash !== input.payloadHash) {
      throw new ProviderConfigurationError("Connection test authorization is missing or stale");
    }
    const canonicalBaseURL = canonicalProviderBaseURL(parsed.baseURL);
    const secret = await this.#resolveCredential(parsed, input.apiKey);
    const resolution = ProviderCompatibilityResolutionSchema.parse(resolveProviderCompatibility(parsed));
    const result = await runProviderConnectionProbe({
      apiKey: secret,
      baseURL: canonicalBaseURL,
      model: parsed.model,
      authMode: parsed.authMode,
      apiMode: resolution.apiMode,
      providerKind: resolution.providerKind,
      reasoningMode: parsed.reasoningMode,
    }, signal, this.#probeTransportFactory);
    const testId = randomUUID();
    this.#successfulTests.set(testId, {
      providerId: parsed.providerId,
      baseURL: canonicalBaseURL,
      model: parsed.model,
      authMode: parsed.authMode,
      apiMode: parsed.apiMode,
      reasoningMode: parsed.reasoningMode,
      resolution,
      credentialFingerprint: credentialFingerprint(parsed.authMode, secret),
      expiresAt: this.#now().getTime() + 10 * 60_000,
    });
    return { ...result, testId };
  }

  async listModels(input: {
    providerId: string;
    baseURL: string;
    authMode: ProviderTestSettings["authMode"];
    apiKey?: string;
  }, signal?: AbortSignal): Promise<readonly string[]> {
    const settings = ProviderTestSettingsSchema.parse({
      providerId: input.providerId,
      baseURL: input.baseURL,
      model: "model-catalog",
      authMode: input.authMode,
      apiMode: "auto",
      reasoningMode: "auto",
    });
    const secret = await this.#resolveCredential(settings, input.apiKey);
    return listProviderModels({
      baseURL: settings.baseURL,
      authMode: settings.authMode,
      apiKey: secret,
    }, signal);
  }

  clearSuccessfulTests(providerId: string): void {
    for (const [testId, ticket] of this.#successfulTests) {
      if (ticket.providerId === providerId) this.#successfulTests.delete(testId);
    }
  }

  async #resolveCredential(settings: ProviderTestSettings, supplied?: string): Promise<string> {
    if (settings.authMode === "none") return "";
    if (supplied !== undefined) return supplied;
    const canonicalBaseURL = canonicalProviderBaseURL(settings.baseURL);
    const stored = await this.#profiles.get(settings.providerId);
    if (stored === undefined || stored.authMode !== "bearer"
      || canonicalProviderBaseURL(stored.baseURL) !== canonicalBaseURL) {
      throw new ProviderConfigurationError("API key is required when testing a new provider endpoint");
    }
    const secret = await this.#credentials.get(stored.credentialTarget);
    if (secret === undefined) throw new ProviderConfigurationError("Provider credential is not configured");
    return secret;
  }

  async grantConsent(providerId: string, consentKey: string, dataCategories?: readonly ConsentDataCategory[]) {
    assertDurableConsentCategories(dataCategories);
    const profile = await this.#profiles.get(providerId);
    if (profile === undefined) throw new ProviderConfigurationError("Provider is not configured");
    return this.#consent.grant(profile, consentKey, dataCategories);
  }

  async revokeConsent(providerId: string): Promise<void> {
    await this.#consent.revoke(providerId);
  }

  get consent(): ConsentManager {
    return this.#consent;
  }

  get credentials(): CredentialStore {
    return this.#credentials;
  }

  get profiles(): ProviderProfileStore {
    return this.#profiles;
  }
}

export const ProviderStatusSchema = z
  .object({
    configured: z.boolean(),
    credentialConfigured: z.boolean(),
    consent: z.enum(["required", "granted", "revoked"]),
    profile: ProviderProfileSchema.optional(),
  })
  .strict();

function credentialFingerprint(authMode: ProviderTestSettings["authMode"], secret: string): string {
  return createHash("sha256").update(`${authMode}\0${secret}`, "utf8").digest("hex");
}
