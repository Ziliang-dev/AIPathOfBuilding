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
  ProviderConfigureInputSchema,
  ProviderProfileSchema,
  type ProviderConfigureInput,
  type ProviderProfile,
  type ProviderProfileStore,
  type ProviderStatus,
  type ConsentDataCategory,
  providerProfileWithDefaults,
  canonicalProviderBaseURL,
} from "./types.js";

export class ProviderConfigurationError extends Error {
  override readonly name = "ProviderConfigurationError";
}

function assertDurableConsentCategories(dataCategories?: readonly ConsentDataCategory[]): void {
  if (dataCategories?.includes("connection_probe")) {
    throw new ProviderConfigurationError("connection_probe cannot be persisted as provider data consent");
  }
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
    const profile = providerProfileWithDefaults(parsed, this.#now());
    const oldProfile = await this.#profiles.get(profile.providerId);
    const target = credentialTarget(profile.providerId);
    if (parsed.apiKey === undefined && !parsed.clearCredential) {
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
    const shouldChangeSecret = parsed.apiKey !== undefined || parsed.clearCredential;
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
        if (parsed.clearCredential) {
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
      credentialConfigured = await this.#credentials.has(profile.credentialTarget);
    } catch {
      // A missing helper is reported as not configured; no secret or helper
      // path is exposed through status. Creation still fails closed.
      credentialConfigured = false;
    }
    return {
      configured: true,
      credentialConfigured,
      consent: await this.#consent.state(profile),
      profile,
    };
  }

  async preview(providerId: string, payload?: unknown, dataCategories?: readonly ConsentDataCategory[]) {
    assertDurableConsentCategories(dataCategories);
    const profile = await this.#profiles.get(providerId);
    if (profile === undefined) throw new ProviderConfigurationError("Provider is not configured");
    return this.#consent.preview(profile, payload, dataCategories);
  }

  previewConnectionTest(input: { providerId: string; baseURL: string; model: string }) {
    const profile = providerProfileWithDefaults({
      providerId: input.providerId,
      baseURL: input.baseURL,
      model: input.model,
      dataCategories: ["connection_probe"],
      maxCalls: 1,
      maxOutputTokens: 32,
      timeoutMs: 30_000,
    }, this.#now());
    return this.#consent.preview(profile, CONNECTION_PROBE_PAYLOAD, ["connection_probe"]);
  }

  async testConnection(input: {
    providerId: string;
    baseURL: string;
    model: string;
    apiKey?: string;
    consentKey: string;
    payloadHash: string;
  }, signal?: AbortSignal): Promise<ProviderConnectionProbeResult> {
    const preview = this.previewConnectionTest(input);
    if (preview.consentKey !== input.consentKey || preview.payloadPreview.redactedHash !== input.payloadHash) {
      throw new ProviderConfigurationError("Connection test authorization is missing or stale");
    }
    const canonicalBaseURL = canonicalProviderBaseURL(input.baseURL);
    let secret = input.apiKey;
    if (secret === undefined) {
      const stored = await this.#profiles.get(input.providerId);
      if (stored === undefined || canonicalProviderBaseURL(stored.baseURL) !== canonicalBaseURL) {
        throw new ProviderConfigurationError("API key is required when testing a new provider endpoint");
      }
      secret = await this.#credentials.get(stored.credentialTarget);
      if (secret === undefined) throw new ProviderConfigurationError("Provider credential is not configured");
    }
    return runProviderConnectionProbe({
      apiKey: secret,
      baseURL: canonicalBaseURL,
      model: input.model,
    }, signal, this.#probeTransportFactory);
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
