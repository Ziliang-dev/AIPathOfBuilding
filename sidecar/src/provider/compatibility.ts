import { z } from "zod";

export const ProviderApiModeSchema = z.enum(["auto", "chat_completions", "responses"]);
export type ProviderApiMode = z.infer<typeof ProviderApiModeSchema>;

export const ResolvedProviderApiModeSchema = z.enum(["chat_completions", "responses"]);
export type ResolvedProviderApiMode = z.infer<typeof ResolvedProviderApiModeSchema>;

export const ProviderReasoningModeSchema = z.enum(["auto", "off", "fast", "balanced", "deep"]);
export type ProviderReasoningMode = z.infer<typeof ProviderReasoningModeSchema>;

export const ProviderAuthModeSchema = z.enum(["bearer", "none"]);
export type ProviderAuthMode = z.infer<typeof ProviderAuthModeSchema>;

export const ProviderKindSchema = z.enum(["openai", "openrouter", "deepseek", "local", "generic"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ResolvedProviderReasoningSchema = z.enum([
  "provider_default",
  "none",
  "low",
  "medium",
  "high",
]);
export type ResolvedProviderReasoning = z.infer<typeof ResolvedProviderReasoningSchema>;

export const ProviderCompatibilityResolutionSchema = z.object({
  providerKind: ProviderKindSchema,
  apiMode: ResolvedProviderApiModeSchema,
  reasoning: ResolvedProviderReasoningSchema,
}).strict();
export type ProviderCompatibilityResolution = z.infer<typeof ProviderCompatibilityResolutionSchema>;

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());
}

export function providerKindForBaseURL(baseURL: string): ProviderKind {
  const hostname = new URL(baseURL).hostname.toLowerCase();
  if (isLoopback(hostname)) return "local";
  if (hostname === "api.openai.com") return "openai";
  if (hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai")) return "openrouter";
  if (hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com")) return "deepseek";
  return "generic";
}

export function resolveProviderCompatibility(input: {
  baseURL: string;
  model: string;
  apiMode: ProviderApiMode;
  reasoningMode: ProviderReasoningMode;
}): ProviderCompatibilityResolution {
  const providerKind = providerKindForBaseURL(input.baseURL);
  const apiMode = input.apiMode === "auto"
    ? providerKind === "openai" ? "responses" : "chat_completions"
    : input.apiMode;
  const reasoning = resolveProviderReasoning(providerKind, input.model, input.reasoningMode);
  return ProviderCompatibilityResolutionSchema.parse({ providerKind, apiMode, reasoning });
}

export function resolveProviderReasoning(
  providerKind: ProviderKind,
  model: string,
  reasoningMode: ProviderReasoningMode,
): ResolvedProviderReasoning {
  switch (reasoningMode) {
    case "auto":
      return "provider_default";
    case "off":
      return "none";
    case "fast":
      return "low";
    case "balanced":
      return providerKind === "deepseek" || /^deepseek\//i.test(model) ? "high" : "medium";
    case "deep":
      return "high";
  }
}

export function reasoningRequestFields(
  resolution: ProviderCompatibilityResolution,
): Record<string, unknown> {
  if (resolution.reasoning === "provider_default") return {};
  if (resolution.apiMode === "responses") {
    return { reasoning: { effort: resolution.reasoning } };
  }
  if (resolution.providerKind === "deepseek") {
    if (resolution.reasoning === "none") return { thinking: { type: "disabled" } };
    return {
      thinking: { type: "enabled" },
      reasoning_effort: resolution.reasoning,
    };
  }
  if (resolution.providerKind === "openrouter") {
    return { reasoning: { effort: resolution.reasoning } };
  }
  return { reasoning_effort: resolution.reasoning };
}

export function assertProviderAuthAllowed(baseURL: string, authMode: ProviderAuthMode): void {
  if (authMode !== "none") return;
  const hostname = new URL(baseURL).hostname.toLowerCase();
  if (!isLoopback(hostname)) {
    throw new Error("No-key provider access is allowed only for loopback endpoints");
  }
}
