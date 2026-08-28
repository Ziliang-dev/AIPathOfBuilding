import { isAbsolute, resolve } from "node:path";
import { availableParallelism } from "node:os";
import { z } from "zod";

export const SidecarConfigSchema = z.object({
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(0).max(65_535),
  sessionToken: z.string().min(32),
  dataDir: z.string().min(1).refine(isAbsolute, "--data-dir must be absolute"),
  readyFile: z.string().min(1).refine(isAbsolute, "--ready-file must be absolute").optional(),
  pobExecutable: z.string().min(1).refine(isAbsolute, "--pob-executable must be absolute").optional(),
  workerScript: z.string().min(1).refine(isAbsolute, "--worker-script must be absolute").optional(),
  credentialHelper: z.string().min(1).refine(isAbsolute, "--credential-helper must be absolute").optional(),
  workerCount: z.number().int().min(1).max(8).default(defaultWorkerCount()),
  workerCommand: z.array(z.string().min(1)).min(1).optional(),
  maxFrameBytes: z.number().int().positive().default(8 * 1024 * 1024),
  requestTimeoutMs: z.number().int().positive().default(30_000),
  ownerConnectTimeoutMs: z.number().int().positive().default(30_000),
});
export type SidecarConfig = z.infer<typeof SidecarConfigSchema>;

const optionNames = new Set([
  "--host",
  "--port",
  "--session-token",
  "--data-dir",
  "--ready-file",
  "--pob-executable",
  "--worker-script",
  "--credential-helper",
  "--worker-count",
  "--worker-command",
  "--max-frame-bytes",
  "--request-timeout-ms",
  "--owner-connect-timeout-ms",
]);

export function parseArgs(argv: readonly string[]): SidecarConfig {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === undefined || !optionNames.has(option)) {
      throw new Error(`Unknown option: ${option ?? "<missing>"}`);
    }
    if (value === undefined || optionNames.has(value)) {
      throw new Error(`Missing value for ${option}`);
    }
    if (values.has(option)) {
      throw new Error(`Duplicate option: ${option}`);
    }
    values.set(option, value);
  }

  const required = ["--host", "--port", "--session-token", "--data-dir"] as const;
  for (const option of required) {
    if (!values.has(option)) throw new Error(`Required option missing: ${option}`);
  }

  const candidate = {
    host: values.get("--host"),
    port: numberOption(values, "--port"),
    sessionToken: values.get("--session-token"),
    dataDir: resolve(values.get("--data-dir") ?? ""),
    ...(values.has("--ready-file") ? { readyFile: resolve(values.get("--ready-file")!) } : {}),
    ...(values.has("--pob-executable") ? { pobExecutable: resolve(values.get("--pob-executable")!) } : {}),
    ...(values.has("--worker-script") ? { workerScript: resolve(values.get("--worker-script")!) } : {}),
    ...(values.has("--credential-helper") ? { credentialHelper: resolve(values.get("--credential-helper")!) } : {}),
    ...(values.has("--worker-count") ? { workerCount: numberOption(values, "--worker-count") } : {}),
    ...(values.has("--worker-command") ? { workerCommand: workerCommandOption(values.get("--worker-command")!) } : {}),
    ...(values.has("--max-frame-bytes") ? { maxFrameBytes: numberOption(values, "--max-frame-bytes") } : {}),
    ...(values.has("--request-timeout-ms") ? { requestTimeoutMs: numberOption(values, "--request-timeout-ms") } : {}),
    ...(values.has("--owner-connect-timeout-ms")
      ? { ownerConnectTimeoutMs: numberOption(values, "--owner-connect-timeout-ms") }
      : {}),
  };
  const parsed = SidecarConfigSchema.parse(candidate);
  if ((parsed.pobExecutable === undefined) !== (parsed.workerScript === undefined)) {
    throw new Error("--pob-executable and --worker-script must be supplied together");
  }
  if (parsed.workerCommand !== undefined && parsed.pobExecutable !== undefined) {
    throw new Error("--worker-command cannot be combined with structured worker options");
  }
  return parsed;
}

function workerCommandOption(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("--worker-command must be a JSON array of executable and arguments");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("--worker-command must be a non-empty JSON string array");
  }
  return parsed;
}

export function defaultWorkerCount(): number {
  return Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)));
}

function numberOption(values: ReadonlyMap<string, string>, option: string): number {
  const raw = values.get(option);
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${option} must be an integer`);
  return Number(raw);
}
