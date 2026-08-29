import { describe, expect, it } from "vitest";
import {
  CONNECTION_PROBE_TOOL_NAME,
  ProviderConnectionProbeError,
  runProviderConnectionProbe,
} from "../src/provider/index.js";
import type { ChatCompletionTransportFactory } from "../src/provider/connectionProbe.js";

function factory(response: unknown, failure?: unknown, capture?: (request: Record<string, unknown>) => void): ChatCompletionTransportFactory {
  return () => ({
    async create(request, signal) {
      capture?.(request);
      if (failure !== undefined) throw failure;
      if (response instanceof Promise) return response;
      signal.throwIfAborted();
      return response;
    },
  });
}

const success = {
  model: "resolved-model",
  choices: [{
    message: {
      tool_calls: [{
        id: "probe-1",
        type: "function",
        function: { name: CONNECTION_PROBE_TOOL_NAME, arguments: '{"ok":true}' },
      }],
    },
  }],
  usage: { prompt_tokens: 12, completion_tokens: 3 },
};

describe("provider connection probe", () => {
  it("forces and validates the AIPoB synthetic tool call", async () => {
    let request: Record<string, unknown> | undefined;
    const result = await runProviderConnectionProbe({
      apiKey: "secret",
      baseURL: "https://provider.invalid/v1",
      model: "requested-model",
    }, undefined, factory(success, undefined, (value) => { request = value; }));

    expect(result).toMatchObject({
      ok: true,
      requestedModel: "requested-model",
      responseModel: "resolved-model",
      toolCallValidated: true,
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(request).toMatchObject({
      model: "requested-model",
      tool_choice: { type: "function", function: { name: CONNECTION_PROBE_TOOL_NAME } },
      parallel_tool_calls: false,
      max_completion_tokens: 32,
    });
    expect(JSON.stringify(request)).not.toContain("secret");
  });

  it.each<[unknown, RegExp]>([
    [{ choices: [{ message: { content: "ok" } }] }, /required tool call/],
    [{ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "wrong_tool", arguments: '{"ok":true}' } }] } }] }, /required tool call/],
    [{ choices: [{ message: { tool_calls: [{ type: "function", function: { name: CONNECTION_PROBE_TOOL_NAME, arguments: "{" } }] } }] }, /valid JSON/],
    [{ choices: [{ message: { tool_calls: [{ type: "function", function: { name: CONNECTION_PROBE_TOOL_NAME, arguments: '{"ok":false}' } }] } }] }, /ok=true/],
    [{ broken: true }, /malformed/],
  ])("rejects incompatible provider responses", async (response, pattern) => {
    await expect(runProviderConnectionProbe({
      apiKey: "secret",
      baseURL: "https://provider.invalid/v1",
      model: "test-model",
    }, undefined, factory(response))).rejects.toThrow(pattern);
  });

  it.each([401, 404, 429])("redacts credentials from HTTP %s provider errors", async (status) => {
    const failure = Object.assign(new Error("Authorization api_key=top-secret failed"), { status });
    let caught: unknown;
    try {
      await runProviderConnectionProbe({
        apiKey: "top-secret",
        baseURL: "https://provider.invalid/v1",
        model: "test-model",
      }, undefined, factory(undefined, failure));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProviderConnectionProbeError);
    expect(String(caught)).toContain(`HTTP ${status}`);
    expect(String(caught)).not.toContain("top-secret");
  });

  it("returns a bounded timeout error", async () => {
    const waiting: ChatCompletionTransportFactory = () => ({
      create: async (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    await expect(runProviderConnectionProbe({
      apiKey: "secret",
      baseURL: "https://provider.invalid/v1",
      model: "test-model",
    }, undefined, waiting, 100)).rejects.toThrow(/timed out after 100 ms/);
  });
});
