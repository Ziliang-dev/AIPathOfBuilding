import type { RpcRequest } from "../protocol.js";

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeArrayField(record: RecordValue, key: string): void {
  const value = record[key];
  if (isRecord(value) && Object.keys(value).length === 0) {
    record[key] = [];
  }
}

function canonicalScenario(value: unknown): unknown {
  switch (value) {
    case "boss":
      return "standardBoss";
    case "guardian":
      return "pinnacle";
    case "uberPinnacle":
      return "uber";
    default:
      return value;
  }
}

function normalizeScenarioWeights(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const normalized = { ...value };
  const aliases: ReadonlyArray<readonly [string, string]> = [
    ["boss", "standardBoss"],
    ["guardian", "pinnacle"],
    ["uberPinnacle", "uber"],
  ];
  for (const [alias, canonical] of aliases) {
    if (normalized[canonical] === undefined && normalized[alias] !== undefined) {
      normalized[canonical] = normalized[alias];
    }
    delete normalized[alias];
  }
  return normalized;
}

function normalizeObjective(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const objective = { ...value };
  normalizeArrayField(objective, "goals");
  normalizeArrayField(objective, "hardConstraints");
  objective.primaryScenario = canonicalScenario(objective.primaryScenario);
  if (objective.scenarioWeights !== undefined) {
    objective.scenarioWeights = normalizeScenarioWeights(objective.scenarioWeights);
  }
  if (isRecord(objective.locks)) {
    const locks = { ...objective.locks };
    normalizeArrayField(locks, "fields");
    objective.locks = locks;
  }
  return objective;
}

function normalizeSnapshot(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const snapshot = { ...value };
  normalizeArrayField(snapshot, "contentCatalog");
  if (isRecord(snapshot.buildGraph)) {
    const buildGraph = { ...snapshot.buildGraph };
    normalizeArrayField(buildGraph, "nodes");
    normalizeArrayField(buildGraph, "edges");
    snapshot.buildGraph = buildGraph;
  }
  return snapshot;
}

/**
 * Normalizes the narrow set of dkjson boundary quirks accepted from the Lua
 * adapter. Domain schemas remain strict and only see canonical values.
 */
export function normalizeRpcParams(method: RpcRequest["method"], value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const params = { ...value };
  switch (method) {
    case "hello": {
      if (params.clientName === undefined && typeof params.client === "string") {
        params.clientName = params.client;
      }
      if (params.clientVersion === undefined &&
        (typeof params.protocolVersion === "number" || typeof params.protocolVersion === "string")) {
        params.clientVersion = String(params.protocolVersion);
      }
      delete params.client;
      delete params.protocolVersion;
      return params;
    }
    case "build.capture":
      params.snapshot = normalizeSnapshot(params.snapshot);
      return params;
    case "run.start":
      params.objective = normalizeObjective(params.objective);
      return params;
    default:
      return params;
  }
}
