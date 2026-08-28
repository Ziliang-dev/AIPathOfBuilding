import { describe, expect, it } from "vitest";
import { WinCredClient, credentialTarget, type WinCredRequest, type WinCredResponse, type WinCredRunner } from "../src/credentials/index.js";

class StubRunner implements WinCredRunner {
  readonly requests: WinCredRequest[] = [];
  readonly values = new Map<string, string>();

  async run(request: WinCredRequest): Promise<WinCredResponse> {
    this.requests.push(request);
    if (request.op === "set") {
      this.values.set(request.target, request.secret ?? "");
      return { ok: true };
    }
    if (request.op === "delete") {
      this.values.delete(request.target);
      return { ok: true };
    }
    if (!this.values.has(request.target)) return { ok: true, found: false };
    if (request.op === "has") return { ok: true, found: true };
    const secret = this.values.get(request.target);
    return secret === undefined ? { ok: true, found: true } : { ok: true, found: true, secret };
  }
}

describe("WinCredClient", () => {
  it("uses JSON-lines operations and never puts secrets in targets", async () => {
    const runner = new StubRunner();
    const client = new WinCredClient({ helperPath: "ignored", runner });
    const target = credentialTarget("openai");
    await client.set(target, "key-value");
    expect(await client.has(target)).toBe(true);
    expect(await client.get(target)).toBe("key-value");
    await client.delete(target);
    expect(await client.get(target)).toBeUndefined();
    expect(runner.requests).toEqual([
      { op: "set", target, secret: "key-value" },
      { op: "has", target },
      { op: "get", target },
      { op: "delete", target },
      { op: "get", target },
    ]);
    expect(target).not.toContain("key-value");
  });

  it("refuses PoE OAuth and every target outside the LLM namespace", async () => {
    const runner = new StubRunner();
    const client = new WinCredClient({ helperPath: "ignored", runner });
    await expect(client.set("PoE/OAuth/access-token", "token")).rejects.toThrow(/LLM namespace/);
    await expect(client.get("AIPathOfBuilding/PoE/openai")).rejects.toThrow(/LLM namespace/);
    expect(() => credentialTarget("../oauth")).toThrow(/LLM namespace/);
    expect(runner.requests).toEqual([]);
  });
});
