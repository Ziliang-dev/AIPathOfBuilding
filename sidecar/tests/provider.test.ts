import { describe, expect, it } from "vitest";
import {
  ConsentGuardAdapter,
  ConsentManager,
  EphemeralPlannerChatService,
  MemoryConsentRecordStore,
  MemoryProviderProfileStore,
  ProviderConfigurationError,
  ProviderProfileService,
  ProviderProfileSchema,
  createConsentKey,
  parseObjectiveSpecDraft,
  providerProfileWithDefaults,
  canonicalProviderBaseURL,
  type ProviderProfile,
} from "../src/provider/index.js";
import { MemoryCredentialStore } from "../src/credentials/index.js";
import type { ModelAdapter, ModelTurnInput, ModelTurnResult } from "../src/llm/types.js";
import type { HighLevelToolName } from "../src/llm/toolSchemas.js";

function profile(providerId = "openai"): ProviderProfile {
  return providerProfileWithDefaults({ providerId, model: "test-model", apiKey: "secret" }, new Date("2026-01-01T00:00:00.000Z"));
}

class StubAdapter implements ModelAdapter<HighLevelToolName> {
  callsUsed = 0;
  readonly callsRemaining = 16;
  constructor(readonly response: ModelTurnResult<HighLevelToolName>) {}
  async complete(_input: ModelTurnInput): Promise<ModelTurnResult<HighLevelToolName>> {
    this.callsUsed += 1;
    return this.response;
  }
}

describe("provider profile and consent", () => {
  it("canonicalizes endpoints and rejects insecure non-loopback URLs", () => {
    expect(canonicalProviderBaseURL("HTTPS://Example.COM/v1/")).toBe("https://example.com/v1");
    expect(canonicalProviderBaseURL("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
    expect(() => canonicalProviderBaseURL("http://example.com/v1")).toThrow(/HTTPS/);
  });

  it("binds profiles to the LLM-only credential namespace", () => {
    expect(() => providerProfileWithDefaults({ providerId: "openai", model: "x", apiKey: "x" })).not.toThrow();
    expect(() => ProviderProfileSchema.parse({
      ...profile(), credentialTarget: "PoE/OAuth/access-token",
    })).toThrow(/LLM target/);
  });

  it("configures key and profile atomically without exposing key in status", async () => {
    const credentials = new MemoryCredentialStore();
    const profiles = new MemoryProviderProfileStore();
    const consent = new ConsentManager(new MemoryConsentRecordStore());
    const service = new ProviderProfileService({ profiles, credentials, consent });
    await service.configure({ providerId: "openai", model: "test-model", apiKey: "secret" });
    const status = await service.status("openai");
    expect(status.credentialConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(await credentials.get("AIPathOfBuilding/LLM/openai")).toBe("secret");
  });

  it("rolls back the credential if profile persistence fails", async () => {
    const credentials = new MemoryCredentialStore();
    const profiles = new MemoryProviderProfileStore();
    const originalPut = profiles.put.bind(profiles);
    profiles.put = async () => { throw new Error("disk full"); };
    const service = new ProviderProfileService({
      profiles,
      credentials,
      consent: new ConsentManager(),
    });
    await expect(service.configure({ providerId: "openai", model: "test-model", apiKey: "secret" })).rejects.toBeInstanceOf(ProviderConfigurationError);
    expect(await credentials.has("AIPathOfBuilding/LLM/openai")).toBe(false);
    profiles.put = originalPut;
  });

  it("requires the current consent key and blocks first provider call", async () => {
    const p = profile();
    const consent = new ConsentManager();
    const inner = new StubAdapter({ kind: "message", content: "ok", toolCalls: [] });
    const guarded = new ConsentGuardAdapter(inner, p, consent);
    const blocked = await guarded.complete({ messages: [{ role: "user", content: "hello" }] });
    expect(blocked.kind).toBe("fallback");
    if (blocked.kind === "fallback") expect(blocked.signal.reason).toBe("provider_consent_required");
    expect(inner.callsUsed).toBe(0);
    await expect(consent.grant(p, "sha256:wrong")).rejects.toThrow(/consent key/i);
    await consent.grant(p, createConsentKey({ providerId: p.providerId, baseURL: p.baseURL, model: p.model, dataCategories: p.dataCategories }));
    expect((await guarded.complete({ messages: [{ role: "user", content: "hello" }] })).kind).toBe("message");
    await consent.revoke(p.providerId);
    expect((await guarded.complete({ messages: [{ role: "user", content: "hello" }] })).kind).toBe("fallback");
  });

  it("binds consent to the selected data categories", async () => {
    const p = profile();
    const consent = new ConsentManager();
    const preview = consent.preview(p, { metrics: true }, ["objective", "metrics"]);
    await consent.grant(p, preview.consentKey, ["objective", "metrics"]);
    expect(await consent.isGranted(p)).toBe(true);
    expect(consent.preview(p, { metrics: true }, ["objective"]).consentKey).not.toBe(preview.consentKey);
  });
});

describe("strict objective draft and ephemeral chat", () => {
  it("rejects unknown root and nested draft keys", () => {
    expect(() => parseObjectiveSpecDraft({ goals: [{ metric: "dps", direction: "maximize" }], unknown: true })).toThrow();
    expect(() => parseObjectiveSpecDraft({ goals: [{ metric: "dps", direction: "maximize", nested: true }] })).toThrow();
  });

  it("parses model JSON and does not persist chat", async () => {
    const adapter = new StubAdapter({
      kind: "message",
      content: JSON.stringify({ goals: [{ metric: "dps", direction: "maximize" }] }),
      toolCalls: [],
    });
    const chat = new EphemeralPlannerChatService(adapter);
    const result = await chat.draftObjective({ messages: [{ role: "user", content: "maximize damage" }] });
    expect(result.kind).toBe("draft");
    if (result.kind === "draft") expect(result.draft.goals?.[0]?.metric).toBe("dps");
    expect(adapter.callsUsed).toBe(1);
  });
});
