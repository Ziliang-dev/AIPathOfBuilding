import { z } from "zod";
import { type CredentialStore } from "../credentials/types.js";
import { credentialTarget } from "../credentials/wincredClient.js";
import { ConsentManager } from "./consent.js";
import {
  ProviderConfigureInputSchema,
  ProviderProfileSchema,
  type ProviderConfigureInput,
  type ProviderProfile,
  type ProviderProfileStore,
  type ProviderStatus,
  type ConsentDataCategory,
  providerProfileWithDefaults,
} from "./types.js";

export class ProviderConfigurationError extends Error {
  override readonly name = "ProviderConfigurationError";
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
  #configureChain: Promise<void> = Promise.resolve();

  constructor(options: {
    profiles: ProviderProfileStore;
    credentials: CredentialStore;
    consent: ConsentManager;
    now?: () => Date;
  }) {
    this.#profiles = options.profiles;
    this.#credentials = options.credentials;
    this.#consent = options.consent;
    this.#now = options.now ?? (() => new Date());
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
    const profile = await this.#profiles.get(providerId);
    if (profile === undefined) throw new ProviderConfigurationError("Provider is not configured");
    return this.#consent.preview(profile, payload, dataCategories);
  }

  async grantConsent(providerId: string, consentKey: string, dataCategories?: readonly ConsentDataCategory[]) {
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
