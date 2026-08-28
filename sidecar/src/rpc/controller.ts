import type { z } from "zod";
import {
  BuildCaptureParamsSchema,
  CandidatePreviewParamsSchema,
  HelloParamsSchema,
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
}
