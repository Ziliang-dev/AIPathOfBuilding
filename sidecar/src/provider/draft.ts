import { z } from "zod";
import {
  HardConstraintSchema,
  GoalSchema,
  RankedScenarioIdSchema,
  SCHEMA_VERSION,
  ScenarioWeightsSchema,
} from "../schemas.js";
import { redactString } from "../llm/redaction.js";
import { redactChatPayload } from "./consent.js";
import type { HighLevelToolName } from "../llm/toolSchemas.js";
import type { AgentMessage, ModelAdapter, ModelTurnResult } from "../llm/types.js";

const StrictLocksSchema = z.object({
  class: z.boolean().default(true),
  ascendancy: z.boolean().default(true),
  mainSkill: z.boolean().default(true),
  fields: z.array(z.string().min(1)).default([]),
}).strict();
const StrictCandidateSourcesSchema = z.object({
  currentBuild: z.boolean().default(true),
  uniques: z.boolean().default(false),
  targetRares: z.boolean().default(false),
  trade: z.boolean().default(false),
}).strict();
const StrictTradeContextSchema = z.object({
  realm: z.string().min(1).max(32),
  league: z.string().min(1).max(128),
}).strict();

/** Strict at every object boundary, including model-provided nested objects. */
export const StrictObjectiveSpecDraftSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  description: z.string().max(8_000).optional(),
  constraintNotes: z.string().max(8_000).optional(),
  primaryScenario: RankedScenarioIdSchema.default("mapping"),
  scenarioWeights: ScenarioWeightsSchema.strict().default({ mapping: 0.55, standardBoss: 0.15, pinnacle: 0.15, uber: 0.15 }),
  locks: StrictLocksSchema.default({ class: true, ascendancy: true, mainSkill: true, fields: [] }),
  budgetDivine: z.number().nonnegative().optional(),
  searchPreset: z.literal("deep").default("deep"),
  goals: z.array(GoalSchema.strict()).min(1).optional(),
  hardConstraints: z.array(HardConstraintSchema.strict()).default([]),
  candidateSources: StrictCandidateSourcesSchema.default({ currentBuild: true, uniques: false, targetRares: false, trade: false }),
  tradeContext: StrictTradeContextSchema.optional(),
}).strict();
export type StrictObjectiveSpecDraft = z.infer<typeof StrictObjectiveSpecDraftSchema>;

const OBJECT_KEYS: Readonly<Record<string, readonly string[]>> = {
  root: [
    "schemaVersion", "description", "constraintNotes", "primaryScenario", "scenarioWeights", "locks",
    "budgetDivine", "searchPreset", "goals", "hardConstraints", "candidateSources", "tradeContext",
  ],
  scenarioWeights: ["mapping", "standardBoss", "pinnacle", "uber"],
  locks: ["class", "ascendancy", "mainSkill", "fields"],
  goal: ["metric", "direction", "weight"],
  hardConstraint: ["metric", "operator", "value", "scenario"],
  candidateSources: ["currentBuild", "uniques", "targetRares", "trade"],
  tradeContext: ["realm", "league"],
};

function assertObjectKeys(value: unknown, path: string, allowed: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new z.ZodError(
      unknown.map((key) => ({ code: "unrecognized_keys", keys: [key], path: path === "root" ? [] : path.split("."), message: `Unrecognized key: ${key}` })),
    );
  }
}

export function parseObjectiveSpecDraft(input: unknown): StrictObjectiveSpecDraft {
  assertObjectKeys(input, "root", OBJECT_KEYS.root ?? []);
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const root = input as Record<string, unknown>;
    assertObjectKeys(root.scenarioWeights, "scenarioWeights", OBJECT_KEYS.scenarioWeights ?? []);
    assertObjectKeys(root.locks, "locks", OBJECT_KEYS.locks ?? []);
    assertObjectKeys(root.candidateSources, "candidateSources", OBJECT_KEYS.candidateSources ?? []);
    assertObjectKeys(root.tradeContext, "tradeContext", OBJECT_KEYS.tradeContext ?? []);
    if (Array.isArray(root.goals)) {
      for (const goal of root.goals) assertObjectKeys(goal, "goals", OBJECT_KEYS.goal ?? []);
    }
    if (Array.isArray(root.hardConstraints)) {
      for (const constraint of root.hardConstraints) assertObjectKeys(constraint, "hardConstraints", OBJECT_KEYS.hardConstraint ?? []);
    }
  }
  return StrictObjectiveSpecDraftSchema.parse(input);
}

export interface ObjectiveDraftRequest {
  readonly messages: readonly AgentMessage[];
  readonly context?: unknown;
}

export type ObjectiveDraftResult =
  | { readonly kind: "draft"; readonly draft: StrictObjectiveSpecDraft; readonly rawContent: string }
  | { readonly kind: "fallback"; readonly signal: Extract<ModelTurnResult<HighLevelToolName>, { kind: "fallback" }>['signal'] };

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  if (trimmed.startsWith("```")) {
    const lines = trimmed.split(/\r?\n/);
    if (lines.length < 3 || !lines.at(-1)?.trim().startsWith("```")) throw new Error("Unclosed JSON code fence");
    return JSON.parse(lines.slice(1, -1).join("\n"));
  }
  return JSON.parse(trimmed);
}

/** Ephemeral, non-persistent planner chat surface. */
export class EphemeralPlannerChatService {
  readonly #adapter: ModelAdapter<HighLevelToolName>;

  constructor(adapter: ModelAdapter<HighLevelToolName>) {
    this.#adapter = adapter;
  }

  async complete(input: ObjectiveDraftRequest, signal?: AbortSignal): Promise<ModelTurnResult<HighLevelToolName>> {
    const messages = redactChatPayload(input.messages) as AgentMessage[];
    const context = input.context === undefined ? undefined : redactChatPayload(input.context);
    return this.#adapter.complete({ messages, ...(context === undefined ? {} : { context }) }, signal);
  }

  async draftObjective(input: ObjectiveDraftRequest, signal?: AbortSignal): Promise<ObjectiveDraftResult> {
    const request: ObjectiveDraftRequest = {
      messages: [
        ...input.messages,
        {
          role: "system",
          content: `Return only one JSON object matching ObjectiveSpecDraft schemaVersion ${SCHEMA_VERSION}. Do not include markdown or prose.`,
        },
      ],
      ...(input.context === undefined ? {} : { context: input.context }),
    };
    const result = await this.complete(request, signal);
    if (result.kind === "fallback") return result;
    if (result.toolCalls.length > 0) {
      return {
        kind: "fallback",
        signal: {
          type: "deterministic_fallback",
          reason: "invalid_provider_response",
          retryable: false,
          detail: "Objective draft response must not contain tool calls",
        },
      };
    }
    try {
      const safeContent = redactString(result.content);
      return { kind: "draft", draft: parseObjectiveSpecDraft(parseJsonContent(safeContent)), rawContent: safeContent };
    } catch (error) {
      return {
        kind: "fallback",
        signal: {
          type: "deterministic_fallback",
          reason: "invalid_provider_response",
          retryable: false,
          detail: error instanceof Error ? error.message : "Invalid objective draft JSON",
        },
      };
    }
  }
}
