import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/config.js";

describe("CLI config", () => {
  it("accepts loopback and ephemeral port startup contract", () => {
    const config = parseArgs([
      "--host", "127.0.0.1",
      "--port", "0",
      "--session-token", "x".repeat(32),
      "--data-dir", resolve("data"),
      "--ready-file", resolve("ready.json"),
      "--worker-command", '["PathOfBuilding.exe","worker.lua"]',
    ]);
    expect(config.port).toBe(0);
    expect(config.readyFile).toBe(resolve("ready.json"));
    expect(config.workerCommand).toEqual(["PathOfBuilding.exe", "worker.lua"]);
    expect(config.ownerConnectTimeoutMs).toBe(30_000);
  });

  it("accepts structured PoB worker process options", () => {
    const config = parseArgs([
      "--host", "127.0.0.1",
      "--port", "0",
      "--session-token", "x".repeat(32),
      "--data-dir", resolve("data"),
      "--pob-executable", resolve("PathOfBuilding.exe"),
      "--worker-script", resolve("src/AIPoBWorker.lua"),
      "--worker-count", "4",
      "--owner-connect-timeout-ms", "45000",
    ]);
    expect(config.workerCount).toBe(4);
    expect(config.ownerConnectTimeoutMs).toBe(45_000);
  });

  it("rejects non-loopback hosts", () => {
    expect(() => parseArgs([
      "--host", "0.0.0.0",
      "--port", "1",
      "--session-token", "x".repeat(32),
      "--data-dir", resolve("data"),
    ])).toThrow();
  });
});
