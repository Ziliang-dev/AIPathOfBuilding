import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { CredentialStore } from "./types.js";

export type WinCredOperation = "get" | "has" | "set" | "delete";

export interface WinCredRequest {
  readonly op: WinCredOperation;
  readonly target: string;
  readonly secret?: string;
}

export interface WinCredResponse {
  readonly ok: boolean;
  readonly found?: boolean;
  readonly secret?: string;
  readonly error?: string;
}

export interface WinCredRunner {
  run(request: WinCredRequest): Promise<WinCredResponse>;
}

export interface WinCredClientOptions {
  /** Absolute path to the native helper. Never pass secrets as arguments. */
  readonly helperPath: string;
  readonly timeoutMs?: number;
  readonly runner?: WinCredRunner;
}

function parseResponse(value: unknown): WinCredResponse {
  if (typeof value !== "object" || value === null) throw new Error("Credential helper returned non-object JSON");
  const response = value as Record<string, unknown>;
  if (typeof response.ok !== "boolean") throw new Error("Credential helper response missing ok");
  if (response.found !== undefined && typeof response.found !== "boolean") {
    throw new Error("Credential helper response has invalid found");
  }
  if (response.secret !== undefined && typeof response.secret !== "string") {
    throw new Error("Credential helper response has invalid secret");
  }
  if (response.error !== undefined && typeof response.error !== "string") {
    throw new Error("Credential helper response has invalid error");
  }
  return response as unknown as WinCredResponse;
}

const LLM_CREDENTIAL_TARGET = /^AIPathOfBuilding\/LLM\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertLLMCredentialTarget(target: string): void {
  if (!LLM_CREDENTIAL_TARGET.test(target)) {
    throw new Error("Credential target is outside the AIPathOfBuilding LLM namespace");
  }
}

class SpawnWinCredRunner implements WinCredRunner {
  readonly #helperPath: string;
  readonly #timeoutMs: number;

  constructor(helperPath: string, timeoutMs: number) {
    this.#helperPath = helperPath;
    this.#timeoutMs = timeoutMs;
  }

  async run(request: WinCredRequest): Promise<WinCredResponse> {
    const child = spawn(this.#helperPath, [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      shell: false,
    });
    return await readOneResponse(child, request, this.#timeoutMs);
  }
}

async function readOneResponse(
  child: ChildProcessByStdio<Writable, Readable, null>,
  request: WinCredRequest,
  timeoutMs: number,
): Promise<WinCredResponse> {
  const lineReader = createInterface({ input: child.stdout });
  const responsePromise = new Promise<WinCredResponse>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("Credential helper timed out")));
    }, timeoutMs);
    lineReader.once("line", (line) => {
      clearTimeout(timer);
      try {
        const parsed = parseResponse(JSON.parse(line) as unknown);
        finish(() => resolve(parsed));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error("Invalid credential helper response")));
      } finally {
        lineReader.close();
        child.stdin.end();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      finish(() => reject(new Error(`Credential helper unavailable: ${error.message}`)));
    });
    child.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        finish(() => reject(new Error(`Credential helper exited with code ${code ?? "unknown"}`)));
      }
    });
  });
  child.stdin.write(`${JSON.stringify(request)}\n`);
  return await responsePromise;
}

/** JSON-lines client for the self-owned WinCred helper. */
export class WinCredClient implements CredentialStore {
  readonly #runner: WinCredRunner;

  constructor(options: WinCredClientOptions) {
    this.#runner = options.runner ?? new SpawnWinCredRunner(options.helperPath, options.timeoutMs ?? 5_000);
  }

  async get(target: string): Promise<string | undefined> {
    assertLLMCredentialTarget(target);
    const response = await this.#runner.run({ op: "get", target });
    if (!response.ok) throw new Error(response.error ?? "Credential read failed");
    if (response.found === false) return undefined;
    if (response.found !== true || response.secret === undefined) {
      throw new Error("Credential helper response missing secret");
    }
    return response.secret;
  }

  async has(target: string): Promise<boolean> {
    assertLLMCredentialTarget(target);
    const response = await this.#runner.run({ op: "has", target });
    if (!response.ok) throw new Error(response.error ?? "Credential lookup failed");
    if (response.found === undefined) throw new Error("Credential helper response missing found");
    return response.found;
  }

  async set(target: string, secret: string): Promise<void> {
    assertLLMCredentialTarget(target);
    const response = await this.#runner.run({ op: "set", target, secret });
    if (!response.ok) throw new Error(response.error ?? "Credential write failed");
  }

  async delete(target: string): Promise<void> {
    assertLLMCredentialTarget(target);
    const response = await this.#runner.run({ op: "delete", target });
    if (!response.ok) throw new Error(response.error ?? "Credential delete failed");
  }
}

export function credentialTarget(providerId: string): string {
  const target = `AIPathOfBuilding/LLM/${providerId}`;
  assertLLMCredentialTarget(target);
  return target;
}
