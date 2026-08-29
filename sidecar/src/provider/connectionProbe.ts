import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  createOpenAICompatibleTransport,
  type ChatCompletionTransport,
} from "../llm/openaiCompatible.js";
import { redactString } from "../llm/redaction.js";
import { ProviderConfigSchema, type ProviderConfig } from "../llm/types.js";

export const CONNECTION_PROBE_TIMEOUT_MS = 30_000;
export const CONNECTION_PROBE_TOOL_NAME = "aipob_connection_probe";

export const CONNECTION_PROBE_PAYLOAD = Object.freeze({
  kind: "connection_probe",
  version: 1,
  prompt: "Call aipob_connection_probe with ok=true. Do not answer with text.",
  tool: CONNECTION_PROBE_TOOL_NAME,
});

const ConnectionProbeResponseSchema = z.looseObject({
  model: z.string().min(1).optional(),
  choices: z.array(z.looseObject({
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

const ConnectionProbeArgumentsSchema = z.object({ ok: z.literal(true) }).strict();

export interface ChatCompletionTransportFactory {
  (config: ProviderConfig): ChatCompletionTransport;
}

export interface ProviderConnectionProbeResult {
  readonly ok: true;
  readonly latencyMs: number;
  readonly requestedModel: string;
  readonly responseModel: string;
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
  return status === undefined ? redacted : `HTTP ${status}: ${redacted}`;
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
    maxOutputTokens: 32,
    timeoutMs,
  });
  const transport = transportFactory(config);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  const startedAt = performance.now();
  let raw: unknown;
  try {
    raw = await transport.create({
      model: config.model,
      messages: [
        {
          role: "system",
          content: "This is an AIPathOfBuilding connection test. Use only the requested synthetic tool.",
        },
        { role: "user", content: CONNECTION_PROBE_PAYLOAD.prompt },
      ],
      tools: [{
        type: "function",
        function: {
          name: CONNECTION_PROBE_TOOL_NAME,
          description: "Confirm OpenAI-compatible tool calling for AIPathOfBuilding.",
          parameters: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
            additionalProperties: false,
          },
        },
      }],
      tool_choice: { type: "function", function: { name: CONNECTION_PROBE_TOOL_NAME } },
      parallel_tool_calls: false,
      max_completion_tokens: 32,
    }, requestSignal);
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Connection test cancelled");
    }
    if (timeoutSignal.aborted) {
      throw new ProviderConnectionProbeError(`Connection test timed out after ${timeoutMs} ms`);
    }
    throw new ProviderConnectionProbeError(`Connection test failed: ${safeErrorMessage(error, config.apiKey)}`);
  }

  const parsed = ConnectionProbeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderConnectionProbeError("Connection test failed: provider returned a malformed Chat Completions response");
  }
  const calls = parsed.data.choices[0]?.message.tool_calls ?? [];
  const probeCall = calls.find((call) => call.function.name === CONNECTION_PROBE_TOOL_NAME);
  if (probeCall === undefined) {
    throw new ProviderConnectionProbeError("Connection test failed: model did not return the required tool call");
  }
  let args: unknown;
  try {
    args = JSON.parse(probeCall.function.arguments) as unknown;
  } catch {
    throw new ProviderConnectionProbeError("Connection test failed: tool arguments were not valid JSON");
  }
  if (!ConnectionProbeArgumentsSchema.safeParse(args).success) {
    throw new ProviderConnectionProbeError("Connection test failed: tool arguments did not contain ok=true");
  }
  const usage = parsed.data.usage;
  return {
    ok: true,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    requestedModel: config.model,
    responseModel: parsed.data.model ?? config.model,
    toolCallValidated: true,
    ...(usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined
      ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } }
      : {}),
  };
}
