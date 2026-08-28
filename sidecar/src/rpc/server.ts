import net, { type AddressInfo, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import type { PlannerController } from "./controller.js";
import {
  JsonRpcErrorCode,
  rpcError,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./json-rpc.js";
import { RpcRouter, type RpcRouterOptions } from "./router.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface RpcServerOptions extends RpcRouterOptions {
  port?: number;
  maxFrameBytes?: number;
  onFirstConnect?: () => void;
  onLastDisconnect?: () => void;
}

function serialize(message: JsonRpcResponse | JsonRpcNotification): string {
  return `${JSON.stringify(message)}\n`;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const normalized = address.toLowerCase();
  if (normalized === "::1") {
    return true;
  }
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  const firstOctet = Number.parseInt(ipv4.split(".", 1)[0] ?? "", 10);
  return Number.isInteger(firstOctet) && firstOctet === 127;
}

export class RpcServer {
  private readonly server: net.Server;
  private readonly router: RpcRouter;
  private readonly port: number;
  private readonly maxFrameBytes: number;
  private readonly sockets = new Set<Socket>();
  private readonly onFirstConnect: (() => void) | undefined;
  private readonly onLastDisconnect: (() => void) | undefined;
  private ownerConnected = false;
  private ownerDisconnectNotified = false;

  constructor(controller: PlannerController, options: RpcServerOptions) {
    this.port = options.port ?? 0;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    this.onFirstConnect = options.onFirstConnect;
    this.onLastDisconnect = options.onLastDisconnect;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
      throw new Error("port must be an integer between 0 and 65535");
    }
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1) {
      throw new Error("maxFrameBytes must be a positive integer");
    }
    this.router = new RpcRouter(controller, options);
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<AddressInfo> {
    if (this.server.listening) {
      const current = this.server.address();
      if (current !== null && typeof current !== "string") {
        return current;
      }
      throw new Error("RPC server has an invalid address");
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen({ host: DEFAULT_HOST, port: this.port, exclusive: true }, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("RPC server did not bind a TCP address");
    }
    return address;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  get hasOwnerConnected(): boolean {
    return this.ownerConnected;
  }

  private accept(socket: Socket): void {
    if (!isLoopbackAddress(socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    if (!this.ownerConnected) {
      this.ownerConnected = true;
      this.onFirstConnect?.();
    }
    const connectionAbort = new AbortController();
    let buffered = Buffer.alloc(0);
    const activeRequestIds = new Set<string>();

    const send = (message: JsonRpcResponse | JsonRpcNotification): void => {
      if (!socket.destroyed && socket.writable) {
        const frame = Buffer.from(serialize(message), "utf8");
        if (frame.length > this.maxFrameBytes) {
          const errorFrame = Buffer.from(serialize(rpcError(null, JsonRpcErrorCode.FrameTooLarge, "Outbound frame exceeds maximum size")), "utf8");
          if (errorFrame.length <= this.maxFrameBytes && socket.writableLength + errorFrame.length <= this.maxFrameBytes) {
            socket.end(errorFrame);
          } else {
            socket.destroy(new Error("Outbound RPC frame exceeds maximum size"));
          }
          return;
        }
        if (socket.writableLength + frame.length > this.maxFrameBytes) {
          socket.destroy(new Error("Outbound RPC backpressure limit exceeded"));
          return;
        }
        socket.write(frame);
      }
    };

    const closeConnection = (): void => {
      connectionAbort.abort(new Error("Connection closed"));
      this.sockets.delete(socket);
      if (this.ownerConnected && this.sockets.size === 0 && !this.ownerDisconnectNotified) {
        this.ownerDisconnectNotified = true;
        queueMicrotask(() => this.onLastDisconnect?.());
      }
    };

    socket.once("close", closeConnection);
    socket.once("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(0x0a);
        if (newline === -1) {
          if (buffered.length > this.maxFrameBytes) {
            send(
              rpcError(
                null,
                JsonRpcErrorCode.FrameTooLarge,
                `Frame exceeds ${this.maxFrameBytes} bytes`,
              ),
            );
            socket.end();
          }
          return;
        }
        if (newline > this.maxFrameBytes) {
          send(
            rpcError(
              null,
              JsonRpcErrorCode.FrameTooLarge,
              `Frame exceeds ${this.maxFrameBytes} bytes`,
            ),
          );
          socket.end();
          return;
        }

        let frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        if (frame.at(-1) === 0x0d) {
          frame = frame.subarray(0, -1);
        }
        if (frame.length === 0) {
          send(rpcError(null, JsonRpcErrorCode.ParseError, "Empty frame"));
          continue;
        }
        this.processFrame(frame, connectionAbort.signal, activeRequestIds, send);
      }
    });
  }

  private processFrame(
    frame: Buffer,
    connectionSignal: AbortSignal,
    activeRequestIds: Set<string>,
    send: (message: JsonRpcResponse | JsonRpcNotification) => void,
  ): void {
    let value: unknown;
    try {
      value = JSON.parse(utf8Decoder.decode(frame));
    } catch {
      send(rpcError(null, JsonRpcErrorCode.ParseError, "Malformed JSON or UTF-8"));
      return;
    }

    const rawId =
      typeof value === "object" && value !== null && "id" in value
        ? (value as { id?: unknown }).id
        : undefined;
    const idKey =
      typeof rawId === "string"
        ? `s:${rawId}`
        : typeof rawId === "number" && Number.isFinite(rawId)
          ? `n:${rawId}`
          : undefined;
    if (idKey !== undefined && activeRequestIds.has(idKey)) {
      send(
        rpcError(
          rawId as string | number,
          JsonRpcErrorCode.DuplicateRequestId,
          "Request id is already active on this connection",
        ),
      );
      return;
    }
    if (idKey !== undefined) {
      activeRequestIds.add(idKey);
    }

    void this.router
      .dispatch(value, {
        signal: connectionSignal,
        sendNotification: send,
      })
      .then(send)
      .finally(() => {
        if (idKey !== undefined) {
          activeRequestIds.delete(idKey);
        }
      });
  }
}
