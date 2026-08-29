import type { z } from "zod";
import type { TradeCatalogCancel, TradeCatalogQuery, TradeCatalogResult } from "../schemas.js";
import {
  BuildCaptureParamsSchema,
  CandidatePreviewParamsSchema,
  ConsentGrantParamsSchema,
  ConsentPreviewParamsSchema,
  ConsentRevokeParamsSchema,
  HelloParamsSchema,
  ObjectiveDraftParamsSchema,
  ProviderClearParamsSchema,
  ProviderConfigureParamsSchema,
  ProviderModelsListParamsSchema,
  ProviderTestParamsSchema,
  ProviderTestPreviewParamsSchema,
  ProviderStatusParamsSchema,
  RunCancelParamsSchema,
  RunAwaitingApprovalNotificationSchema,
  RunCompletedNotificationSchema,
  RunFailedNotificationSchema,
  RunProgressNotificationSchema,
  RunResumeParamsSchema,
  RunStartParamsSchema,
  RunStreamParamsSchema,
  TransactionApplyNotificationSchema,
  TransactionResultParamsSchema,
} from "../protocol.js";

export type RpcParams = Record<string, unknown>;

export type HelloParams = z.infer<typeof HelloParamsSchema>;
export type BuildCaptureParams = z.infer<typeof BuildCaptureParamsSchema>;
export type RunStartParams = z.infer<typeof RunStartParamsSchema>;
export type RunCancelParams = z.infer<typeof RunCancelParamsSchema>;
export type RunStreamParams = z.infer<typeof RunStreamParamsSchema>;
export type RunResumeParams = z.infer<typeof RunResumeParamsSchema>;
export type CandidatePreviewParams = z.infer<typeof CandidatePreviewParamsSchema>;
export type TransactionResultParams = z.infer<typeof TransactionResultParamsSchema>;
export type ProviderStatusParams = z.infer<typeof ProviderStatusParamsSchema>;
export type ProviderConfigureParams = z.infer<typeof ProviderConfigureParamsSchema>;
export type ProviderModelsListParams = z.infer<typeof ProviderModelsListParamsSchema>;
export type ProviderTestPreviewParams = z.infer<typeof ProviderTestPreviewParamsSchema>;
export type ProviderTestParams = z.infer<typeof ProviderTestParamsSchema>;
export type ProviderClearParams = z.infer<typeof ProviderClearParamsSchema>;
export type ConsentPreviewParams = z.infer<typeof ConsentPreviewParamsSchema>;
export type ConsentGrantParams = z.infer<typeof ConsentGrantParamsSchema>;
export type ConsentRevokeParams = z.infer<typeof ConsentRevokeParamsSchema>;
export type ObjectiveDraftParams = z.infer<typeof ObjectiveDraftParamsSchema>;

export type RunNotificationMethod =
  | "run.progress"
  | "run.awaitingApproval"
  | "run.completed"
  | "run.failed"
  | "transaction.apply";

export type RunNotification =
  | { method: "run.progress"; params: z.infer<typeof RunProgressNotificationSchema> }
  | { method: "run.awaitingApproval"; params: z.infer<typeof RunAwaitingApprovalNotificationSchema> }
  | { method: "run.completed"; params: z.infer<typeof RunCompletedNotificationSchema> }
  | { method: "run.failed"; params: z.infer<typeof RunFailedNotificationSchema> }
  | { method: "transaction.apply"; params: z.infer<typeof TransactionApplyNotificationSchema> };

export interface PlannerControllerContext {
  readonly requestId: string | number;
  readonly signal: AbortSignal;
  notify(notification: RunNotification): void;
  requestTradeCatalog?(params: TradeCatalogQuery): Promise<TradeCatalogResult>;
  cancelTradeCatalog?(params: TradeCatalogCancel): void;
}

/**
 * Boundary between transport and planner behavior. Implementations own all run
 * state; the RPC layer only supplies authentication, cancellation, deadlines,
 * and a connection-scoped notification sink.
 */
export interface PlannerController {
  hello(params: HelloParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  captureBuild(params: BuildCaptureParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  startRun(params: RunStartParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  streamRun(params: RunStreamParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  cancelRun(params: RunCancelParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  resumeRun(params: RunResumeParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  previewCandidate(params: CandidatePreviewParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  recordTransactionResult(params: TransactionResultParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  providerStatus(params: ProviderStatusParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  configureProvider(params: ProviderConfigureParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  listProviderModels(params: ProviderModelsListParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  previewProviderTest(params: ProviderTestPreviewParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  testProviderConnection(params: ProviderTestParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  clearProvider(params: ProviderClearParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  previewConsent(params: ConsentPreviewParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  grantConsent(params: ConsentGrantParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  revokeConsent(params: ConsentRevokeParams, context: PlannerControllerContext): Promise<unknown> | unknown;
  draftObjective(params: ObjectiveDraftParams, context: PlannerControllerContext): Promise<unknown> | unknown;
}
