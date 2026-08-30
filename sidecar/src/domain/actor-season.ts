import { ConditionClaimSchema } from "./evidence.js";
import type { ContentCatalogEntry } from "../schemas.js";
import type {
  MechanicAdapter,
  MechanicAdapterContext,
  MechanicAdapterOutput,
} from "./adapters.js";
import type { DomainEdge, DomainNode } from "./graph.js";

/** Rulesets for which the native actor/season projection has been reviewed. */
export const ACTOR_SEASON_RULESETS = ["3_29", "3_29_ruthless"] as const;
export const ACTOR_SEASON_ADAPTER_IDS = [
  "actor-native",
  "bloodline",
  "pacts",
  "advanced-passives-native",
  "equipment-seasonal",
] as const;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function identifier(value: unknown): string | undefined {
  const asText = text(value);
  if (asText !== undefined) return asText;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function normalizedRuleset(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll(".", "_");
  return normalized === "3_29ruthless" ? "3_29_ruthless" : normalized;
}

export function supportsActorSeasonRuleset(ruleset: string): boolean {
  return (ACTOR_SEASON_RULESETS as readonly string[]).includes(normalizedRuleset(ruleset));
}

function sourceEntries(context: MechanicAdapterContext, domains: readonly ContentCatalogEntry["domain"][]): ContentCatalogEntry[] {
  return context.catalog.filter((entry) => domains.includes(entry.domain));
}

function outputFor(
  nodes: DomainNode[],
  edges: DomainEdge[],
  claims: ReturnType<typeof ConditionClaimSchema.parse>[],
): MechanicAdapterOutput {
  return { nodes, edges, conditionClaims: claims };
}

function addNode(
  nodes: DomainNode[],
  edges: DomainEdge[],
  source: ContentCatalogEntry,
  node: DomainNode,
  existingNodeIds?: ReadonlySet<string>,
): void {
  if (existingNodeIds?.has(node.id) || nodes.some((current) => current.id === node.id)) return;
  nodes.push(node);
  if (node.id !== source.id) {
    edges.push({ from: source.id, to: node.id, relation: "grants", data: { native: true } });
  }
}

function nativeNode(
  id: string,
  domain: DomainNode["domain"],
  kind: string,
  data: RecordValue,
): DomainNode {
  return { id, domain, kind, data: { ...data, native: true } };
}

function withoutPartyText(actor: RecordValue): RecordValue {
  const safe = { ...actor };
  for (const key of ["text", "buf", "raw", "content"]) delete safe[key];
  return safe;
}

function nativeClaims(value: unknown): ReturnType<typeof ConditionClaimSchema.parse>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((claim) => {
    const parsed = ConditionClaimSchema.safeParse(claim);
    return parsed.success ? [parsed.data] : [];
  });
}

function actorRecords(entry: ContentCatalogEntry): RecordValue[] {
  const data = entry.data;
  const records = Array.isArray(data.actors)
    ? data.actors.flatMap((value) => {
      const parsed = record(value);
      return parsed === undefined ? [] : [parsed];
    })
    : [];
  if (data.player === true) records.push({ id: "actor:player", kind: "player", source: "Build" });
  if (data.minions === true) records.push({ id: "actor:minion", kind: "minion", source: "Skills" });
  if (Array.isArray(data.minions)) {
    for (const value of data.minions) {
      const parsed = record(value);
      if (parsed !== undefined) records.push(parsed);
      else if (text(value) !== undefined) records.push({ id: `actor:minion:${value}`, kind: "minion", minionId: value });
    }
  }
  if (Array.isArray(data.spectres)) {
    for (const value of data.spectres) {
      const parsed = record(value);
      if (parsed !== undefined) records.push(parsed);
      else if (text(value) !== undefined) records.push({
        id: `actor:spectre:${value}`, kind: "spectre", spectreId: value,
      });
    }
  }
  if (Array.isArray(data.animateGuardian)) {
    for (const value of data.animateGuardian) {
      const parsed = record(value);
      if (parsed !== undefined) records.push({ ...parsed, kind: "animateGuardian" });
    }
  }
  const party = record(data.party);
  if (party !== undefined) {
    for (const buffer of Object.keys(party).sort()) {
      const value = party[buffer];
      const parsed = record(value);
      records.push({
        ...(parsed ?? {}),
        id: `actor:party:${buffer}`,
        kind: "party",
        buffer,
        sourceStatus: parsed?.sourceStatus ?? "manual",
      });
    }
  }
  return records;
}

function actorAdapter(): MechanicAdapter {
  return {
    id: "actor-native",
    version: 1,
    priority: 100,
    minRuleset: "3.29",
    maxRuleset: "3.29",
    supports: (context) => supportsActorSeasonRuleset(context.ruleset)
      && sourceEntries(context, ["actor"]).some((entry) => actorRecords(entry).length > 0),
    apply: (context) => {
      const nodes: DomainNode[] = [];
      const edges: DomainEdge[] = [];
      const claims: ReturnType<typeof ConditionClaimSchema.parse>[] = [];
      const existingNodeIds = new Set(context.graph.nodes.map((node) => node.id));
      for (const entry of sourceEntries(context, ["actor"])) {
        for (const actor of actorRecords(entry)) {
          const id = text(actor.id);
          if (id === undefined) continue;
          const kind = text(actor.kind) ?? "actor";
          const data = kind === "party" ? withoutPartyText(actor) : actor;
          addNode(nodes, edges, entry, nativeNode(id, "actor", kind, {
            ...data,
            id: undefined,
          }), existingNodeIds);
        }
        claims.push(...nativeClaims(entry.data.conditionClaims));
      }
      return outputFor(nodes, edges, claims);
    },
  };
}

function seasonObject(entry: ContentCatalogEntry): RecordValue {
  return record(entry.data.season) ?? record(entry.data.actorSeason) ?? {};
}

function bloodlineAdapter(): MechanicAdapter {
  return {
    id: "bloodline",
    version: 1,
    priority: 110,
    minRuleset: "3.29",
    maxRuleset: "3.29",
    supports: (context) => supportsActorSeasonRuleset(context.ruleset)
      && sourceEntries(context, ["tree", "identity", "actor"]).some((entry) => {
        const season = seasonObject(entry);
        return record(entry.data.secondaryAscendancy) !== undefined
          || record(entry.data.bloodline) !== undefined
          || record(season.secondaryAscendancy) !== undefined
          || record(season.bloodline) !== undefined
          || Array.isArray(season.alternateAscendancies);
      }),
    apply: (context) => {
      const nodes: DomainNode[] = [];
      const edges: DomainEdge[] = [];
      const existingNodeIds = new Set(context.graph.nodes.map((node) => node.id));
      for (const entry of sourceEntries(context, ["tree", "identity", "actor"])) {
        const season = seasonObject(entry);
        const selected = record(entry.data.secondaryAscendancy)
          ?? record(entry.data.bloodline)
          ?? record(season.secondaryAscendancy)
          ?? record(season.bloodline);
        if (selected !== undefined) {
          const id = identifier(selected.id) ?? text(selected.name);
          if (id !== undefined) {
            addNode(nodes, edges, entry, nativeNode(`season:bloodline:${id}`, "identity", "bloodline", {
              ...selected,
              selected: selected.selected !== false,
            }), existingNodeIds);
          }
        }
        const alternatives = Array.isArray(season.alternateAscendancies)
          ? season.alternateAscendancies
          : [];
        for (const value of alternatives) {
          const alternative = record(value);
          const id = alternative && (identifier(alternative.id) ?? text(alternative.name));
          if (alternative !== undefined && id !== undefined) {
            addNode(nodes, edges, entry, nativeNode(`season:bloodline:${id}`, "identity", "bloodline", alternative), existingNodeIds);
          }
        }
      }
      return outputFor(nodes, edges, []);
    },
  };
}

function pactAdapter(): MechanicAdapter {
  return {
    id: "pacts",
    version: 1,
    priority: 110,
    minRuleset: "3.29",
    maxRuleset: "3.29",
    supports: (context) => supportsActorSeasonRuleset(context.ruleset)
      && sourceEntries(context, ["skills", "identity", "actor"]).some((entry) => {
        const season = seasonObject(entry);
        return Array.isArray(entry.data.pacts) || Array.isArray(season.pacts)
          || (Array.isArray(entry.data.groups) && entry.data.groups.some((group) => {
            const parsed = record(group);
            return Array.isArray(parsed?.gems) && parsed.gems.some((gem) => {
              const value = record(gem);
              return text(value?.name)?.toLowerCase().startsWith("pact of ") === true;
            });
          }));
      }),
    apply: (context) => {
      const nodes: DomainNode[] = [];
      const edges: DomainEdge[] = [];
      const claims: ReturnType<typeof ConditionClaimSchema.parse>[] = [];
      const existingNodeIds = new Set(context.graph.nodes.map((node) => node.id));
      for (const entry of sourceEntries(context, ["skills", "identity", "actor"])) {
        const season = seasonObject(entry);
        const records: unknown[] = [
          ...(Array.isArray(entry.data.pacts) ? entry.data.pacts : []),
          ...(Array.isArray(season.pacts) ? season.pacts : []),
        ];
        if (Array.isArray(entry.data.groups)) {
          for (const group of entry.data.groups) {
            const parsed = record(group);
            if (!Array.isArray(parsed?.gems)) continue;
            for (const gem of parsed.gems) {
              const value = record(gem);
              const name = text(value?.name) ?? text(value?.nameSpec);
              if (name?.toLowerCase().startsWith("pact of ")) records.push({
                ...value, id: name, name,
                group: parsed.index,
              });
            }
          }
        }
        for (const value of records) {
          const pact = record(value);
          const rawId = pact && (identifier(pact.id) ?? text(pact.name));
          const id = rawId?.startsWith("season:pact:") ? rawId.slice("season:pact:".length) : rawId;
          if (pact !== undefined && id !== undefined) {
            addNode(nodes, edges, entry, nativeNode(`season:pact:${id}`, "skills", "pact", pact), existingNodeIds);
          }
        }
        claims.push(...nativeClaims(entry.data.conditionClaims), ...nativeClaims(season.conditionClaims));
      }
      return outputFor(nodes, edges, claims);
    },
  };
}

function passiveAdapter(): MechanicAdapter {
  return {
    id: "advanced-passives-native",
    version: 1,
    priority: 105,
    minRuleset: "3.29",
    maxRuleset: "3.29",
    supports: (context) => supportsActorSeasonRuleset(context.ruleset)
      && sourceEntries(context, ["tree", "actor"]).some((entry) => {
        const season = seasonObject(entry);
        return record(entry.data.timeless) !== undefined
          || Array.isArray(entry.data.overrides)
          || Array.isArray(entry.data.tattoos)
          || Array.isArray(entry.data.runegrafts)
          || record(season.timeless) !== undefined
          || Array.isArray(season.overrides)
          || Array.isArray(season.tattoos)
          || Array.isArray(season.runegrafts);
      }),
    apply: (context) => {
      const nodes: DomainNode[] = [];
      const edges: DomainEdge[] = [];
      const existingNodeIds = new Set(context.graph.nodes.map((node) => node.id));
      for (const entry of sourceEntries(context, ["tree", "actor"])) {
        const season = seasonObject(entry);
        const timeless = record(entry.data.timeless) ?? record(season.timeless);
        if (timeless !== undefined) {
          const id = identifier(timeless.id) ?? identifier(timeless.jewelTypeId) ?? "selected";
          addNode(nodes, edges, entry, nativeNode(`season:timeless:${id}`, "tree", "timeless", timeless), existingNodeIds);
        }
        for (const [field, kind] of [["overrides", "passiveOverride"], ["tattoos", "tattoo"], ["runegrafts", "runegraft"]] as const) {
          const values = Array.isArray(entry.data[field]) ? entry.data[field] : Array.isArray(season[field]) ? season[field] : [];
          for (const value of values) {
            const parsed = record(value);
            if (parsed === undefined) continue;
            const id = identifier(parsed.id) ?? identifier(parsed.nodeId) ?? text(parsed.dn);
            if (id === undefined) continue;
            addNode(nodes, edges, entry, nativeNode(`season:${kind}:${id}`, "tree", kind, parsed), existingNodeIds);
          }
        }
      }
      return outputFor(nodes, edges, []);
    },
  };
}

function equipmentAdapter(): MechanicAdapter {
  const equipmentRecords = (entry: ContentCatalogEntry): RecordValue[] => {
    const records: RecordValue[] = [];
    if (Array.isArray(entry.data.items)) {
      for (const value of entry.data.items) {
        const item = record(value);
        if (item !== undefined) records.push(item);
      }
    }
    const seasonalItems = record(seasonObject(entry).items);
    if (seasonalItems !== undefined) {
      for (const [bucket, values] of Object.entries(seasonalItems)) {
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          const item = record(value);
          if (item !== undefined) records.push({
            ...item,
            type: item.type ?? (bucket === "grafts" ? "Graft" : bucket === "tinctures" ? "Tincture" : undefined),
            foulborn: item.foulborn === true || bucket === "foulborn",
          });
        }
      }
    }
    return records;
  };
  return {
    id: "equipment-seasonal",
    version: 1,
    priority: 105,
    minRuleset: "3.29",
    maxRuleset: "3.29",
    supports: (context) => supportsActorSeasonRuleset(context.ruleset)
      && sourceEntries(context, ["gear", "actor"]).some((entry) => equipmentRecords(entry).some((value) =>
        value.type === "Graft" || value.type === "Tincture" || value.foulborn === true)),
    apply: (context) => {
      const nodes: DomainNode[] = [];
      const edges: DomainEdge[] = [];
      const existingNodeIds = new Set(context.graph.nodes.map((node) => node.id));
      for (const entry of sourceEntries(context, ["gear", "actor"])) {
        for (const item of equipmentRecords(entry)) {
          const type = item.type === "Graft" ? "graft" : item.type === "Tincture" ? "tincture" : item.foulborn === true ? "foulborn" : undefined;
          if (type === undefined) continue;
          const itemId = text(item.id) ?? text(item.itemId);
          if (itemId === undefined) continue;
          addNode(nodes, edges, entry, nativeNode(`season:${type}:${itemId}`, "gear", type, {
            ...item,
            source: "Items",
          }), existingNodeIds);
        }
      }
      return outputFor(nodes, edges, []);
    },
  };
}

/** Pure, version-gated adapters for native actor and seasonal projections. */
export function createActorSeasonAdapters(): readonly MechanicAdapter[] {
  return [actorAdapter(), bloodlineAdapter(), pactAdapter(), passiveAdapter(), equipmentAdapter()];
}
