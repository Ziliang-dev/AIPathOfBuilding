import { z } from "zod";
import { redactString } from "../llm/redaction.js";
import { canonicalProviderBaseURL } from "./types.js";
import { ProviderAuthModeSchema, assertProviderAuthAllowed } from "./compatibility.js";

const MAX_MODEL_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_COUNT = 5_000;

export const ProviderModelCatalogInputSchema = z.object({
  baseURL: z.string().url(),
  authMode: ProviderAuthModeSchema,
  apiKey: z.string().default(""),
}).strict().superRefine((value, context) => {
  if (value.authMode === "bearer" && value.apiKey.length === 0) {
    context.addIssue({ code: "custom", path: ["apiKey"], message: "Bearer authentication requires an API key" });
  }
  try {
    assertProviderAuthAllowed(value.baseURL, value.authMode);
  } catch (error) {
    context.addIssue({
      code: "custom",
      path: ["authMode"],
      message: error instanceof Error ? error.message : "Invalid provider authentication mode",
    });
  }
});

const ModelCatalogResponseSchema = z.looseObject({
  data: z.array(z.looseObject({ id: z.string().min(1).max(256) })).max(MAX_MODEL_COUNT),
});

export async function listProviderModels(
  input: z.input<typeof ProviderModelCatalogInputSchema>,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const config = ProviderModelCatalogInputSchema.parse(input);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.authMode === "bearer") headers.Authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(`${canonicalProviderBaseURL(config.baseURL)}/models`, {
    headers,
    ...(signal === undefined ? {} : { signal }),
  });
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_MODEL_CATALOG_BYTES) {
    throw new Error("Provider model list exceeded the 2 MiB limit");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_MODEL_CATALOG_BYTES) {
    throw new Error("Provider model list exceeded the 2 MiB limit");
  }
  if (!response.ok) {
    throw new Error(`Model list request failed with HTTP ${response.status}: ${redactString(text).slice(0, 500)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Provider model list returned invalid JSON");
  }
  const parsed = ModelCatalogResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Provider model list did not match the OpenAI-compatible /models schema");
  return [...new Set(parsed.data.data.map((model) => model.id))].sort((left, right) => left.localeCompare(right));
}
