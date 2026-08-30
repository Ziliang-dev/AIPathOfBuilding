import { createHash } from "node:crypto";
import { DeepLimitsSchema, type DeepLimits, type StopReason } from "../schemas.js";
import { stringifyForModel } from "../llm/redaction.js";
import type { HighLevelToolName } from "../llm/toolSchemas.js";
import {
  AgentMessageSchema,
  type AgentMessage,
  type DeterministicFallbackSignal,
  type ModelAdapter,
  type ParsedToolCall,
} from "../llm/types.js";
import {
  ReadonlyToolDispatcher,
  type ReadonlyToolContext,
} from "./readonlyTools.js";

export interface AgentToolExecutionResult<TName extends string = string> {
  readonly toolCallId: string;
  readonly name: TName;
  readonly ok: boolean;
  readonly output: unknown;
}

export interface AgentToolDispatcher<TName extends string, TContext> {
  execute(call: ParsedToolCall<TName>, context: TContext): Promise<AgentToolExecutionResult<TName>>;
}

export interface AgentLoopOptions<TName extends string, TContext> {
  readonly adapter: ModelAdapter<TName>;
  readonly dispatcher: AgentToolDispatcher<TName, TContext>;
  readonly messages: readonly AgentMessage[];
  readonly context: TContext;
  readonly modelContext?: unknown;
  readonly limits?: Partial<DeepLimits>;
  readonly signal?: AbortSignal;
  readonly stopAfterTool?: (
    result: AgentToolExecutionResult<TName>,
    context: TContext,
  ) => boolean;
}

export interface AgentLoopResult<TName extends string = string> {
  readonly stopReason: StopReason;
  readonly content: string;
  readonly messages: readonly AgentMessage[];
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly toolResults: readonly AgentToolExecutionResult<TName>[];
  readonly fallback?: DeterministicFallbackSignal;
}

export interface ReadonlyAgentLoopOptions {
  readonly adapter: ModelAdapter<HighLevelToolName>;
  readonly dispatcher: ReadonlyToolDispatcher;
  readonly messages: readonly AgentMessage[];
  readonly context: ReadonlyToolContext;
  readonly limits?: Partial<DeepLimits>;
  readonly signal?: AbortSignal;
}

export type ReadonlyAgentLoopResult = AgentLoopResult<HighLevelToolName>;

interface DuplicateState {
  signature: string;
  repeats: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function duplicateSignature<TName extends string>(call: ParsedToolCall<TName>, result: AgentToolExecutionResult<TName>): string {
  const serialized = JSON.stringify(
    canonicalize({ name: call.name, arguments: call.arguments, ok: result.ok, output: result.output }),
  );
  return createHash("sha256").update(serialized).digest("hex");
}

function resolveLimits(limits: Partial<DeepLimits> | undefined): DeepLimits {
  return DeepLimitsSchema.parse(limits ?? {});
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function stopped<TName extends string>(
  stopReason: StopReason,
  content: string,
  messages: readonly AgentMessage[],
  initialAdapterCalls: number,
  adapter: ModelAdapter<TName>,
  toolResults: readonly AgentToolExecutionResult<TName>[],
  fallback?: DeterministicFallbackSignal,
): AgentLoopResult<TName> {
  return {
    stopReason,
    content,
    messages,
    modelCalls: adapter.callsUsed - initialAdapterCalls,
    toolCalls: toolResults.length,
    toolResults,
    ...(fallback === undefined ? {} : { fallback }),
  };
}

export async function runReadonlyAgentLoop(
  options: ReadonlyAgentLoopOptions,
): Promise<ReadonlyAgentLoopResult> {
  return runAgentLoop(options);
}

export async function runAgentLoop<TName extends string, TContext>(
  options: AgentLoopOptions<TName, TContext>,
): Promise<AgentLoopResult<TName>> {
  const limits = resolveLimits(options.limits);
  const parsedMessages = options.messages.map((message) => AgentMessageSchema.parse(message));
  const messages: AgentMessage[] = [...parsedMessages];
  const toolResults: AgentToolExecutionResult<TName>[] = [];
  const startedAt = Date.now();
  const initialAdapterCalls = options.adapter.callsUsed;
  let duplicateState: DuplicateState | undefined;
  let lastContent = "";

  for (let step = 0; step < limits.recursionLimit; step += 1) {
    if (isAborted(options.signal)) {
      return stopped(
        "cancelled",
        lastContent,
        messages,
        initialAdapterCalls,
        options.adapter,
        toolResults,
      );
    }
    if (Date.now() - startedAt >= limits.wallTimeMs) {
      return stopped(
        "wall_time",
        lastContent,
        messages,
        initialAdapterCalls,
        options.adapter,
        toolResults,
      );
    }
    if (options.adapter.callsUsed - initialAdapterCalls >= limits.modelCallLimit) {
      return stopped(
        "model_call_limit",
        lastContent,
        messages,
        initialAdapterCalls,
        options.adapter,
        toolResults,
      );
    }

    let turn;
    try {
      turn = await options.adapter.complete(
        { messages, context: options.modelContext ?? options.context },
        options.signal,
      );
    } catch (error) {
      if (!isAborted(options.signal)) throw error;
      return stopped(
        "cancelled",
        lastContent,
        messages,
        initialAdapterCalls,
        options.adapter,
        toolResults,
      );
    }
    if (isAborted(options.signal)) {
      return stopped(
        "cancelled",
        lastContent,
        messages,
        initialAdapterCalls,
        options.adapter,
        toolResults,
      );
    }
    if (turn.kind === "fallback") {
      return stopped(
        turn.signal.reason === "model_call_limit" ? "model_call_limit" : "provider_fallback",
        lastContent,
        messages,
        initialAdapterCalls,
        options.adapter,
        toolResults,
        turn.signal,
      );
    }

    lastContent = turn.content;
    messages.push({
      role: "assistant",
      content: turn.content,
      ...(turn.toolCalls.length === 0
        ? {}
        : {
            toolCalls: turn.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.rawArguments,
            })),
          }),
    });
    if (turn.toolCalls.length === 0) {
      return stopped(
        "completed",
        turn.content,
        messages,
        initialAdapterCalls,
        options.adapter,
        toolResults,
      );
    }

    for (const call of turn.toolCalls) {
      if (isAborted(options.signal)) {
        return stopped(
          "cancelled",
          lastContent,
          messages,
          initialAdapterCalls,
          options.adapter,
          toolResults,
        );
      }
      const result = await options.dispatcher.execute(call, options.context);
      toolResults.push(result);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: stringifyForModel({ ok: result.ok, output: result.output }),
      });

      if (options.stopAfterTool?.(result, options.context) === true) {
        return stopped(
          "completed",
          lastContent,
          messages,
          initialAdapterCalls,
          options.adapter,
          toolResults,
        );
      }

      const signature = duplicateSignature(call, result);
      duplicateState =
        duplicateState?.signature === signature
          ? { signature, repeats: duplicateState.repeats + 1 }
          : { signature, repeats: 1 };
      if (duplicateState.repeats >= limits.duplicateCallLimit) {
        return stopped(
          "doom_loop",
          lastContent,
          messages,
          initialAdapterCalls,
          options.adapter,
          toolResults,
        );
      }
    }
  }

  return stopped(
    "failed",
    lastContent,
    messages,
    initialAdapterCalls,
    options.adapter,
    toolResults,
  );
}
