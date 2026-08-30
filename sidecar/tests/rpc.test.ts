import { EMPTY_PROJECTION_FINGERPRINT, emptyModifierProjection } from "./mechanicsFixture.js";
import net, { type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../src/schemas.js";
import {
  JsonRpcErrorCode,
  RpcServer,
  isLoopbackAddress,
  normalizeRpcParams,
  type PlannerController,
  type PlannerControllerContext,
} from "../src/rpc/index.js";

const SESSION_TOKEN = "0123456789abcdef0123456789abcdef";
const servers: RpcServer[] = [];
const sockets: Socket[] = [];

function createController(overrides: Partial<PlannerController> = {}): PlannerController {
  return {
    hello: async () => ({ ok: true }),
    captureBuild: async () => ({ captured: true }),
    analyzeBuild: async () => ({ status: "complete" }),
    startMechanicAnalysis: async () => ({ analysisId: "mechanics-1", status: "running" }),
    mechanicAnalysisStatus: async () => ({ analysisId: "mechanics-1", status: "running" }),
    cancelMechanicAnalysis: async () => ({ analysisId: "mechanics-1", status: "cancelled" }),
    startRun: async () => ({ runId: "run-1" }),
    streamRun: async () => ({ status: "running" }),
    cancelRun: async () => ({ cancelled: true }),
    resumeRun: async () => ({ resumed: true }),
    previewCandidate: async () => ({ candidateId: "candidate-1" }),
    recordTransactionResult: async () => ({ recorded: true }),
    providerStatus: async () => ({ configured: false }),
    configureProvider: async () => ({ configured: true }),
    listProviderModels: async () => ({ models: [] }),
    previewProviderTest: async () => ({ preview: true }),
    testProviderConnection: async () => ({ ok: true }),
    clearProvider: async () => ({ configured: false }),
    previewConsent: async () => ({ preview: true }),
    grantConsent: async () => ({ granted: true }),
    revokeConsent: async () => ({ revoked: true }),
    draftObjective: async () => ({ draft: true }),
    ...overrides,
  };
}

async function startServer(
  controller: PlannerController,
  options: { maxFrameBytes?: number; requestTimeoutMs?: number } = {},
): Promise<{ server: RpcServer; address: AddressInfo }> {
  const server = new RpcServer(controller, {
    sessionToken: SESSION_TOKEN,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  });
  servers.push(server);
  return { server, address: await server.listen() };
}

async function connect(address: AddressInfo): Promise<Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
  sockets.push(socket);
  await once(socket, "connect");
  return socket;
}

function request(id: string | number, method: string, params: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params,
    sessionToken: SESSION_TOKEN,
    protocolVersion: PROTOCOL_VERSION,
  };
}

function collectMessages(socket: Socket, expected: number, timeoutMs = 1_000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Expected ${expected} messages, received ${messages.length}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        messages.push(JSON.parse(line) as unknown);
        if (messages.length === expected) {
          cleanup();
          resolve(messages);
          return;
        }
      }
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
    };
    socket.on("data", onData);
  });
}

async function sendAndCollect(
  socket: Socket,
  frames: ReadonlyArray<string | Record<string, unknown>>,
  expected: number,
): Promise<unknown[]> {
  const result = collectMessages(socket, expected);
  socket.write(
    frames
      .map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame)))
      .map((frame) => `${frame}\n`)
      .join(""),
  );
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function errorCode(value: unknown): number {
  const error = asRecord(asRecord(value).error);
  return error.code as number;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("RpcServer", () => {
  it("notifies exactly once when the first loopback owner connects", async () => {
    const onFirstConnect = vi.fn();
    const server = new RpcServer(createController(), {
      sessionToken: SESSION_TOKEN,
      onFirstConnect,
    });
    servers.push(server);
    const address = await server.listen();
    const first = await connect(address);
    const second = await connect(address);

    expect(server.hasOwnerConnected).toBe(true);
    expect(onFirstConnect).toHaveBeenCalledOnce();
    first.destroy();
    second.destroy();
  });

  it("binds loopback and routes an authenticated hello request", async () => {
    const hello = vi.fn(async () => ({ server: "aipob" }));
    const { address } = await startServer(createController({ hello }));
    expect(address.address).toBe("127.0.0.1");
    const socket = await connect(address);

    const [response] = await sendAndCollect(
      socket,
      [request(1, "hello", { clientName: "PoB", clientVersion: "2.67.2" })],
      1,
    );

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { server: "aipob" },
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(hello).toHaveBeenCalledOnce();
  });

  it("rejects an oversized outbound frame", async () => {
    const hello = vi.fn(async () => ({ payload: "x".repeat(2_000) }));
    const { address } = await startServer(createController({ hello }), { maxFrameBytes: 512 });
    const socket = await connect(address);
    const [response] = await sendAndCollect(
      socket,
      [request(1, "hello", { clientName: "PoB", clientVersion: "1" })],
      1,
    );
    expect(errorCode(response)).toBe(JsonRpcErrorCode.FrameTooLarge);
  });

  it("rejects malformed JSON, bad auth, protocol mismatch, unknown methods, and bad params", async () => {
    const { address } = await startServer(createController());
    const socket = await connect(address);
    const badAuth = request(2, "hello", { clientName: "PoB", clientVersion: "1" });
    badAuth.sessionToken = "x".repeat(32);
    const badVersion = request(3, "hello", { clientName: "PoB", clientVersion: "1" });
    badVersion.protocolVersion = PROTOCOL_VERSION + 1;

    const responses = await sendAndCollect(
      socket,
      [
        "{broken",
        badAuth,
        badVersion,
        request(4, "unknown.method", {}),
        request(5, "hello", { clientName: "PoB" }),
      ],
      5,
    );

    expect(responses.map(errorCode)).toEqual([
      JsonRpcErrorCode.ParseError,
      JsonRpcErrorCode.AuthenticationFailed,
      JsonRpcErrorCode.ProtocolVersionMismatch,
      JsonRpcErrorCode.MethodNotFound,
      JsonRpcErrorCode.InvalidParams,
    ]);
  });

  it("streams progress and completion notifications from run.start", async () => {
    const startRun = vi.fn(async (_params, context: PlannerControllerContext) => {
      context.notify({
        method: "run.progress",
        params: {
          runId: "run-1",
          phase: "search",
          progress: 0.5,
          evaluations: 10,
          frontierSize: 2,
          message: "Searching",
        },
      });
      context.notify({ method: "run.completed", params: { runId: "run-1", candidates: [] } });
      return { runId: "run-1", accepted: true };
    });
    const { address } = await startServer(createController({ startRun }));
    const socket = await connect(address);

    const messages = await sendAndCollect(
      socket,
      [
        request(7, "run.start", {
          snapshotFingerprint: "fingerprint",
          objective: {
            schemaVersion: 4,
            goals: [{ metric: "TotalDPS", direction: "maximize" }],
          },
        }),
      ],
      3,
    );

    expect(messages[0]).toMatchObject({ method: "run.progress", protocolVersion: PROTOCOL_VERSION });
    expect(messages[1]).toMatchObject({ method: "run.completed", protocolVersion: PROTOCOL_VERSION });
    expect(messages[2]).toMatchObject({ id: 7, result: { runId: "run-1", accepted: true } });
  });

  it("routes every non-start planner method through the injected controller", async () => {
    const captureBuild = vi.fn(async () => ({ captured: true }));
    const cancelRun = vi.fn(async () => ({ cancelled: true }));
    const resumeRun = vi.fn(async () => ({ resumed: true }));
    const previewCandidate = vi.fn(async () => ({ previewed: true }));
    const recordTransactionResult = vi.fn(async () => ({ recorded: true }));
    const { address } = await startServer(
      createController({
        captureBuild,
        cancelRun,
        resumeRun,
        previewCandidate,
        recordTransactionResult,
      }),
    );
    const socket = await connect(address);

    const responses = await sendAndCollect(
      socket,
      [
        request(10, "build.capture", {
          snapshot: {
            schemaVersion: 4,
            mechanicProjection: emptyModifierProjection(),
            mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
            xml: "<PathOfBuilding/>",
            fingerprint: "fingerprint",
            engineVersion: "dev",
            dataVersion: "3.29",
            ruleset: "Standard",
          },
        }),
        request(11, "run.cancel", { runId: "run-1" }),
        request(12, "run.resume", { runId: "run-1", decision: "reject" }),
        request(13, "candidate.preview", { runId: "run-1", candidateId: "candidate-1" }),
        request(14, "transaction.result", {
          result: {
            runId: "run-1",
            candidateId: "candidate-1",
            accepted: true,
            applied: true,
            fingerprint: "applied-fingerprint",
            metrics: {},
            scenarioMetrics: { mapping: {}, standardBoss: {}, pinnacle: {}, uber: {} },
          },
        }),
      ],
      5,
    );

    expect(responses.map((response) => asRecord(response).id).sort()).toEqual([10, 11, 12, 13, 14]);
    expect(captureBuild).toHaveBeenCalledOnce();
    expect(cancelRun).toHaveBeenCalledOnce();
    expect(resumeRun).toHaveBeenCalledOnce();
    expect(previewCandidate).toHaveBeenCalledOnce();
    expect(recordTransactionResult).toHaveBeenCalledOnce();
  });

  it("routes connection-test preview and execution through additive RPC methods", async () => {
    const previewProviderTest = vi.fn(async () => ({ consentKey: "bound" }));
    const testProviderConnection = vi.fn(async () => ({ ok: true }));
    const listProviderModels = vi.fn(async () => ({ models: ["test-model"] }));
    const { address } = await startServer(createController({
      previewProviderTest,
      testProviderConnection,
      listProviderModels,
    }));
    const socket = await connect(address);
    const payloadHash = `sha256:${"a".repeat(64)}`;

    const responses = await sendAndCollect(socket, [
      request(20, "provider.test.preview", {
        providerId: "openai", baseUrl: "https://provider.invalid/v1", model: "test-model",
        authMode: "bearer", apiMode: "auto", reasoningMode: "auto",
      }),
      request(21, "provider.test", {
        providerId: "openai",
        baseUrl: "https://provider.invalid/v1",
        model: "test-model",
        authMode: "bearer",
        apiMode: "auto",
        reasoningMode: "auto",
        apiKey: "ephemeral-secret",
        consentKey: "bound",
        payloadHash,
      }),
      request(22, "provider.models.list", {
        providerId: "openai",
        baseUrl: "https://provider.invalid/v1",
        authMode: "bearer",
        apiKey: "ephemeral-secret",
      }),
    ], 3);

    expect(responses.map((response) => asRecord(response).id).sort()).toEqual([20, 21, 22]);
    expect(previewProviderTest).toHaveBeenCalledOnce();
    expect(testProviderConnection).toHaveBeenCalledOnce();
    expect(listProviderModels).toHaveBeenCalledOnce();
  });

  it("requires a request id", async () => {
    const { address } = await startServer(createController());
    const socket = await connect(address);
    const withoutId = request(15, "hello", { clientName: "PoB", clientVersion: "1" });
    delete withoutId.id;

    const [response] = await sendAndCollect(socket, [withoutId], 1);

    expect(asRecord(response).id).toBeNull();
    expect(errorCode(response)).toBe(JsonRpcErrorCode.InvalidRequest);
  });

  it("aborts a controller call at the request deadline", async () => {
    let observedSignal: AbortSignal | undefined;
    const hello = async (_params: unknown, context: PlannerControllerContext): Promise<never> => {
      observedSignal = context.signal;
      return new Promise<never>(() => undefined);
    };
    const { address } = await startServer(createController({ hello }), { requestTimeoutMs: 20 });
    const socket = await connect(address);

    const [response] = await sendAndCollect(
      socket,
      [request(8, "hello", { clientName: "PoB", clientVersion: "1" })],
      1,
    );

    expect(errorCode(response)).toBe(JsonRpcErrorCode.RequestTimedOut);
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects an oversized frame and closes the connection", async () => {
    const { address } = await startServer(createController(), { maxFrameBytes: 256 });
    const socket = await connect(address);
    const closed = once(socket, "close");

    const [response] = await sendAndCollect(socket, ["x".repeat(257)], 1);

    expect(errorCode(response)).toBe(JsonRpcErrorCode.FrameTooLarge);
    await closed;
  });

  it("aborts active request contexts when the client disconnects", async () => {
    let contextSignal: AbortSignal | undefined;
    let contextReadyResolve: (() => void) | undefined;
    const contextReady = new Promise<void>((resolve) => {
      contextReadyResolve = resolve;
    });
    const hello = async (_params: unknown, context: PlannerControllerContext): Promise<never> => {
      contextSignal = context.signal;
      contextReadyResolve?.();
      return new Promise<never>(() => undefined);
    };
    const { address } = await startServer(createController({ hello }));
    const socket = await connect(address);
    socket.write(
      `${JSON.stringify(request(9, "hello", { clientName: "PoB", clientVersion: "1" }))}\n`,
    );
    await contextReady;
    socket.destroy();
    await once(socket, "close");

    await vi.waitFor(() => expect(contextSignal?.aborted).toBe(true));
  });
});

describe("RPC Lua adapter normalization", () => {
  it("canonicalizes empty Lua tables and scenario aliases without mutating input", () => {
    const input = {
      snapshotFingerprint: "fingerprint",
      objective: {
        schemaVersion: 4,
        primaryScenario: "guardian",
        scenarioWeights: { mapping: 0.55, boss: 0.15, guardian: 0.15, uberPinnacle: 0.15 },
        goals: {},
        hardConstraints: {},
        locks: { fields: {} },
      },
    };

    const normalized = asRecord(normalizeRpcParams("run.start", input));
    const objective = asRecord(normalized.objective);
    expect(objective).toMatchObject({
      primaryScenario: "pinnacle",
      scenarioWeights: {
        mapping: 0.55,
        standardBoss: 0.15,
        pinnacle: 0.15,
        uber: 0.15,
      },
      goals: [],
      hardConstraints: [],
      locks: { fields: [] },
    });
    expect(input.objective.primaryScenario).toBe("guardian");
    expect(input.objective.goals).toEqual({});
  });

  it("normalizes only schema-owned snapshot arrays", () => {
    const arbitraryData = {};
    const normalized = asRecord(
      normalizeRpcParams("build.capture", {
        snapshot: {
          contentCatalog: {},
          buildGraph: { nodes: {}, edges: {} },
          buildState: { emptyGameplayObject: arbitraryData },
        },
      }),
    );
    const snapshot = asRecord(normalized.snapshot);

    expect(snapshot.contentCatalog).toEqual([]);
    expect(snapshot.buildGraph).toEqual({ nodes: [], edges: [] });
    expect(asRecord(snapshot.buildState).emptyGameplayObject).toBe(arbitraryData);
  });
});

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.10.20.30", "::1", "::ffff:127.0.0.1"])(
    "accepts %s",
    (address) => expect(isLoopbackAddress(address)).toBe(true),
  );

  it.each([undefined, "0.0.0.0", "192.168.1.1", "::ffff:192.168.1.1", "localhost"])(
    "rejects %s",
    (address) => expect(isLoopbackAddress(address)).toBe(false),
  );
});
