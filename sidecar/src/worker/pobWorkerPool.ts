import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import {
  WorkerCancelledError,
  type WorkerEvaluation,
  type WorkerJob,
  type WorkerPool,
  type WorkerPoolStats,
} from "./types.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class WorkerFrameTooLargeError extends RangeError {
  public constructor(readonly actualBytes: number) {
    super(`Worker request frame exceeds ${MAX_FRAME_BYTES} bytes (${actualBytes} bytes)`);
    this.name = "WorkerFrameTooLargeError";
  }
}

export interface WorkerCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface PobWorkerPoolOptions<Result extends WorkerEvaluation = WorkerEvaluation> {
  readonly command: WorkerCommand;
  readonly workerCount: number;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly signal?: AbortSignal;
  readonly parseResult?: (value: unknown) => Result;
}

interface PendingJob<Payload, Result extends WorkerEvaluation> {
  readonly job: WorkerJob<Payload>;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
  readonly attemptedWorkers: Set<number>;
  readonly externalSignal?: AbortSignal;
  retries: number;
  cancelled: boolean;
  abortListener?: () => void;
}

interface Lane<Payload, Result extends WorkerEvaluation> {
  readonly id: number;
  child?: ChildProcess;
  socket?: Socket;
  current?: PendingJob<Payload, Result>;
  ready: boolean;
  generation: number;
}

interface WorkerMessage {
  readonly type?: unknown;
  readonly token?: unknown;
  readonly workerId?: unknown;
  readonly jobId?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Accepts only JSON argv arrays. A shell command string is deliberately invalid. */
export function parseWorkerCommand(value: string): WorkerCommand {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Worker command must be a JSON array of argv strings");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Worker command must be a non-empty JSON array of argv strings");
  }
  const [executable, ...args] = parsed as string[];
  if (!executable?.trim()) throw new Error("Worker executable must not be empty");
  return { executable, args };
}

/**
 * Process-backed worker module. The interface hides spawn, authentication,
 * serial lane scheduling, crash retry, cancellation and shutdown semantics.
 */
export class PobWorkerPool<Payload = unknown, Result extends WorkerEvaluation = WorkerEvaluation>
implements WorkerPool<Payload, Result> {
  readonly #options: PobWorkerPoolOptions<Result>;
  readonly #token = randomBytes(32).toString("hex");
  readonly #lanes: Lane<Payload, Result>[];
  readonly #queue: PendingJob<Payload, Result>[] = [];
  readonly #server: Server;
  readonly #ready: Promise<void>;
  #port = 0;
  #completed = 0;
  #cancelled = 0;
  #closing = false;

  public constructor(options: PobWorkerPoolOptions<Result>) {
    if (!Number.isInteger(options.workerCount) || options.workerCount < 1 || options.workerCount > 8) {
      throw new RangeError("workerCount must be an integer from 1 to 8");
    }
    if (!options.command.executable.trim()) throw new Error("Worker executable must not be empty");
    this.#options = options;
    this.#lanes = Array.from({ length: options.workerCount }, (_, id) => ({ id, ready: false, generation: 0 }));
    this.#server = createServer((socket) => this.#accept(socket));
    this.#ready = this.#start();
  }

  public static async create<Payload = unknown, Result extends WorkerEvaluation = WorkerEvaluation>(
    options: PobWorkerPoolOptions<Result>,
  ): Promise<PobWorkerPool<Payload, Result>> {
    const pool = new PobWorkerPool<Payload, Result>(options);
    try {
      await pool.#ready;
      return pool;
    } catch (error) {
      await pool.close();
      throw error;
    }
  }

  public async evaluate(job: WorkerJob<Payload>, signal?: AbortSignal): Promise<Result> {
    await this.#ready;
    if (this.#closing) throw new Error("Worker pool is closed");
    if (signal?.aborted) throw new WorkerCancelledError();
    serializeFrame({ type: "evaluate", job });
    return new Promise<Result>((resolve, reject) => {
      const pending: PendingJob<Payload, Result> = {
        job,
        resolve,
        reject,
        attemptedWorkers: new Set<number>(),
        retries: 0,
        cancelled: false,
        ...(signal ? { externalSignal: signal } : {}),
      };
      if (signal) {
        const listener = (): void => this.#cancelPending(pending);
        pending.abortListener = listener;
        signal.addEventListener("abort", listener, { once: true });
      }
      this.#queue.push(pending);
      this.#pump();
    });
  }

  public async evaluateBatch(jobs: readonly WorkerJob<Payload>[], signal?: AbortSignal): Promise<readonly Result[]> {
    return Promise.all(jobs.map((job) => this.evaluate(job, signal)));
  }

  public cancel(runId: string): void {
    for (const pending of [...this.#queue]) {
      if (pending.job.runId === runId) this.#cancelPending(pending);
    }
    for (const lane of this.#lanes) {
      if (lane.current?.job.runId === runId) this.#cancelPending(lane.current);
    }
  }

  public stats(): WorkerPoolStats {
    return {
      workerCount: this.#lanes.length,
      queued: this.#queue.length,
      active: this.#lanes.filter((lane) => lane.current !== undefined).length,
      completed: this.#completed,
      cancelled: this.#cancelled,
    };
  }

  public async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    try { await this.#ready; } catch { /* startup already failed */ }
    for (const pending of [...this.#queue]) this.#cancelPending(pending);
    for (const lane of this.#lanes) {
      if (lane.current) this.#cancelPending(lane.current);
      if (!this.#send(lane, { type: "shutdown" })) lane.child?.kill();
    }
    const timeout = this.#options.shutdownTimeoutMs ?? 2_000;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(this.#lanes.map((lane) => waitForExit(lane.child))).then(() => undefined),
        new Promise<void>((resolve) => { shutdownTimer = setTimeout(resolve, timeout); }),
      ]);
    } finally {
      if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);
    }
    for (const lane of this.#lanes) {
      lane.socket?.destroy();
      if (lane.child && lane.child.exitCode === null) lane.child.kill();
    }
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async #start(): Promise<void> {
    if (this.#options.signal?.aborted) throw new WorkerCancelledError("Worker startup cancelled");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", onError);
        const address = this.#server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Worker server did not bind a TCP port"));
          return;
        }
        this.#port = address.port;
        resolve();
      });
    });
    if (this.#options.signal?.aborted) throw new WorkerCancelledError("Worker startup cancelled");
    for (const lane of this.#lanes) this.#spawn(lane);
    const timeout = this.#options.startupTimeoutMs ?? 10_000;
    const startedAt = Date.now();
    while (this.#lanes.some((lane) => !lane.ready)) {
      if (this.#options.signal?.aborted) throw new WorkerCancelledError("Worker startup cancelled");
      if (Date.now() - startedAt >= timeout) {
        throw new Error(`PoB workers did not connect within ${timeout}ms`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  #spawn(lane: Lane<Payload, Result>): void {
    if (this.#closing) return;
    lane.generation += 1;
    lane.ready = false;
    const args = [
      ...this.#options.command.args,
      "--aipob-worker-host", "127.0.0.1",
      "--aipob-worker-port", String(this.#port),
      "--aipob-worker-token", this.#token,
      "--aipob-worker-id", String(lane.id),
    ];
    const child = spawn(this.#options.command.executable, args, {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, ...this.#options.environment },
    });
    lane.child = child;
    const generation = lane.generation;
    child.once("error", (error) => this.#laneFailed(lane, generation, error));
    child.once("exit", (code, signal) => {
      this.#laneFailed(lane, generation, new Error(`PoB worker ${lane.id} exited (${code ?? signal ?? "unknown"})`));
    });
  }

  #accept(socket: Socket): void {
    if (socket.remoteAddress !== "127.0.0.1" && socket.remoteAddress !== "::ffff:127.0.0.1") {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let lane: Lane<Payload, Result> | undefined;
    let socketGeneration = 0;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) {
          if (buffer.length > MAX_FRAME_BYTES) socket.destroy(new Error("Worker frame exceeds maximum size"));
          break;
        }
        if (newline > MAX_FRAME_BYTES) {
          socket.destroy(new Error("Worker frame exceeds maximum size"));
          return;
        }
        const frameBytes = buffer.subarray(0, newline);
        buffer = buffer.slice(newline + 1);
        if (frameBytes.length === 0) continue;
        let message: WorkerMessage;
        try {
          const frame = utf8Decoder.decode(frameBytes).trim();
          if (frame.length === 0) continue;
          message = JSON.parse(frame) as WorkerMessage;
        }
        catch { socket.destroy(new Error("Worker sent invalid JSON")); return; }
        if (!lane) {
          lane = this.#authenticate(socket, message);
          if (!lane) return;
          socketGeneration = lane.generation;
        } else {
          this.#message(lane, message);
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (lane && lane.socket === socket && !this.#closing) {
        this.#laneFailed(lane, socketGeneration, new Error(`PoB worker ${lane.id} connection closed`));
      }
    });
  }

  #authenticate(socket: Socket, message: WorkerMessage): Lane<Payload, Result> | undefined {
    if (message.type !== "hello" || message.token !== this.#token || !Number.isInteger(message.workerId)) {
      socket.destroy();
      return undefined;
    }
    const lane = this.#lanes[message.workerId as number];
    if (!lane || lane.ready || !lane.child || lane.child.exitCode !== null) {
      socket.destroy();
      return undefined;
    }
    lane.socket = socket;
    lane.ready = true;
    this.#pump();
    return lane;
  }

  #message(lane: Lane<Payload, Result>, message: WorkerMessage): void {
    const pending = lane.current;
    if (!pending || message.jobId !== pending.job.id) return;
    if (message.type === "result") {
      try {
        const parsed = this.#options.parseResult
          ? this.#options.parseResult(message.result)
          : message.result as Result;
        if (!parsed || parsed.jobId !== pending.job.id || parsed.candidateId !== pending.job.candidateId) {
          throw new Error("Worker result identifiers do not match the active job");
        }
        this.#complete(lane, pending);
        this.#completed += 1;
        pending.resolve(parsed);
      } catch (error) {
        this.#complete(lane, pending);
        pending.reject(error);
      }
    } else if (message.type === "error") {
      this.#complete(lane, pending);
      pending.reject(new Error(typeof message.error === "string" ? message.error : "PoB worker evaluation failed"));
    }
    this.#pump();
  }

  #complete(lane: Lane<Payload, Result>, pending: PendingJob<Payload, Result>): void {
    if (pending.abortListener) pending.externalSignal?.removeEventListener("abort", pending.abortListener);
    delete pending.abortListener;
    if (lane.current === pending) delete lane.current;
  }

  #cancelPending(pending: PendingJob<Payload, Result>): void {
    if (pending.cancelled) return;
    pending.cancelled = true;
    this.#cancelled += 1;
    const queueIndex = this.#queue.indexOf(pending);
    if (queueIndex >= 0) {
      this.#queue.splice(queueIndex, 1);
      if (pending.abortListener) pending.externalSignal?.removeEventListener("abort", pending.abortListener);
      delete pending.abortListener;
    }
    const lane = this.#lanes.find((entry) => entry.current === pending);
    if (lane) {
      this.#send(lane, { type: "cancel", jobId: pending.job.id });
      this.#complete(lane, pending);
      lane.child?.kill();
    }
    pending.reject(new WorkerCancelledError());
  }

  #laneFailed(lane: Lane<Payload, Result>, generation: number, error: Error): void {
    if (generation !== lane.generation) return;
    lane.generation += 1;
    lane.ready = false;
    lane.socket?.destroy();
    const failedChild = lane.child;
    if (failedChild && failedChild.exitCode === null) failedChild.kill();
    delete lane.socket;
    delete lane.child;
    const pending = lane.current;
    if (pending) {
      delete lane.current;
      if (!pending.cancelled && pending.retries < 1 && this.#lanes.length > 1) {
        pending.retries += 1;
        pending.attemptedWorkers.add(lane.id);
        this.#queue.unshift(pending);
      } else if (!pending.cancelled) {
        if (pending.abortListener) pending.externalSignal?.removeEventListener("abort", pending.abortListener);
        delete pending.abortListener;
        pending.reject(error);
      }
    }
    if (!this.#closing) {
      this.#spawn(lane);
      this.#pump();
    }
  }

  #pump(): void {
    if (this.#closing) return;
    for (const lane of this.#lanes) {
      if (!lane.ready || lane.current) continue;
      const index = this.#queue.findIndex((pending) => !pending.attemptedWorkers.has(lane.id));
      if (index < 0) continue;
      const pending = this.#queue.splice(index, 1)[0];
      if (!pending) continue;
      if (pending.cancelled || pending.externalSignal?.aborted) {
        this.#cancelPending(pending);
        continue;
      }
      pending.attemptedWorkers.add(lane.id);
      lane.current = pending;
      if (!this.#send(lane, { type: "evaluate", job: pending.job })) {
        this.#laneFailed(lane, lane.generation, new Error(`Failed to send job to PoB worker ${lane.id}`));
      }
    }
  }

  #send(lane: Lane<Payload, Result>, value: unknown): boolean {
    if (!lane.socket || lane.socket.destroyed) return false;
    try {
      lane.socket.write(serializeFrame(value));
      return true;
    } catch {
      return false;
    }
  }
}

function serializeFrame(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("Worker frame is not JSON serializable");
  const frame = `${serialized}\n`;
  const bytes = Buffer.byteLength(frame, "utf8");
  if (bytes > MAX_FRAME_BYTES) throw new WorkerFrameTooLargeError(bytes);
  return frame;
}

function waitForExit(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
