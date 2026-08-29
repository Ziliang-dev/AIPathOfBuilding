import { z } from "zod";
import {
  BuildSnapshotSchema,
  CapabilitySchema,
  CandidateSchema,
  ObjectiveSpecDraftSchema,
  ObjectiveSpecSchema,
  PROTOCOL_VERSION,
  ScenarioSpecSchema,
  TradeCatalogCancelSchema,
  TradeCatalogQuerySchema,
  TradeCatalogResultSchema,
  TransactionResultSchema,
} from "./schemas.js";

export const RpcIdSchema = z.union([z.string().min(1), z.number().int()]);
export type RpcId = z.infer<typeof RpcIdSchema>;

export const RpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema,
  method: z.enum([
    "hello",
    "build.capture",
    "run.start",
    "run.stream",
    "run.cancel",
    "run.resume",
    "candidate.preview",
    "transaction.result",
    "provider.status",
    "provider.configure",
    "provider.test.preview",
    "provider.test",
    "provider.clear",
    "consent.preview",
    "consent.grant",
    "consent.revoke",
    "objective.draft",
  ]),
  params: z.unknown(),
  sessionToken: z.string().min(32),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcPeerRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema,
  method: z.literal("trade.catalog.query"),
  params: TradeCatalogQuerySchema,
  sessionToken: z.string().min(32),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type RpcPeerRequest = z.infer<typeof RpcPeerRequestSchema>;

export const RpcPeerNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("trade.catalog.cancel"),
  params: TradeCatalogCancelSchema,
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type RpcPeerNotification = z.infer<typeof RpcPeerNotificationSchema>;

export const RpcSuccessSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema,
  result: z.unknown(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type RpcSuccess = z.infer<typeof RpcSuccessSchema>;

export const RpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export const RpcErrorSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: RpcIdSchema.nullable(),
  error: RpcErrorObjectSchema,
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.enum(["run.progress", "run.awaitingApproval", "run.completed", "run.failed", "transaction.apply"]),
  params: z.unknown(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
});
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const HelloParamsSchema = z.object({
  clientName: z.string().min(1),
  clientVersion: z.string().min(1),
  capabilities: z.array(CapabilitySchema).default([]),
});
export const BuildCaptureParamsSchema = z.object({ snapshot: BuildSnapshotSchema });
export const RunStartParamsSchema = z.object({
  snapshotFingerprint: z.string().min(1),
  objective: ObjectiveSpecSchema,
});
export const RunCancelParamsSchema = z.object({ runId: z.string().min(1) });
export const RunStreamParamsSchema = z.object({ runId: z.string().min(1) });
export const RunResumeParamsSchema = z.union([
  z.discriminatedUnion("decision", [
    z.object({ runId: z.string().min(1), decision: z.literal("apply"), candidateId: z.string().min(1) }),
    z.object({ runId: z.string().min(1), decision: z.literal("reject") }),
  ]),
  z.object({ runId: z.string().min(1), mode: z.literal("checkpoint") }),
]);
export const CandidatePreviewParamsSchema = z.object({ runId: z.string().min(1), candidateId: z.string().min(1) });
export const TransactionResultParamsSchema = z.object({ result: TransactionResultSchema });

export const ProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const ProviderStatusParamsSchema = z.object({ providerId: ProviderIdSchema.optional() });
const ProviderApiKeySchema = z.string().min(1).max(16_384).refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
  message: "API key cannot contain control characters",
});
export const ProviderConfigureParamsSchema = z.object({
  providerId: ProviderIdSchema,
  baseUrl: z.url().max(2_048),
  model: z.string().min(1).max(256),
  apiKey: ProviderApiKeySchema.optional(),
});
export const ProviderTestPreviewParamsSchema = z.object({
  providerId: ProviderIdSchema,
  baseUrl: z.url().max(2_048),
  model: z.string().min(1).max(256),
});
export const ProviderTestParamsSchema = ProviderTestPreviewParamsSchema.extend({
  apiKey: ProviderApiKeySchema.optional(),
  consentKey: z.string().min(1).max(512),
  payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export const ProviderClearParamsSchema = z.object({ providerId: ProviderIdSchema });
export const ConsentPreviewParamsSchema = z.object({
  providerId: ProviderIdSchema,
  snapshotFingerprint: z.string().min(1).optional(),
  dataCategories: z.array(z.enum([
    "objective", "build_snapshot", "metrics", "tool_outputs", "chat_messages",
  ])).max(5).default([]),
});
export const ConsentGrantParamsSchema = z.object({
  providerId: ProviderIdSchema,
  consentKey: z.string().min(1).max(512),
  payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export const ConsentRevokeParamsSchema = z.object({ providerId: ProviderIdSchema });
export const ObjectiveDraftParamsSchema = z.object({
  providerId: ProviderIdSchema,
  message: z.string().min(1).max(8_000),
  currentObjective: ObjectiveSpecDraftSchema.optional(),
  snapshotFingerprint: z.string().min(1).optional(),
});

export const TradeCatalogQueryResultSchema = TradeCatalogResultSchema;

export const RunProgressNotificationSchema = z.object({
  runId: z.string().min(1),
  phase: z.string().min(1),
  progress: z.number().min(0).max(1),
  evaluations: z.number().int().nonnegative(),
  frontierSize: z.number().int().nonnegative(),
  message: z.string(),
});
export const RunAwaitingApprovalNotificationSchema = z.object({
  runId: z.string().min(1),
  candidates: z.array(CandidateSchema),
});
export const RunCompletedNotificationSchema = z.object({ runId: z.string().min(1), candidates: z.array(CandidateSchema) });
export const RunFailedNotificationSchema = z.object({ runId: z.string().min(1), error: z.string().min(1) });
export const TransactionApplyNotificationSchema = z.object({
  runId: z.string().min(1),
  candidateId: z.string().min(1),
  candidate: CandidateSchema,
  scenarios: z.array(ScenarioSpecSchema).length(4).superRefine((scenarios, context) => {
    const required = new Set(["mapping", "standardBoss", "pinnacle", "uber"]);
    for (const [index, scenario] of scenarios.entries()) {
      if (scenario.profile !== "sustainable" || !required.delete(scenario.id)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Transaction scenarios must contain each sustainable ranked scenario exactly once",
        });
      }
    }
    if (required.size > 0) {
      context.addIssue({ code: "custom", message: `Missing transaction scenarios: ${[...required].join(", ")}` });
    }
  }),
});

export const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  PROTOCOL_MISMATCH: -32002,
  FRAME_TOO_LARGE: -32003,
  NOT_FOUND: -32004,
  CONFLICT: -32005,
} as const;
