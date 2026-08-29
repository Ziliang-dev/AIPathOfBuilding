import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertProviderAuthAllowed,
  listProviderModels,
  migrateProviderProfile,
  providerKindForBaseURL,
  reasoningRequestFields,
  resolveProviderCompatibility,
} from "../src/provider/index.js";

afterEach(() => vi.unstubAllGlobals());

describe("provider compatibility resolution", () => {
  it("uses Responses for OpenAI and Chat Completions as the interoperable default", () => {
    expect(resolveProviderCompatibility({
      baseURL: "https://api.openai.com/v1", model: "gpt-test", apiMode: "auto", reasoningMode: "auto",
    })).toMatchObject({ providerKind: "openai", apiMode: "responses", reasoning: "provider_default" });
    expect(resolveProviderCompatibility({
      baseURL: "https://openrouter.ai/api/v1", model: "deepseek/model", apiMode: "auto", reasoningMode: "balanced",
    })).toMatchObject({ providerKind: "openrouter", apiMode: "chat_completions", reasoning: "high" });
    expect(resolveProviderCompatibility({
      baseURL: "https://provider.invalid/v1", model: "model", apiMode: "auto", reasoningMode: "fast",
    })).toMatchObject({ providerKind: "generic", apiMode: "chat_completions", reasoning: "low" });
  });

  it("honors explicit dialect selection and maps provider-native reasoning fields", () => {
    const resolution = resolveProviderCompatibility({
      baseURL: "https://api.deepseek.com", model: "deepseek-v4-flash", apiMode: "responses", reasoningMode: "deep",
    });
    expect(resolution).toMatchObject({ apiMode: "responses", reasoning: "high" });
    expect(reasoningRequestFields(resolution)).toEqual({ reasoning: { effort: "high" } });
    expect(reasoningRequestFields({
      providerKind: "deepseek", apiMode: "chat_completions", reasoning: "none",
    })).toEqual({ thinking: { type: "disabled" } });
  });

  it("allows no-key authentication only on loopback", () => {
    expect(providerKindForBaseURL("http://127.0.0.1:11434/v1")).toBe("local");
    expect(() => assertProviderAuthAllowed("http://localhost:8000/v1", "none")).not.toThrow();
    expect(() => assertProviderAuthAllowed("https://provider.invalid/v1", "none")).toThrow(/loopback/);
  });

  it("migrates protocol-v2 profiles without changing their Chat request path", () => {
    expect(migrateProviderProfile({
      providerId: "openai",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-old",
      credentialTarget: "AIPathOfBuilding/LLM/openai",
      maxCalls: 16,
      maxOutputTokens: 4096,
      timeoutMs: 120000,
      dataCategories: ["objective"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    })).toMatchObject({
      profileVersion: 2,
      apiMode: "chat_completions",
      resolvedApiMode: "chat_completions",
      reasoningMode: "auto",
      resolvedReasoning: "provider_default",
    });
  });
});

describe("provider model catalog", () => {
  it("returns sorted unique model ids without exposing the bearer key", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
      return new Response(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await listProviderModels({
      baseURL: "https://provider.invalid/v1", authMode: "bearer", apiKey: "secret",
    });
    expect(result).toEqual(["a-model", "z-model"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});
