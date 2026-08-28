import { z } from "zod";

export const ProviderConfigSchema = z
  .object({
    apiKey: z.string().min(1),
    baseURL: z.string().url().optional(),
    model: z.string().min(1),
    maxCalls: z.number().int().min(1).max(128).default(16),
    maxOutputTokens: z.number().int().min(1).max(65_536).default(4096),
    timeoutMs: z.number().int().min(100).max(600_000).default(120_000),
  })
  .strict();

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const AgentMessageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z
        .array(
          z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
              arguments: z.string(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      content: z.string(),
      toolCallId: z.string().min(1),
    })
    .strict(),
]);

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const ModelTurnInputSchema = z
  .object({
    messages: z.array(AgentMessageSchema).min(1),
    context: z.unknown().optional(),
  })
  .strict();

export type ModelTurnInput = z.infer<typeof ModelTurnInputSchema>;

export type FallbackReason =
  | "provider_unavailable"
  | "provider_timeout"
  | "invalid_provider_response"
  | "provider_consent_required"
  | "model_call_limit";

export interface DeterministicFallbackSignal {
  readonly type: "deterministic_fallback";
  readonly reason: FallbackReason;
  readonly retryable: boolean;
  readonly detail: string;
}

export interface ParsedToolCall<TName extends string = string> {
  readonly id: string;
  readonly name: TName;
  readonly arguments: unknown;
  readonly rawArguments: string;
}

export type ModelTurnResult<TName extends string = string> =
  | {
      readonly kind: "message";
      readonly content: string;
      readonly toolCalls: readonly ParsedToolCall<TName>[];
      readonly usage?: {
        readonly inputTokens: number;
        readonly outputTokens: number;
      };
    }
  | {
      readonly kind: "fallback";
      readonly signal: DeterministicFallbackSignal;
    };

export interface ModelAdapter<TName extends string = string> {
  readonly callsUsed: number;
  readonly callsRemaining: number;
  complete(input: ModelTurnInput, signal?: AbortSignal): Promise<ModelTurnResult<TName>>;
}
