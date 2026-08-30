import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  DeepLimitsSchema,
  type DeepLimits,
  type StopReason,
} from "../schemas.js";
import type { WorkflowState } from "./state.js";

export const DEFAULT_DEEP_LIMITS: DeepLimits = DeepLimitsSchema.parse({});

export function resolveDeepLimits(overrides: Partial<DeepLimits> = {}): DeepLimits {
  return DeepLimitsSchema.parse({ ...DEFAULT_DEEP_LIMITS, ...overrides });
}

export function workflowConfig(
  threadId: string,
  limits: DeepLimits = DEFAULT_DEEP_LIMITS,
  checkpointNamespace?: string,
  signal?: AbortSignal,
): LangGraphRunnableConfig {
  if (threadId.trim().length === 0) throw new Error("threadId must not be empty");
  const configurable: Record<string, string> = { thread_id: threadId };
  if (checkpointNamespace !== undefined) configurable.checkpoint_ns = checkpointNamespace;
  return {
    configurable,
    recursionLimit: limits.recursionLimit,
    ...(signal ? { signal } : {}),
  };
}

export function currentLimitStopReason(
  state: WorkflowState,
  limits: DeepLimits,
  nowMs: number,
): StopReason | undefined {
  if (state.cancelRequested) return "cancelled";
  if (state.stopReason !== undefined) return state.stopReason;
  if (state.startedAtMs > 0 && nowMs - state.startedAtMs >= limits.wallTimeMs) return "wall_time";
  if (state.evaluations >= limits.evaluationLimit) return "evaluation_limit";
  if (state.modelCalls > 0 && state.modelCalls >= limits.modelCallLimit) return "model_call_limit";
  if (state.duplicateToolCalls >= limits.duplicateCallLimit) return "doom_loop";
  if (state.noImprovementRounds >= limits.convergenceRounds) return "converged";
  return undefined;
}

export function remainingBudget(state: WorkflowState, limits: DeepLimits, nowMs: number) {
  return {
    wallTimeMs: Math.max(0, limits.wallTimeMs - Math.max(0, nowMs - state.startedAtMs)),
    evaluations: Math.max(0, limits.evaluationLimit - state.evaluations),
    modelCalls: Math.max(0, limits.modelCallLimit - state.modelCalls),
    refinementRounds: Math.max(0, limits.convergenceRounds - state.noImprovementRounds),
  };
}
