import { PROTOCOL_VERSION } from "../schemas.js";
import {
  RPC_ERROR,
  type RpcError,
  type RpcId,
  type RpcNotification,
  type RpcRequest,
  type RpcSuccess,
} from "../protocol.js";

export type JsonRpcId = RpcId;
export type JsonRpcRequest = RpcRequest;
export type JsonRpcNotification = RpcNotification;
export type JsonRpcSuccess = RpcSuccess;

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcFailure = RpcError;

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const JsonRpcErrorCode = {
  ParseError: RPC_ERROR.PARSE_ERROR,
  InvalidRequest: RPC_ERROR.INVALID_REQUEST,
  MethodNotFound: RPC_ERROR.METHOD_NOT_FOUND,
  InvalidParams: RPC_ERROR.INVALID_PARAMS,
  InternalError: RPC_ERROR.INTERNAL_ERROR,
  AuthenticationFailed: RPC_ERROR.UNAUTHORIZED,
  ProtocolVersionMismatch: RPC_ERROR.PROTOCOL_MISMATCH,
  FrameTooLarge: RPC_ERROR.FRAME_TOO_LARGE,
  DuplicateRequestId: RPC_ERROR.CONFLICT,
  Conflict: RPC_ERROR.CONFLICT,
  RequestTimedOut: -32006,
} as const;

export class JsonRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export function rpcError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
    protocolVersion: PROTOCOL_VERSION,
  };
}

export function rpcSuccess(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return {
    jsonrpc: "2.0",
    id,
    result: result === undefined ? null : result,
    protocolVersion: PROTOCOL_VERSION,
  };
}
