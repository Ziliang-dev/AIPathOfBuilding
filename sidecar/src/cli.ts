import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseArgs, type SidecarConfig } from "./config.js";
import { DefaultPlannerController, type WorkerPoolFactory } from "./plannerController.js";
import { RpcServer } from "./rpc/index.js";
import { MetricSetSchema, PROTOCOL_VERSION } from "./schemas.js";
import { WinCredClient } from "./credentials/index.js";
import {
  ConsentManager,
  ProviderModelAdapterFactory,
  ProviderProfileService,
  SqliteProviderStore,
} from "./provider/index.js";
import { createPlannerStore } from "./storage/index.js";
import {
  PobWorkerPool,
  NativeProbeWorkerPool,
  type PobWorkerEvaluatePayload,
  type WorkerCommand,
  type WorkerEvaluation,
} from "./worker/index.js";
import { createSqliteSaver } from "./workflow/index.js";

const WorkerEvaluationSchema = z.object({
  jobId: z.string().min(1),
  candidateId: z.string().min(1),
  operation: z.enum(["evaluate", "probe"]).optional(),
  metricsByScenario: z.record(z.string(), MetricSetSchema).default({}),
  diagnostics: z.array(z.string()).optional(),
  candidateFingerprint: z.string().optional(),
  nativeProbeFingerprint: z.string().optional(),
  evidenceFingerprint: z.string().optional(),
  nativeLinkProbe: z.unknown().optional(),
  nativeEvidence: z.unknown().optional(),
  nativeEvidenceByScenario: z.unknown().optional(),
}).passthrough();

interface RunningApplication {
  readonly server: RpcServer;
  readonly controller: DefaultPlannerController;
  readonly closeWorkerPool: () => Promise<void>;
  readonly closeStore: () => void;
  readonly readyFile?: string;
  shutdown(exitCode?: number): Promise<void>;
}

async function main(): Promise<void> {
  const config = parseArgs(process.argv.slice(2));
  const application = await startApplication(config);
  const close = async (exitCode: number): Promise<void> => {
    await application.shutdown(exitCode);
  };
  process.once("SIGINT", () => void close(0));
  process.once("SIGTERM", () => void close(0));
}

export async function startApplication(config: SidecarConfig): Promise<RunningApplication> {
  await mkdir(config.dataDir, { recursive: true });
  const store = await createPlannerStore(config.dataDir, warn);
  const pruned = store.prune();
  if (pruned.cacheRows > 0 || pruned.runRows > 0) {
    warn(`Pruned ${pruned.cacheRows} cache rows and ${pruned.runRows} expired runs`);
  }
  const saver = await createSqliteSaver({
    connectionString: join(config.dataDir, "checkpoints.sqlite"),
    onWarning: (message, error) => warn(`${message}: ${errorText(error)}`),
  });
  const worker = processWorkerFactory(config);
  const provider = createProviderRuntime(config);
  const controller = new DefaultPlannerController({
    store,
    checkpointer: saver.checkpointer,
    ...(worker.factory === undefined ? {} : { workerPoolFactory: worker.factory }),
    ...(provider === undefined ? {} : {
      providerService: provider.service,
      modelAdapterFactory: provider.factory,
    }),
  });
  let closing = false;
  let ownerConnectTimer: NodeJS.Timeout | undefined;
  let server: RpcServer;
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    if (ownerConnectTimer !== undefined) clearTimeout(ownerConnectTimer);
    await server.close();
    await controller.close();
    await worker.close();
    provider?.close();
    saver.close();
    store.close();
    if (config.readyFile !== undefined) await removeOwnReadyFile(config.readyFile);
    process.exitCode = exitCode;
  };
  server = new RpcServer(controller, {
    port: config.port,
    sessionToken: config.sessionToken,
    maxFrameBytes: config.maxFrameBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    onFirstConnect: () => {
      if (ownerConnectTimer !== undefined) clearTimeout(ownerConnectTimer);
      ownerConnectTimer = undefined;
    },
    onLastDisconnect: () => void shutdown(0),
  });
  try {
    const address = await server.listen();
    if (config.readyFile !== undefined) {
      await writeReadyFile(config.readyFile, address.port);
      if (!server.hasOwnerConnected) {
        ownerConnectTimer = setTimeout(() => {
          warn(`No owner connected within ${config.ownerConnectTimeoutMs} ms; shutting down`);
          void shutdown(1);
        }, config.ownerConnectTimeoutMs);
        ownerConnectTimer.unref();
      }
    }
    return {
      server,
      controller,
      closeWorkerPool: worker.close,
      closeStore: () => store.close(),
      shutdown,
      ...(config.readyFile === undefined ? {} : { readyFile: config.readyFile }),
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([server.close(), controller.close(), worker.close()]);
    for (const result of cleanup) {
      if (result.status === "rejected") warn(`Startup cleanup failed: ${errorText(result.reason)}`);
    }
    try { saver.close(); } catch (closeError) { warn(`Checkpoint cleanup failed: ${errorText(closeError)}`); }
    try { store.close(); } catch (closeError) { warn(`Store cleanup failed: ${errorText(closeError)}`); }
    try { provider?.close(); } catch (closeError) { warn(`Provider store cleanup failed: ${errorText(closeError)}`); }
    throw error;
  }
}

function createProviderRuntime(config: SidecarConfig): {
  service: ProviderProfileService;
  factory: ProviderModelAdapterFactory;
  close(): void;
} | undefined {
  if (config.credentialHelper === undefined) return undefined;
  if (!existsSync(config.credentialHelper)) {
    warn(`Credential helper unavailable: ${config.credentialHelper}`);
    return undefined;
  }
  try {
    const persistence = new SqliteProviderStore(join(config.dataDir, "provider.sqlite"));
    const consent = new ConsentManager(persistence.consentRecords);
    const credentials = new WinCredClient({ helperPath: config.credentialHelper });
    const service = new ProviderProfileService({ profiles: persistence, credentials, consent });
    return {
      service,
      factory: new ProviderModelAdapterFactory({ service }),
      close: () => persistence.close(),
    };
  } catch (error) {
    warn(`Provider configuration unavailable: ${errorText(error)}`);
    return undefined;
  }
}

function processWorkerFactory(config: SidecarConfig): {
  factory?: WorkerPoolFactory;
  close: () => Promise<void>;
} {
  const command = workerCommand(config);
  if (command === undefined) return { close: async () => undefined };
  const factory: WorkerPoolFactory = async (_snapshot, signal) => {
    const pool = await PobWorkerPool.create<PobWorkerEvaluatePayload, WorkerEvaluation>({
      command,
      workerCount: config.workerCount,
      startupTimeoutMs: 120_000,
      shutdownTimeoutMs: 10_000,
      signal,
      parseResult: (value): WorkerEvaluation => {
        return WorkerEvaluationSchema.parse(value) as WorkerEvaluation;
      },
    });
    return new NativeProbeWorkerPool(pool);
  };
  return {
    factory,
    close: async () => undefined,
  };
}

function workerCommand(config: SidecarConfig): WorkerCommand | undefined {
  if (config.pobExecutable !== undefined && config.workerScript !== undefined) {
    return { executable: config.pobExecutable, args: [config.workerScript] };
  }
  if (config.workerCommand !== undefined) {
    const [executable, ...args] = config.workerCommand;
    if (executable !== undefined) return { executable, args };
  }
  return undefined;
}

async function writeReadyFile(path: string, port: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    host: "127.0.0.1",
    port,
    pid: process.pid,
  })}\n`;
  await writeFile(temporary, payload, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new Error(`Unable to publish ready file ${path}: ${errorText(error)}`);
  }
}

async function removeOwnReadyFile(path: string): Promise<void> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    if (value.pid === process.pid) await rm(path, { force: true });
  } catch {
    // Missing or replaced ready files belong to no cleanup action.
  }
}

function warn(message: string): void {
  process.stderr.write(`[aipob-sidecar] ${message}\n`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main().catch((error) => {
  warn(errorText(error));
  process.exitCode = 1;
});
