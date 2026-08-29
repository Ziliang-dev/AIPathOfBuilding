import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from "../llm/openaiCompatible.js";
import type { HighLevelToolName } from "../llm/toolSchemas.js";
import type { ModelAdapter, ModelTurnInput, ModelTurnResult } from "../llm/types.js";
import { ConsentManager, redactChatPayload } from "./consent.js";
import { ProviderConfigurationError, type ProviderProfileService } from "./profileService.js";
import type { ProviderProfile } from "./types.js";
import { providerKindForBaseURL } from "./compatibility.js";

/** Adds the consent gate in front of every provider request. */
export class ConsentGuardAdapter implements ModelAdapter<HighLevelToolName> {
  readonly #inner: ModelAdapter<HighLevelToolName>;
  readonly #profile: ProviderProfile;
  readonly #consent: ConsentManager;

  constructor(inner: ModelAdapter<HighLevelToolName>, profile: ProviderProfile, consent: ConsentManager) {
    this.#inner = inner;
    this.#profile = profile;
    this.#consent = consent;
  }

  get callsUsed(): number {
    return this.#inner.callsUsed;
  }

  get callsRemaining(): number {
    return this.#inner.callsRemaining;
  }

  async complete(input: ModelTurnInput, signal?: AbortSignal): Promise<ModelTurnResult<HighLevelToolName>> {
    if (!(await this.#consent.isGranted(this.#profile))) {
      return {
        kind: "fallback",
        signal: {
          type: "deterministic_fallback",
          reason: "provider_consent_required",
          retryable: false,
          detail: "Provider consent is required before model data can be sent",
        },
      };
    }
    const redactedInput = redactChatPayload(input) as ModelTurnInput;
    return this.#inner.complete(redactedInput, signal);
  }
}

export interface ProviderModelAdapterFactoryOptions {
  readonly service: ProviderProfileService;
  readonly adapter?: OpenAICompatibleAdapterOptions;
}

/** Builds an ephemeral adapter. No API key is retained in profile/status state. */
export class ProviderModelAdapterFactory {
  readonly #service: ProviderProfileService;
  readonly #adapterOptions: OpenAICompatibleAdapterOptions;

  constructor(options: ProviderModelAdapterFactoryOptions) {
    this.#service = options.service;
    this.#adapterOptions = options.adapter ?? {};
  }

  async create(providerId: string): Promise<ModelAdapter<HighLevelToolName>> {
    const status = await this.#service.status(providerId);
    if (!status.configured || status.profile === undefined) {
      throw new ProviderConfigurationError("Provider is not configured");
    }
    const secret = status.profile.authMode === "none"
      ? ""
      : await this.#service.credentials.get(status.profile.credentialTarget);
    if (secret === undefined) throw new ProviderConfigurationError("Provider credential is not configured");
    const inner = new OpenAICompatibleAdapter(
      {
        apiKey: secret,
        baseURL: status.profile.baseURL,
        model: status.profile.model,
        authMode: status.profile.authMode,
        apiMode: status.profile.resolvedApiMode,
        providerKind: providerKindForBaseURL(status.profile.baseURL),
        reasoningMode: status.profile.reasoningMode,
        maxCalls: status.profile.maxCalls,
        maxOutputTokens: status.profile.maxOutputTokens,
        timeoutMs: status.profile.timeoutMs,
      },
      this.#adapterOptions,
    );
    return new ConsentGuardAdapter(inner, status.profile, this.#service.consent);
  }
}
