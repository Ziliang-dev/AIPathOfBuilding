import { OpenAICompatibleAdapter, type OpenAICompatibleAdapterOptions } from "../llm/openaiCompatible.js";
import type { HighLevelToolName } from "../llm/toolSchemas.js";
import type { ModelAdapter, ModelToolRegistry, ModelTurnInput, ModelTurnResult } from "../llm/types.js";
import { ConsentManager, redactChatPayload } from "./consent.js";
import { ProviderConfigurationError, type ProviderProfileService } from "./profileService.js";
import type { ProviderProfile } from "./types.js";
import { DEFAULT_CONSENT_DATA_CATEGORIES, type ConsentDataCategory } from "./types.js";
import { providerKindForBaseURL } from "./compatibility.js";

/** Adds the consent gate in front of every provider request. */
export class ConsentGuardAdapter<TName extends string = HighLevelToolName> implements ModelAdapter<TName> {
  readonly #inner: ModelAdapter<TName>;
  readonly #profile: ProviderProfile;
  readonly #consent: ConsentManager;
  readonly #dataCategories: readonly ConsentDataCategory[];

  constructor(
    inner: ModelAdapter<TName>,
    profile: ProviderProfile,
    consent: ConsentManager,
    dataCategories: readonly ConsentDataCategory[] = DEFAULT_CONSENT_DATA_CATEGORIES,
  ) {
    this.#inner = inner;
    this.#profile = profile;
    this.#consent = consent;
    this.#dataCategories = dataCategories;
  }

  get callsUsed(): number {
    return this.#inner.callsUsed;
  }

  get callsRemaining(): number {
    return this.#inner.callsRemaining;
  }

  async complete(input: ModelTurnInput, signal?: AbortSignal): Promise<ModelTurnResult<TName>> {
    if (!(await this.#consent.isGranted(this.#profile, this.#dataCategories))) {
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
  readonly adapter?: Pick<OpenAICompatibleAdapterOptions, "transport">;
}

export interface CreateProviderModelAdapterOptions<TName extends string> {
  readonly toolRegistry?: ModelToolRegistry<TName>;
  readonly systemPolicy?: string;
  readonly dataCategories?: readonly ConsentDataCategory[];
}

/** Builds an ephemeral adapter. No API key is retained in profile/status state. */
export class ProviderModelAdapterFactory {
  readonly #service: ProviderProfileService;
  readonly #adapterOptions: Pick<OpenAICompatibleAdapterOptions, "transport">;

  constructor(options: ProviderModelAdapterFactoryOptions) {
    this.#service = options.service;
    this.#adapterOptions = options.adapter ?? {};
  }

  async create<TName extends string = HighLevelToolName>(
    providerId: string,
    options: CreateProviderModelAdapterOptions<TName> = {},
  ): Promise<ModelAdapter<TName>> {
    const status = await this.#service.status(providerId);
    if (!status.configured || status.profile === undefined) {
      throw new ProviderConfigurationError("Provider is not configured");
    }
    const secret = status.profile.authMode === "none"
      ? ""
      : await this.#service.credentials.get(status.profile.credentialTarget);
    if (secret === undefined) throw new ProviderConfigurationError("Provider credential is not configured");
    const adapterOptions: OpenAICompatibleAdapterOptions<TName> = {
      ...(this.#adapterOptions.transport === undefined ? {} : { transport: this.#adapterOptions.transport }),
      ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
      ...(options.systemPolicy === undefined ? {} : { systemPolicy: options.systemPolicy }),
    };
    const inner = new OpenAICompatibleAdapter<TName>(
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
      adapterOptions,
    );
    return new ConsentGuardAdapter<TName>(
      inner,
      status.profile,
      this.#service.consent,
      options.dataCategories ?? DEFAULT_CONSENT_DATA_CATEGORIES,
    );
  }
}
