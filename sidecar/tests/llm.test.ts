import { describe, expect, it } from "vitest";
import {
  HIGH_LEVEL_TOOL_NAMES,
  OpenAICompatibleAdapter,
  redactForModel,
  type ChatCompletionTransport,
} from "../src/llm/index.js";

class StubTransport implements ChatCompletionTransport {
  request: Record<string, unknown> | undefined;

  constructor(readonly response: unknown, readonly failure?: Error) {}

  async create(request: Record<string, unknown>, _signal: AbortSignal): Promise<unknown> {
    this.request = request;
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.response;
  }
}

function adapter(transport: ChatCompletionTransport, maxCalls = 16): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter(
    {
      apiKey: "super-secret-key",
      baseURL: "https://provider.invalid/v1",
      model: "test-model",
      maxCalls,
    },
    { transport },
  );
}

describe("OpenAICompatibleAdapter", () => {
  it("sends only high-level tools and redacts model context", async () => {
    const transport = new StubTransport({
      choices: [{ message: { content: "Done" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    const model = adapter(transport);

    const result = await model.complete({
      messages: [{ role: "user", content: "Inspect build" }],
      context: {
        accountName: "private-account",
        characterName: "private-character",
        characterLevel: 95,
        xml: '<Build accountName="private-account" characterName="private-character"/>',
      },
    });

    expect(result).toMatchObject({ kind: "message", content: "Done" });
    expect(result).toMatchObject({ usage: { inputTokens: 10, outputTokens: 2 } });
    const serialized = JSON.stringify(transport.request);
    expect(serialized).not.toContain("private-account");
    expect(serialized).not.toContain("private-character");
    expect(serialized).not.toContain("super-secret-key");
    expect(serialized).not.toContain("accountName");
    expect(serialized).not.toContain("characterName");
    expect(serialized).toContain("characterLevel");
    const tools = transport.request?.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toEqual(HIGH_LEVEL_TOOL_NAMES);
    expect(tools.some((tool) => tool.function.name.includes("apply"))).toBe(false);
    for (const tool of tools as unknown as Array<{
      function: { parameters: { properties: Record<string, unknown>; required: string[] } };
    }>) {
      expect(tool.function.parameters.required.sort()).toEqual(
        Object.keys(tool.function.parameters.properties).sort(),
      );
    }
  });

  it("strictly parses allowed tool calls", async () => {
    const model = adapter(
      new StubTransport({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "inspect_build",
                    arguments: '{"snapshotId":"snapshot-1","domains":["skills","gear"]}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    const result = await model.complete({ messages: [{ role: "user", content: "Inspect" }] });
    expect(result).toMatchObject({
      kind: "message",
      toolCalls: [
        {
          id: "call-1",
          name: "inspect_build",
          arguments: { snapshotId: "snapshot-1", domains: ["skills", "gear"] },
        },
      ],
    });
  });

  it("encodes Responses API tools and parses function-call output", async () => {
    const transport = new StubTransport({
      model: "resolved-model",
      output: [
        { type: "reasoning", id: "reasoning-1" },
        {
          type: "function_call",
          call_id: "call-r1",
          name: "inspect_build",
          arguments: '{"snapshotId":"snapshot-1","domains":["skills"]}',
        },
      ],
      usage: { input_tokens: 20, output_tokens: 7 },
    });
    const model = new OpenAICompatibleAdapter({
      apiKey: "secret",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-test",
      authMode: "bearer",
      apiMode: "responses",
      providerKind: "openai",
      reasoningMode: "fast",
    }, { transport });

    const result = await model.complete({ messages: [{ role: "user", content: "Inspect" }] });
    expect(result).toMatchObject({
      kind: "message",
      toolCalls: [{ id: "call-r1", name: "inspect_build" }],
      usage: { inputTokens: 20, outputTokens: 7 },
    });
    expect(transport.request).toMatchObject({
      model: "gpt-test",
      tool_choice: "auto",
      max_output_tokens: 4096,
      reasoning: { effort: "low" },
      store: false,
    });
    const tools = transport.request?.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toMatchObject({ type: "function", name: "inspect_build", strict: true });
  });

  it("keeps DeepSeek reasoning content inside the adapter for the next tool turn", async () => {
    const responses = [
      {
        choices: [{ message: {
          content: null,
          reasoning_content: "private-reasoning",
          tool_calls: [{
            id: "call-d1", type: "function",
            function: { name: "inspect_build", arguments: '{"snapshotId":"snapshot-1"}' },
          }],
        } }],
      },
      { choices: [{ message: { content: "Done" } }] },
    ];
    const requests: Record<string, unknown>[] = [];
    const transport: ChatCompletionTransport = {
      create: async (request) => {
        requests.push(request);
        return responses.shift();
      },
    };
    const model = new OpenAICompatibleAdapter({
      apiKey: "secret",
      baseURL: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      providerKind: "deepseek",
      reasoningMode: "fast",
    }, { transport });
    await model.complete({ messages: [{ role: "user", content: "Inspect" }] });
    await model.complete({ messages: [
      { role: "user", content: "Inspect" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-d1", name: "inspect_build", arguments: '{"snapshotId":"snapshot-1"}' }] },
      { role: "tool", content: "{}", toolCallId: "call-d1" },
    ] });
    expect(JSON.stringify(requests[1])).toContain("private-reasoning");
    expect(requests[1]).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
  });

  it("accepts provider nulls only for optional arguments", async () => {
    const model = adapter(
      new StubTransport({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-null",
                  type: "function",
                  function: {
                    name: "inspect_build",
                    arguments: '{"snapshotId":"snapshot-1","domains":null}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    await expect(model.complete({ messages: [{ role: "user", content: "Inspect" }] })).resolves.toMatchObject({
      kind: "message",
      toolCalls: [{ arguments: { snapshotId: "snapshot-1" } }],
    });
  });

  it("rejects forbidden and malformed tool calls", async () => {
    const forbidden = adapter(
      new StubTransport({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "commit_build", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    );
    const malformed = adapter(
      new StubTransport({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call-2",
                  type: "function",
                  function: {
                    name: "inspect_build",
                    arguments: '{"snapshotId":"x","unexpected":true}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );

    await expect(forbidden.complete({ messages: [{ role: "user", content: "x" }] })).resolves.toMatchObject({
      kind: "fallback",
      signal: { reason: "invalid_provider_response", retryable: false },
    });
    await expect(malformed.complete({ messages: [{ role: "user", content: "x" }] })).resolves.toMatchObject({
      kind: "fallback",
      signal: { reason: "invalid_provider_response", retryable: false },
    });
  });

  it("emits deterministic provider failure and call-limit signals", async () => {
    const transport = new StubTransport(undefined, new Error("provider offline"));
    const model = adapter(transport, 1);

    await expect(model.complete({ messages: [{ role: "user", content: "x" }] })).resolves.toMatchObject({
      kind: "fallback",
      signal: { type: "deterministic_fallback", reason: "provider_unavailable", retryable: true },
    });
    await expect(model.complete({ messages: [{ role: "user", content: "x" }] })).resolves.toMatchObject({
      kind: "fallback",
      signal: { reason: "model_call_limit", retryable: false },
    });
  });

  it("does not convert caller cancellation into provider fallback", async () => {
    const transport: ChatCompletionTransport = {
      create: async (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    };
    const model = adapter(transport);
    const controller = new AbortController();
    const completion = model.complete({ messages: [{ role: "user", content: "x" }] }, controller.signal);
    controller.abort(new Error("user cancelled"));
    await expect(completion).rejects.toThrow(/user cancelled/);
  });
});

describe("redactForModel", () => {
  it("redacts account, character, seller, trade ids, and token values recursively", () => {
    const redacted = redactForModel({
      account: { accountName: "acct" },
      character: { id: "private-character-container", class: "Witch" },
      characterName: "private-char",
      seller: { name: "private-seller" },
      listingId: "private-listing",
      access_token: "private-token",
      oauthAccessToken: "private-oauth-token",
      safe: {
        class: "Witch",
        characterLevel: 90,
        nested: [{ tradeId: "nested-trade", damage: 100 }],
      },
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("acct");
    expect(serialized).not.toContain("private-char");
    expect(serialized).not.toContain("private-character-container");
    expect(serialized).not.toContain("private-seller");
    expect(serialized).not.toContain("private-listing");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("private-oauth-token");
    expect(serialized).not.toContain("nested-trade");
    expect(serialized).not.toContain("accountName");
    expect(serialized).not.toContain("characterName");
    expect(serialized).not.toContain('"character"');
    expect(serialized).not.toContain("listingId");
    expect(serialized).not.toContain("tradeId");
    expect(serialized).toContain("Witch");
    expect(serialized).toContain("characterLevel");
  });
});
