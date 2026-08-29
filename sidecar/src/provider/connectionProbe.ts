import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  createOpenAICompatibleTransport,
  type ProviderCompletionTransport,
} from "../llm/openaiCompatible.js";
import { redactString } from "../llm/redaction.js";
import { ProviderConfigSchema, type ProviderConfig } from "../llm/types.js";
import {
  reasoningRequestFields,
  resolveProviderReasoning,
  type ResolvedProviderApiMode,
  type ResolvedProviderReasoning,
} from "./compatibility.js";

export const CONNECTION_PROBE_TIMEOUT_MS = 30_000;
export const CONNECTION_PROBE_OUTPUT_TOKENS = 1_024;
export const CONNECTION_PROBE_TOOL_NAME = "aipob_connection_probe";

export const CONNECTION_PROBE_PAYLOAD = Object.freeze({
  kind: "connection_probe",
  version: 2,
  system: "Capability test. Call the only provided function exactly once. Return no prose.",
  prompt: "Call the connection probe with ok=true.",
  tool: CONNECTION_PROBE_TOOL_NAME,
});

const ChatProbeResponseSchema = z.looseObject({
  model: z.string().min(1).optional(),
  choices: z.array(z.looseObject({
    finish_reason: z.string().optional(),
    message: z.looseObject({
      tool_calls: z.array(z.looseObject({
        type: z.literal("function"),
        function: z.looseObject({
          name: z.string().min(1),
          arguments: z.string(),
        }),
      })).optional(),
    }),
  })).min(1),
  usage: z.looseObject({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

const ResponsesProbeResponseSchema = z.looseObject({
  model: z.string().min(1).optional(),
  incomplete_details: z.looseObject({ reason: z.string().optional() }).nullable().optional(),
  output: z.array(z.looseObject({
    type: z.string(),
    call_id: z.string().optional(),
    name: z.string().optional(),
    arguments: z.string().optional(),
  })).default([]),
  usage: z.looseObject({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
  }).optional(),
});

const ConnectionProbeArgumentsSchema = z.object({ ok: z.literal(true) }).strict();

export interface ChatCompletionTransportFactory {
  (config: ProviderConfig): ProviderCompletionTransport;
}

export interface ProviderConnectionProbeResult {
  readonly ok: true;
  readonly latencyMs: number;
  readonly requestedModel: string;
  readonly responseModel: string;
  readonly resolvedApiMode: ResolvedProviderApiMode;
  readonly resolvedReasoning: ResolvedProviderReasoning;
  readonly toolCallValidated: true;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export class ProviderConnectionProbeError extends Error {
  override readonly name = "ProviderConnectionProbeError";
}

function safeErrorMessage(error: unknown, apiKey: string): string {
  let message = error instanceof Error ? error.message : "Unknown provider error";
  if (apiKey !== "") message = message.split(apiKey).join("[REDACTED]");
  const status = typeof error === "object" && error !== null && "status" in error
    && typeof error.status === "number" ? error.status : undefined;
  const redacted = redactString(message).slice(0, 2_000);
  return status === undefined || redacted.startsWith(`HTTP ${status}:`)
    ? redacted
    : `HTTP ${status}: ${redacted}`;
}

function probeTool(apiMode: ResolvedProviderApiMode): Record<string, unknown> {
  const definition = {
    name: CONNECTION_PROBE_TOOL_NAME,
    description: "Confirm OpenAI-compatible function tool calling for AIPathOfBuilding.",
    parameters: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  };
  return apiMode === "responses"
    ? { type: "function", ...definition }
    : { type: "function", function: definition };
}

function resolvedReasoning(config: ProviderConfig): ResolvedProviderReasoning {
  return resolveProviderReasoning(config.providerKind, config.model, config.reasoningMode);
}

function probeRequest(config: ProviderConfig): Record<string, unknown> {
  const resolution = {
    providerKind: config.providerKind,
    apiMode: config.apiMode,
    reasoning: resolvedReasoning(config),
  } as const;
  if (config.apiMode === "responses") {
    return {
      model: config.model,
      input: [
        { role: "system", content: CONNECTION_PROBE_PAYLOAD.system },
        { role: "user", content: CONNECTION_PROBE_PAYLOAD.prompt },
      ],
      tools: [probeTool(config.apiMode)],
      tool_choice: "required",
      max_output_tokens: CONNECTION_PROBE_OUTPUT_TOKENS,
      store: false,
      ...reasoningRequestFields(resolution),
    };
  }
  return {
    model: config.model,
    messages: [
      { role: "system", content: CONNECTION_PROBE_PAYLOAD.system },
      { role: "user", content: CONNECTION_PROBE_PAYLOAD.prompt },
    ],
    tools: [probeTool(config.apiMode)],
    tool_choice: "required",
    ...(config.providerKind === "openai"
      ? { max_completion_tokens: CONNECTION_PROBE_OUTPUT_TOKENS }
      : { max_tokens: CONNECTION_PROBE_OUTPUT_TOKENS }),
    ...reasoningRequestFields(resolution),
  };
}

function parseArguments(raw: string): void {
  let args: unknown;
  try {
    args = JSON.parse(raw) as unknown;
  } catch {
    throw new ProviderConnectionProbeError("Connection test failed: tool arguments were not valid JSON");
  }
  if (!ConnectionProbeArgumentsSchema.safeParse(args).success) {
    throw new ProviderConnectionProbeError("Connection test failed: tool arguments did not contain ok=true");
  }
}

export async function runProviderConnectionProbe(
  input: z.input<typeof ProviderConfigSchema>,
  signal?: AbortSignal,
  transportFactory: ChatCompletionTransportFactory = createOpenAICompatibleTransport,
  timeoutMs = CONNECTION_PROBE_TIMEOUT_MS,
): Promise<ProviderConnectionProbeResult> {
  const config = ProviderConfigSchema.parse({
    ...input,
    maxCalls: 1,
    maxOutputTokens: CONNECTION_PROBE_OUTPUT_TOKENS,
    timeoutMs,
  });
  const transport = transportFactory(config);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const startedAt = performance.now();
  let raw: unknown;
  try {
    raw = await transport.create(probeRequest(config), requestSignal);
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Connection test cancelled");
    }
    if (timeoutSignal.aborted) {
      throw new ProviderConnectionProbeError(`Connection test timed out after ${timeoutMs} ms`);
    }
    throw new ProviderConnectionProbeError(`Connection test failed: ${safeErrorMessage(error, config.apiKey)}`);
  }

  let responseModel = config.model;
  let argumentsText: string | undefined;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  let budgetExhausted = false;
  if (config.apiMode === "responses") {
    const parsed = ResponsesProbeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderConnectionProbeError("Connection test failed: provider returned a malformed Responses API response");
    }
    responseModel = parsed.data.model ?? config.model;
    const call = parsed.data.output.find((item) => item.type === "function_call" && item.name === CONNECTION_PROBE_TOOL_NAME);
    argumentsText = call?.arguments;
    budgetExhausted = parsed.data.incomplete_details?.reason === "max_output_tokens";
    if (parsed.data.usage?.input_tokens !== undefined && parsed.data.usage.output_tokens !== undefined) {
      usage = { inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens };
    }
  } else {
    const parsed = ChatProbeResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderConnectionProbeError("Connection test failed: provider returned a malformed Chat Completions response");
    }
    responseModel = parsed.data.model ?? config.model;
    const choice = parsed.data.choices[0];
    const call = (choice?.message.tool_calls ?? []).find((item) => item.function.name === CONNECTION_PROBE_TOOL_NAME);
    argumentsText = call?.function.arguments;
    budgetExhausted = choice?.finish_reason === "length";
    if (parsed.data.usage?.prompt_tokens !== undefined && parsed.data.usage.completion_tokens !== undefined) {
      usage = { inputTokens: parsed.data.usage.prompt_tokens, outputTokens: parsed.data.usage.completion_tokens };
    }
  }
  if (argumentsText === undefined) {
    throw new ProviderConnectionProbeError(budgetExhausted
      ? "Connection test failed: model exhausted the output budget before the required tool call; choose Reasoning Fast"
      : "Connection test failed: model did not return the required tool call");
  }
  parseArguments(argumentsText);
  return {
    ok: true,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    requestedModel: config.model,
    responseModel,
    resolvedApiMode: config.apiMode,
    resolvedReasoning: resolvedReasoning(config),
    toolCallValidated: true,
    ...(usage === undefined ? {} : { usage }),
  };
}
