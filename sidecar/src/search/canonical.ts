import { createHash } from "node:crypto";

function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical values cannot contain non-finite numbers");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new TypeError("Canonical values cannot contain cycles");
    }
    seen.add(value);
    const result = value.map((entry) => normalize(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      throw new TypeError("Canonical values cannot contain cycles");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical values must be plain JSON objects");
    }
    seen.add(value);
    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const entry = input[key];
      if (entry === undefined) {
        continue;
      }
      if (typeof entry === "bigint" || typeof entry === "function" || typeof entry === "symbol") {
        throw new TypeError(`Canonical value at ${key} is not JSON-compatible`);
      }
      result[key] = normalize(entry, seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError("Canonical values must be JSON-compatible");
}

export function canonicalize(value: unknown): unknown {
  return normalize(value, new Set<object>());
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value)).digest("hex");
}

export interface SearchCacheKeyInput {
  readonly engineCommit: string;
  readonly ruleset: string;
  readonly buildFingerprint: string;
  readonly actions: unknown;
  readonly scenario: unknown;
  readonly objectiveVersion: string | number;
}

export function createSearchCacheKey(input: SearchCacheKeyInput): string {
  return canonicalHash({ ...input, actions: canonicalActionBatch(input.actions) });
}

export function canonicalActionBatch(actions: unknown): unknown {
  if (!Array.isArray(actions)) return actions;
  return [...actions].sort((left, right) => actionIdentity(left).localeCompare(actionIdentity(right)));
}

function actionIdentity(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === "string") return `0:${id}`;
  }
  return `1:${canonicalStringify(value)}`;
}
