import { z } from "zod";
import { RankedScenarioIdSchema } from "../schemas.js";
import type { ModelToolRegistry } from "./types.js";

const IdentifierSchema = z.string().min(1).max(256);
const DomainSchema = z.enum([
  "rules",
  "identity",
  "skills",
  "gear",
  "tree",
  "actor",
  "config",
  "external",
  "progression",
]);

const InspectBuildArgumentsSchema = z
  .object({
    snapshotId: IdentifierSchema,
    domains: z.array(DomainSchema).max(9).optional(),
  })
  .strict();

const TraceMechanicArgumentsSchema = z.object({
  snapshotId: IdentifierSchema,
  nodeId: IdentifierSchema,
}).strict();

const ListFindingsArgumentsSchema = z.object({
  snapshotId: IdentifierSchema,
  severity: z.enum(["info", "warning", "blocker"]).optional(),
}).strict();

const DescribeModifierArgumentsSchema = z.object({
  snapshotId: IdentifierSchema,
  modifierId: IdentifierSchema,
}).strict();

const DiagnoseBuildArgumentsSchema = z
  .object({
    snapshotId: IdentifierSchema,
    objectiveId: IdentifierSchema,
    scenarioIds: z.array(RankedScenarioIdSchema).min(1).max(4).optional(),
  })
  .strict();

const SearchBuildArgumentsSchema = z
  .object({
    snapshotId: IdentifierSchema,
    objectiveId: IdentifierSchema,
    domains: z.array(DomainSchema).min(1).max(9),
    focus: z.string().min(1).max(2000).optional(),
  })
  .strict();

const RefineSearchArgumentsSchema = z
  .object({
    runId: IdentifierSchema,
    candidateIds: z.array(IdentifierSchema).max(64).optional(),
    domains: z.array(DomainSchema).min(1).max(9).optional(),
    focus: z.string().min(1).max(2000),
  })
  .strict();

const EvaluateCandidateArgumentsSchema = z
  .object({
    candidateId: IdentifierSchema,
    scenarioIds: z.array(RankedScenarioIdSchema).min(1).max(4).optional(),
  })
  .strict();

const ExplainCandidateArgumentsSchema = z
  .object({
    candidateId: IdentifierSchema,
    language: z.string().min(2).max(35).optional(),
    detail: z.enum(["concise", "normal", "detailed"]).default("normal"),
  })
  .strict();

const PlanProgressionArgumentsSchema = z
  .object({
    candidateId: IdentifierSchema,
    milestones: z.number().int().min(2).max(12).default(5),
    budget: z.number().finite().nonnegative().optional(),
    currency: z.string().min(1).max(32).optional(),
  })
  .strict()
  .refine((value) => (value.budget === undefined) === (value.currency === undefined), {
    message: "budget and currency must be supplied together",
  });

export const HIGH_LEVEL_TOOL_SCHEMAS = {
  inspect_build: InspectBuildArgumentsSchema,
  trace_mechanic: TraceMechanicArgumentsSchema,
  list_findings: ListFindingsArgumentsSchema,
  describe_modifier: DescribeModifierArgumentsSchema,
  diagnose_build: DiagnoseBuildArgumentsSchema,
  search_build: SearchBuildArgumentsSchema,
  refine_search: RefineSearchArgumentsSchema,
  evaluate_candidate: EvaluateCandidateArgumentsSchema,
  explain_candidate: ExplainCandidateArgumentsSchema,
  plan_progression: PlanProgressionArgumentsSchema,
} as const;

export type HighLevelToolName = keyof typeof HIGH_LEVEL_TOOL_SCHEMAS;
export type HighLevelToolArguments<TName extends HighLevelToolName> = z.infer<
  (typeof HIGH_LEVEL_TOOL_SCHEMAS)[TName]
>;

const TOOL_DESCRIPTIONS: Record<HighLevelToolName, string> = {
  inspect_build: "Read a normalized build snapshot and its domain graph.",
  trace_mechanic: "Trace one mechanic node through verified Build graph edges.",
  list_findings: "List structured mechanic findings, optionally filtered by severity.",
  describe_modifier: "Describe one projected item modifier and its PoB provenance.",
  diagnose_build: "Diagnose weaknesses against a confirmed objective and scenarios.",
  search_build: "Run deterministic candidate search over selected build domains.",
  refine_search: "Refine an existing deterministic search using a narrower focus.",
  evaluate_candidate: "Evaluate an immutable candidate in requested scenarios.",
  explain_candidate: "Explain verified candidate differences and evidence.",
  plan_progression: "Create dependency-ordered milestones for a verified candidate.",
};

export interface OpenAIFunctionToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: HighLevelToolName;
    readonly description: string;
    readonly strict: true;
    readonly parameters: Record<string, unknown>;
  };
}

function strictProviderSchema(source: unknown): Record<string, unknown> {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    return {};
  }
  const schema = source as Record<string, unknown>;
  if (schema.type === "object") {
    const sourceProperties =
      schema.properties !== null && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};
    const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = Object.fromEntries(
      Object.entries(sourceProperties).map(([name, property]) => {
        const converted = strictProviderSchema(property);
        return [
          name,
          originallyRequired.has(name)
            ? converted
            : { anyOf: [converted, { type: "null" }] },
        ];
      }),
    );
    return {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    };
  }
  if (schema.type === "array") {
    return { type: "array", items: strictProviderSchema(schema.items) };
  }
  if (Array.isArray(schema.anyOf)) {
    return { anyOf: schema.anyOf.map(strictProviderSchema) };
  }
  const output: Record<string, unknown> = {};
  if (typeof schema.type === "string") {
    output.type = schema.type;
  }
  if (Array.isArray(schema.enum)) {
    output.enum = schema.enum;
  }
  return output;
}

export const HIGH_LEVEL_TOOL_NAMES = Object.freeze(
  Object.keys(HIGH_LEVEL_TOOL_SCHEMAS) as HighLevelToolName[],
);

export const HIGH_LEVEL_TOOL_DEFINITIONS: readonly OpenAIFunctionToolDefinition[] = Object.freeze(
  HIGH_LEVEL_TOOL_NAMES.map((name) => ({
    type: "function" as const,
    function: {
      name,
      description: TOOL_DESCRIPTIONS[name],
      strict: true as const,
      parameters: strictProviderSchema(
        HIGH_LEVEL_TOOL_SCHEMAS[name].toJSONSchema({ target: "draft-07" }),
      ),
    },
  })),
);

const RAW_ARGUMENT_LIMIT_BYTES = 64 * 1024;

export class ToolCallValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolCallValidationError";
  }
}

export function isHighLevelToolName(value: string): value is HighLevelToolName {
  return Object.hasOwn(HIGH_LEVEL_TOOL_SCHEMAS, value);
}

export function parseToolArguments<TName extends HighLevelToolName>(
  name: TName,
  rawArguments: string,
): HighLevelToolArguments<TName> {
  if (Buffer.byteLength(rawArguments, "utf8") > RAW_ARGUMENT_LIMIT_BYTES) {
    throw new ToolCallValidationError(`Tool arguments exceed ${RAW_ARGUMENT_LIMIT_BYTES} bytes`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawArguments) as unknown;
  } catch {
    throw new ToolCallValidationError(`Invalid JSON arguments for ${name}`);
  }

  const normalized =
    decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
      ? Object.fromEntries(Object.entries(decoded).filter(([, value]) => value !== null))
      : decoded;
  const parsed = HIGH_LEVEL_TOOL_SCHEMAS[name].safeParse(normalized);
  if (!parsed.success) {
    throw new ToolCallValidationError(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data as HighLevelToolArguments<TName>;
}

export const HIGH_LEVEL_TOOL_REGISTRY: ModelToolRegistry<HighLevelToolName> = Object.freeze({
  definitions: HIGH_LEVEL_TOOL_DEFINITIONS,
  toolChoice: "auto" as const,
  isName: isHighLevelToolName,
  parseArguments: parseToolArguments,
});
