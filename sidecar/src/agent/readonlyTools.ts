import type {
  BuildSnapshot,
  Candidate,
  ObjectiveSpec,
  OptimizationRun,
  ScenarioSpec,
} from "../schemas.js";
import { redactForModel } from "../llm/redaction.js";
import {
  HIGH_LEVEL_TOOL_SCHEMAS,
  isHighLevelToolName,
  type HighLevelToolArguments,
  type HighLevelToolName,
} from "../llm/toolSchemas.js";
import type { ParsedToolCall } from "../llm/types.js";

export interface ReadonlyToolContext {
  readonly snapshot: BuildSnapshot;
  readonly objective: ObjectiveSpec;
  readonly scenarios: readonly ScenarioSpec[];
  readonly run?: OptimizationRun;
  readonly candidates?: readonly Candidate[];
  readonly signal?: AbortSignal;
}

export type ReadonlyToolHandler<TName extends HighLevelToolName> = (
  args: HighLevelToolArguments<TName>,
  context: ReadonlyToolContext,
) => Promise<unknown> | unknown;

export type ReadonlyToolHandlers = {
  readonly [TName in HighLevelToolName]?: ReadonlyToolHandler<TName>;
};

export interface ToolExecutionResult {
  readonly toolCallId: string;
  readonly name: HighLevelToolName;
  readonly ok: boolean;
  readonly output: unknown;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 2000);
  }
  return "Tool execution failed";
}

export class ReadonlyToolDispatcher {
  readonly #handlers: ReadonlyToolHandlers;

  constructor(handlers: ReadonlyToolHandlers) {
    this.#handlers = Object.freeze({ ...handlers });
  }

  async execute(
    call: ParsedToolCall<HighLevelToolName>,
    context: ReadonlyToolContext,
  ): Promise<ToolExecutionResult> {
    if (!isHighLevelToolName(call.name)) {
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        output: { error: "forbidden_tool" },
      };
    }
    const parsedArguments = HIGH_LEVEL_TOOL_SCHEMAS[call.name].safeParse(call.arguments);
    if (!parsedArguments.success) {
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        output: { error: "invalid_arguments" },
      };
    }

    const handler = this.#handlers[call.name] as ReadonlyToolHandler<typeof call.name> | undefined;
    if (handler === undefined) {
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        output: { error: "tool_unavailable" },
      };
    }

    try {
      const output = await handler(parsedArguments.data, context);
      return {
        toolCallId: call.id,
        name: call.name,
        ok: true,
        output: redactForModel(output),
      };
    } catch (error) {
      return {
        toolCallId: call.id,
        name: call.name,
        ok: false,
        output: redactForModel({ error: "tool_failed", detail: safeError(error) }),
      };
    }
  }
}
