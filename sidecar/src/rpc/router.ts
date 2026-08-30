import type { ZodType } from "zod";
import {
  BuildAnalyzeParamsSchema,
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
  RpcRequestSchema,
  RunCancelParamsSchema,
  RunResumeParamsSchema,
  RunStartParamsSchema,
  RunStreamParamsSchema,
  TransactionResultParamsSchema,
  type RpcRequest,
} from "../protocol.js";
import { PROTOCOL_VERSION } from "../schemas.js";
import type { TradeCatalogCancel, TradeCatalogQuery, TradeCatalogResult } from "../schemas.js";
import type {
  PlannerController,
  PlannerControllerContext,
  RunNotification,
} from "./controller.js";
import {
  JsonRpcError,
  JsonRpcErrorCode,
  rpcError,
  rpcSuccess,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./json-rpc.js";
import { normalizeRpcParams } from "./normalize.js";

export interface RpcRouterOptions {
  sessionToken: string;
  protocolVersion?: number;
  requestTimeoutMs?: number;
}

export interface RpcDispatchContext {
  readonly signal: AbortSignal;
  sendNotification(notification: JsonRpcNotification): void;
  requestTradeCatalog(params: TradeCatalogQuery): Promise<TradeCatalogResult>;
  cancelTradeCatalog(params: TradeCatalogCancel): void;
}

type ControllerMethod<T = unknown> = (
  params: T,
  context: PlannerControllerContext,
) => Promise<unknown> | unknown;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdFrom(value: unknown): JsonRpcId | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  return typeof id === "string" || (typeof id === "number" && Number.isFinite(id))
    ? id
    : null;
}

const SUPPORTED_METHODS = new Set([
  "hello",
  "build.capture",
  "build.analyze",
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
  "provider.models.list",
  "provider.clear",
  "consent.preview",
  "consent.grant",
  "consent.revoke",
  "objective.draft",
]);

function parseRequest(
  value: unknown,
  expectedSessionToken: string,
  expectedProtocolVersion: number,
): RpcRequest {
  if (!isRecord(value)) {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidRequest, "Request must be an object");
  }
  if (value.jsonrpc !== "2.0") {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidRequest, 'jsonrpc must be "2.0"');
  }
  const id = value.id;
  if (
    !(
      typeof id === "string" ||
      (typeof id === "number" && Number.isFinite(id))
    )
  ) {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidRequest, "A string or numeric request id is required");
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidRequest, "method must be a non-empty string");
  }
  if (!SUPPORTED_METHODS.has(value.method)) {
    throw new JsonRpcError(JsonRpcErrorCode.MethodNotFound, `Unknown method: ${value.method}`);
  }
  if (!isRecord(value.params)) {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "params must be an object");
  }
  if (!Number.isSafeInteger(value.protocolVersion)) {
    throw new JsonRpcError(JsonRpcErrorCode.InvalidRequest, "protocolVersion must be an integer");
  }
  if (typeof value.sessionToken !== "string" || value.sessionToken.length === 0) {
    throw new JsonRpcError(JsonRpcErrorCode.AuthenticationFailed, "Missing session token");
  }
  if (value.sessionToken !== expectedSessionToken) {
    throw new JsonRpcError(JsonRpcErrorCode.AuthenticationFailed, "Invalid session token");
  }
  if (value.protocolVersion !== expectedProtocolVersion) {
    throw new JsonRpcError(
      JsonRpcErrorCode.ProtocolVersionMismatch,
      "Unsupported protocol version",
      { expected: expectedProtocolVersion, received: value.protocolVersion },
    );
  }

  const parsed = RpcRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new JsonRpcError(
      JsonRpcErrorCode.InvalidRequest,
      "Request does not match the protocol schema",
      parsed.error.flatten(),
    );
  }
  return parsed.data;
}

export class RpcRouter {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly requestTimeoutMs: number;
  private readonly sessionToken: string;

  constructor(
    private readonly controller: PlannerController,
    options: RpcRouterOptions,
  ) {
    if (options.sessionToken.length < 32) {
      throw new Error("sessionToken must contain at least 32 characters");
    }
    this.sessionToken = options.sessionToken;
    if (options.protocolVersion !== undefined && options.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Only protocol version ${PROTOCOL_VERSION} is supported`);
    }
    this.protocolVersion = PROTOCOL_VERSION;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.protocolVersion) || this.protocolVersion < 1) {
      throw new Error("protocolVersion must be a positive integer");
    }
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("requestTimeoutMs must be positive");
    }
  }

  async dispatch(value: unknown, dispatchContext: RpcDispatchContext): Promise<JsonRpcResponse> {
    const responseId = requestIdFrom(value);
    let request: RpcRequest;
    try {
      request = parseRequest(value, this.sessionToken, this.protocolVersion);
    } catch (error) {
      return this.failure(responseId, error);
    }

    let resolved: { method: ControllerMethod; params: unknown };
    try {
      resolved = this.resolveMethod(request);
    } catch (error) {
      return this.failure(request.id, error);
    }

    const deadline = new AbortController();
    const signal = AbortSignal.any([dispatchContext.signal, deadline.signal]);
    const timeout = setTimeout(() => deadline.abort(new Error("Request timed out")), this.requestTimeoutMs);
    timeout.unref();

    const controllerContext: PlannerControllerContext = {
      requestId: request.id,
      signal,
      notify: (notification: RunNotification): void => {
        if (signal.aborted) {
          return;
        }
        dispatchContext.sendNotification({
          jsonrpc: "2.0",
          method: notification.method,
          params: notification.params,
          protocolVersion: this.protocolVersion,
        });
      },
      requestTradeCatalog: dispatchContext.requestTradeCatalog,
      cancelTradeCatalog: dispatchContext.cancelTradeCatalog,
    };

    try {
      const result = await Promise.race([
        Promise.resolve(resolved.method(resolved.params, controllerContext)),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("Request aborted")),
            { once: true },
          );
        }),
      ]);
      return rpcSuccess(request.id, result);
    } catch (error) {
      if (deadline.signal.aborted) {
        return rpcError(
          request.id,
          JsonRpcErrorCode.RequestTimedOut,
          `Request exceeded ${this.requestTimeoutMs} ms`,
        );
      }
      if (dispatchContext.signal.aborted) {
        return rpcError(request.id, JsonRpcErrorCode.InternalError, "Connection closed");
      }
      return this.failure(request.id, error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveMethod(request: RpcRequest): { method: ControllerMethod; params: unknown } {
    const normalizedParams = normalizeRpcParams(request.method, request.params);
    const parseParams = <T>(schema: ZodType<T>): T => {
      const parsed = schema.safeParse(normalizedParams);
      if (!parsed.success) {
        throw new JsonRpcError(
          JsonRpcErrorCode.InvalidParams,
          `Invalid params for ${request.method}`,
          parsed.error.flatten(),
        );
      }
      return parsed.data;
    };

    switch (request.method) {
      case "hello":
        return this.bind(this.controller.hello, parseParams(HelloParamsSchema));
      case "build.capture":
        return this.bind(this.controller.captureBuild, parseParams(BuildCaptureParamsSchema));
      case "build.analyze":
        return this.bind(this.controller.analyzeBuild, parseParams(BuildAnalyzeParamsSchema));
      case "run.start":
        return this.bind(this.controller.startRun, parseParams(RunStartParamsSchema));
      case "run.stream":
        return this.bind(this.controller.streamRun, parseParams(RunStreamParamsSchema));
      case "run.cancel":
        return this.bind(this.controller.cancelRun, parseParams(RunCancelParamsSchema));
      case "run.resume":
        return this.bind(this.controller.resumeRun, parseParams(RunResumeParamsSchema));
      case "candidate.preview":
        return this.bind(this.controller.previewCandidate, parseParams(CandidatePreviewParamsSchema));
      case "transaction.result":
        return this.bind(
          this.controller.recordTransactionResult,
          parseParams(TransactionResultParamsSchema),
        );
      case "provider.status":
        return this.bind(this.controller.providerStatus, parseParams(ProviderStatusParamsSchema));
      case "provider.configure":
        return this.bind(this.controller.configureProvider, parseParams(ProviderConfigureParamsSchema));
      case "provider.models.list":
        return this.bind(this.controller.listProviderModels, parseParams(ProviderModelsListParamsSchema));
      case "provider.test.preview":
        return this.bind(this.controller.previewProviderTest, parseParams(ProviderTestPreviewParamsSchema));
      case "provider.test":
        return this.bind(this.controller.testProviderConnection, parseParams(ProviderTestParamsSchema));
      case "provider.clear":
        return this.bind(this.controller.clearProvider, parseParams(ProviderClearParamsSchema));
      case "consent.preview":
        return this.bind(this.controller.previewConsent, parseParams(ConsentPreviewParamsSchema));
      case "consent.grant":
        return this.bind(this.controller.grantConsent, parseParams(ConsentGrantParamsSchema));
      case "consent.revoke":
        return this.bind(this.controller.revokeConsent, parseParams(ConsentRevokeParamsSchema));
      case "objective.draft":
        return this.bind(this.controller.draftObjective, parseParams(ObjectiveDraftParamsSchema));
    }
  }

  private bind<T>(method: ControllerMethod<T>, params: T): { method: ControllerMethod; params: unknown } {
    const bound: ControllerMethod = (value, context) =>
      method.call(this.controller, value as T, context);
    return { method: bound, params };
  }

  private failure(id: JsonRpcId | null, error: unknown): JsonRpcResponse {
    if (error instanceof JsonRpcError) {
      return rpcError(id, error.code, error.message, error.data);
    }
    const message = error instanceof Error ? error.message : "Internal error";
    return rpcError(id, JsonRpcErrorCode.InternalError, message);
  }
}
