import { z } from "zod";
import type { AgentToolDispatcher, AgentToolExecutionResult } from "../agent/loop.js";
import { redactForModel } from "../llm/redaction.js";
import type {
  ModelFunctionToolDefinition,
  ModelToolRegistry,
  ParsedToolCall,
} from "../llm/types.js";
import {
  MechanicContextSchema,
  MechanicRelationSchema,
  ScenarioIdSchema,
  type MechanicClaim,
  type MechanicFactBundle,
  type MechanicProof,
} from "../schemas.js";

const IdentifierSchema = z.string().min(1).max(512);
const DomainSchema = z.enum([
  "skills", "gear", "tree", "config", "actor", "offence", "resource", "defence", "condition", "inventory",
]);

const ClaimInputSchema = z.object({
  sourceId: IdentifierSchema,
  relation: MechanicRelationSchema,
  targetId: IdentifierSchema,
  context: MechanicContextSchema,
  scenario: ScenarioIdSchema.optional(),
  statement: z.string().min(1).max(8_000),
  evidenceIds: z.array(IdentifierSchema).max(128).default([]),
}).strict();
export type MechanicClaimInput = z.infer<typeof ClaimInputSchema>;

const ReviewSchema = z.object({
  verdict: z.enum(["complete", "repair"]),
  missingEntityIds: z.array(IdentifierSchema).max(10_000).default([]),
  conflictingClaimIds: z.array(IdentifierSchema).max(10_000).default([]),
  invalidProofIds: z.array(IdentifierSchema).max(10_000).default([]),
  summary: z.string().min(1).max(32_000),
}).strict();
export type MechanicReview = z.infer<typeof ReviewSchema>;

export const MECHANIC_TOOL_SCHEMAS = {
  list_mechanic_entities: z.object({
    context: MechanicContextSchema.optional(),
    domains: z.array(DomainSchema).max(10).optional(),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(100),
  }).strict(),
  inspect_mechanic_entity: z.object({
    entityIds: z.array(IdentifierSchema).min(1).max(100),
  }).strict(),
  submit_mechanic_claims: z.object({
    claims: z.array(ClaimInputSchema).max(10_000),
    complete: z.boolean(),
  }).strict(),
  inspect_mechanic_proofs: z.object({
    claimIds: z.array(IdentifierSchema).max(100).optional(),
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(100),
  }).strict(),
  submit_mechanic_review: ReviewSchema,
} as const;

export type MechanicToolName = keyof typeof MECHANIC_TOOL_SCHEMAS;

const TOOL_DESCRIPTIONS: Record<MechanicToolName, string> = {
  list_mechanic_entities: "Page through the compact manifest of PoB-authored mechanic entities.",
  inspect_mechanic_entity: "Inspect detailed local PoB facts and provenance for selected entities.",
  submit_mechanic_claims: "Submit the typed mechanism claims discovered from inspected local facts.",
  inspect_mechanic_proofs: "Inspect native and counterfactual proofs produced by local PoB workers.",
  submit_mechanic_review: "Submit the final coverage/proof critique and identify required repairs.",
};

function strictProviderSchema(source: unknown): Record<string, unknown> {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
  const schema = source as Record<string, unknown>;
  if (schema.type === "object") {
    const sourceProperties = schema.properties !== null && typeof schema.properties === "object"
      ? schema.properties as Record<string, unknown>
      : {};
    const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : []);
    const properties = Object.fromEntries(Object.entries(sourceProperties).map(([name, property]) => {
      const converted = strictProviderSchema(property);
      return [name, originallyRequired.has(name) ? converted : { anyOf: [converted, { type: "null" }] }];
    }));
    return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  }
  if (schema.type === "array") return { type: "array", items: strictProviderSchema(schema.items) };
  if (Array.isArray(schema.anyOf)) return { anyOf: schema.anyOf.map(strictProviderSchema) };
  const output: Record<string, unknown> = {};
  if (typeof schema.type === "string") output.type = schema.type;
  if (Array.isArray(schema.enum)) output.enum = schema.enum;
  return output;
}

const names = Object.keys(MECHANIC_TOOL_SCHEMAS) as MechanicToolName[];
const definitions: readonly ModelFunctionToolDefinition<MechanicToolName>[] = Object.freeze(names.map((name) => ({
  type: "function" as const,
  function: {
    name,
    description: TOOL_DESCRIPTIONS[name],
    strict: true as const,
    parameters: strictProviderSchema(MECHANIC_TOOL_SCHEMAS[name].toJSONSchema({ target: "draft-07" })),
  },
})));

const RAW_ARGUMENT_LIMIT_BYTES = 512 * 1024;

function isMechanicToolName(value: string): value is MechanicToolName {
  return Object.hasOwn(MECHANIC_TOOL_SCHEMAS, value);
}

function parseArguments(name: MechanicToolName, rawArguments: string): unknown {
  if (Buffer.byteLength(rawArguments, "utf8") > RAW_ARGUMENT_LIMIT_BYTES) {
    throw new Error(`Tool arguments exceed ${RAW_ARGUMENT_LIMIT_BYTES} bytes`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawArguments) as unknown;
  } catch {
    throw new Error(`Invalid JSON arguments for ${name}`);
  }
  const normalized = decoded !== null && typeof decoded === "object" && !Array.isArray(decoded)
    ? Object.fromEntries(Object.entries(decoded).filter(([, value]) => value !== null))
    : decoded;
  const parsed = MECHANIC_TOOL_SCHEMAS[name].safeParse(normalized);
  if (!parsed.success) throw new Error(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export const MECHANIC_TOOL_REGISTRY: ModelToolRegistry<MechanicToolName> = Object.freeze({
  definitions,
  toolChoice: "required" as const,
  isName: isMechanicToolName,
  parseArguments,
});

export interface MechanicToolSession {
  readonly phase: "analyst" | "critic" | "repair";
  readonly facts: MechanicFactBundle;
  readonly proofs: readonly MechanicProof[];
  readonly existingClaims: readonly MechanicClaim[];
  readonly inspectedEntityIds: Set<string>;
  submittedClaims?: readonly MechanicClaimInput[];
  claimsComplete?: boolean;
  review?: MechanicReview;
}

function errorResult(call: ParsedToolCall<MechanicToolName>, error: string): AgentToolExecutionResult<MechanicToolName> {
  return { toolCallId: call.id, name: call.name, ok: false, output: { error } };
}

export class MechanicToolDispatcher implements AgentToolDispatcher<MechanicToolName, MechanicToolSession> {
  async execute(
    call: ParsedToolCall<MechanicToolName>,
    session: MechanicToolSession,
  ): Promise<AgentToolExecutionResult<MechanicToolName>> {
    const parsed = MECHANIC_TOOL_SCHEMAS[call.name].safeParse(call.arguments);
    if (!parsed.success) return errorResult(call, "invalid_arguments");
    const entityById = new Map(session.facts.entities.map((entity) => [entity.id, entity]));
    let output: unknown;
    switch (call.name) {
      case "list_mechanic_entities": {
        const args = MECHANIC_TOOL_SCHEMAS.list_mechanic_entities.parse(call.arguments);
        const domains = args.domains === undefined ? undefined : new Set(args.domains);
        const filtered = session.facts.entities.filter((entity) =>
          (args.context === undefined || entity.context === args.context)
          && (domains === undefined || domains.has(entity.domain)));
        const page = filtered.slice(args.cursor, args.cursor + args.limit);
        output = {
          total: filtered.length,
          cursor: args.cursor,
          nextCursor: args.cursor + page.length < filtered.length ? args.cursor + page.length : undefined,
          entities: page.map(({ id, context, domain, kind, name, active, fingerprint }) => ({
            id, context, domain, kind, name, active, fingerprint,
          })),
        };
        break;
      }
      case "inspect_mechanic_entity": {
        const args = MECHANIC_TOOL_SCHEMAS.inspect_mechanic_entity.parse(call.arguments);
        const missing = args.entityIds.filter((id) => !entityById.has(id));
        if (missing.length > 0) return errorResult(call, `unknown_entities:${missing.join(",")}`);
        for (const id of args.entityIds) session.inspectedEntityIds.add(id);
        output = args.entityIds.map((id) => entityById.get(id));
        break;
      }
      case "submit_mechanic_claims": {
        if (session.phase === "critic") return errorResult(call, "tool_not_allowed_in_critic_phase");
        const args = MECHANIC_TOOL_SCHEMAS.submit_mechanic_claims.parse(call.arguments);
        const unknown = args.claims.flatMap((claim) => [claim.sourceId, claim.targetId])
          .filter((id) => !entityById.has(id));
        if (unknown.length > 0) return errorResult(call, `unknown_entities:${[...new Set(unknown)].join(",")}`);
        const invalidContext = args.claims.find((claim) =>
          entityById.get(claim.sourceId)?.context !== claim.context
          || entityById.get(claim.targetId)?.context !== claim.context);
        if (invalidContext !== undefined) return errorResult(call, "claim_context_mismatch");
        if (args.claims.some((claim) => claim.sourceId === claim.targetId)) return errorResult(call, "self_relation_forbidden");
        const knownEvidence = new Set(session.facts.entities.flatMap((entity) => [
          entity.id,
          entity.fingerprint,
          ...entity.provenance.flatMap(({ sourceId, fingerprint, evidence }) => [sourceId, fingerprint, ...evidence]),
        ]));
        const unknownEvidence = args.claims.flatMap(({ evidenceIds }) => evidenceIds)
          .filter((id) => !knownEvidence.has(id));
        if (unknownEvidence.length > 0) {
          return errorResult(call, `unknown_evidence:${[...new Set(unknownEvidence)].join(",")}`);
        }
        session.submittedClaims = args.claims;
        session.claimsComplete = args.complete;
        output = { accepted: args.claims.length, complete: args.complete };
        break;
      }
      case "inspect_mechanic_proofs": {
        const args = MECHANIC_TOOL_SCHEMAS.inspect_mechanic_proofs.parse(call.arguments);
        const requested = args.claimIds === undefined ? undefined : new Set(args.claimIds);
        const filtered = session.proofs.filter((proof) => requested === undefined || requested.has(proof.claimId));
        const page = filtered.slice(args.cursor, args.cursor + args.limit);
        output = {
          total: filtered.length,
          cursor: args.cursor,
          nextCursor: args.cursor + page.length < filtered.length ? args.cursor + page.length : undefined,
          proofs: page,
        };
        break;
      }
      case "submit_mechanic_review": {
        if (session.phase !== "critic") return errorResult(call, "tool_only_allowed_in_critic_phase");
        const review = ReviewSchema.parse(call.arguments);
        const knownClaims = new Set(session.existingClaims.map(({ id }) => id));
        const knownProofs = new Set(session.proofs.map(({ id }) => id));
        if (review.missingEntityIds.some((id) => !entityById.has(id))) return errorResult(call, "review_unknown_entity");
        if (review.conflictingClaimIds.some((id) => !knownClaims.has(id))) return errorResult(call, "review_unknown_claim");
        if (review.invalidProofIds.some((id) => !knownProofs.has(id))) return errorResult(call, "review_unknown_proof");
        session.review = review;
        output = { accepted: true, verdict: review.verdict };
        break;
      }
    }
    return { toolCallId: call.id, name: call.name, ok: true, output: redactForModel(output) };
  }
}
