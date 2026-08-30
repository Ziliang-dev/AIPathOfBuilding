import { BuildGraphSchema, type ContentCatalogEntry } from "../schemas.js";
import {
  CoverageRegistry,
  type CoverageRule,
} from "./coverage.js";
import {
  ConditionClaimSchema,
  ConditionTriggerSchema,
  type ConditionClaimInput,
} from "./evidence.js";
import {
  DomainGraph,
  type DomainEdge,
  type DomainNode,
} from "./graph.js";
import { createActorSeasonAdapters } from "./actor-season.js";

export interface MechanicAdapterContext {
  readonly ruleset: string;
  readonly dataVersion: string;
  readonly catalog: readonly ContentCatalogEntry[];
  readonly graph: Readonly<ReturnType<DomainGraph["toJSON"]>>;
}

export interface MechanicAdapterOutput {
  readonly nodes?: readonly DomainNode[];
  readonly edges?: readonly DomainEdge[];
  readonly conditionClaims?: readonly ConditionClaimInput[];
  readonly coverage?: readonly Omit<CoverageRule, "mechanicAdapterId">[];
}

export interface MechanicAdapter {
  readonly id: string;
  readonly version: number;
  readonly priority?: number;
  readonly minRuleset?: string;
  readonly maxRuleset?: string;
  supports?(context: MechanicAdapterContext): boolean;
  apply(context: MechanicAdapterContext): MechanicAdapterOutput;
}

export interface AppliedMechanics {
  readonly graph: DomainGraph;
  readonly conditionClaims: readonly ConditionClaimInput[];
  readonly appliedAdapterIds: readonly string[];
}

function versionParts(value: string): number[] {
  return [...value.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

/** Compares PoE-style rulesets such as 3.29 without assuming semantic-version packaging. */
export function compareRulesets(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (leftParts.length > 0 || rightParts.length > 0) return 0;
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true });
}

function isRulesetSupported(adapter: MechanicAdapter, ruleset: string): boolean {
  if (adapter.minRuleset !== undefined && compareRulesets(ruleset, adapter.minRuleset) < 0) {
    return false;
  }
  if (adapter.maxRuleset !== undefined && compareRulesets(ruleset, adapter.maxRuleset) > 0) {
    return false;
  }
  return true;
}

export class MechanicAdapterRegistry {
  readonly #adapters = new Map<string, MechanicAdapter>();

  public register(adapter: MechanicAdapter): this {
    if (adapter.id.trim().length === 0) throw new Error("Mechanic adapter id is required");
    if (!Number.isInteger(adapter.version) || adapter.version < 1) {
      throw new Error(`Mechanic adapter version must be a positive integer: ${adapter.id}`);
    }
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Mechanic adapter already registered: ${adapter.id}`);
    }
    this.#adapters.set(adapter.id, adapter);
    return this;
  }

  public resolve(context: MechanicAdapterContext): readonly MechanicAdapter[] {
    return [...this.#adapters.values()]
      .filter((adapter) => isRulesetSupported(adapter, context.ruleset))
      .filter((adapter) => adapter.supports?.(context) ?? true)
      .sort((left, right) =>
        (right.priority ?? 0) - (left.priority ?? 0)
        || left.id.localeCompare(right.id));
  }

  public apply(
    baseGraph: DomainGraph,
    context: Omit<MechanicAdapterContext, "graph">,
    coverageRegistry?: CoverageRegistry,
  ): AppliedMechanics {
    const graph = new DomainGraph(baseGraph.toJSON());
    const conditionClaims: ConditionClaimInput[] = [];
    const appliedAdapterIds: string[] = [];
    const resolved = this.resolve({ ...context, graph: graph.toJSON() });

    for (const adapter of resolved) {
      const output = adapter.apply({ ...context, graph: graph.toJSON() });
      for (const node of output.nodes ?? []) graph.addNode(node);
      for (const edge of output.edges ?? []) graph.addEdge(edge);
      conditionClaims.push(...(output.conditionClaims ?? []).map((claim) =>
        ConditionClaimSchema.parse(claim)));
      for (const rule of output.coverage ?? []) {
        coverageRegistry?.register({ ...rule, mechanicAdapterId: adapter.id });
      }
      appliedAdapterIds.push(`${adapter.id}@${adapter.version}`);
    }

    return { graph, conditionClaims, appliedAdapterIds };
  }
}

export interface DeclarativeMechanicAdapterSpec {
  readonly id: string;
  readonly version: number;
  readonly priority?: number;
  readonly minRuleset?: string;
  readonly maxRuleset?: string;
  readonly catalogPredicate: (entry: ContentCatalogEntry) => boolean;
  readonly expand: (
    entries: readonly ContentCatalogEntry[],
    context: MechanicAdapterContext,
  ) => MechanicAdapterOutput;
}

/** Builds a versioned adapter around a catalog selection and a pure expansion hook. */
export function createDeclarativeMechanicAdapter(
  spec: DeclarativeMechanicAdapterSpec,
): MechanicAdapter {
  return {
    id: spec.id,
    version: spec.version,
    ...(spec.priority === undefined ? {} : { priority: spec.priority }),
    ...(spec.minRuleset === undefined ? {} : { minRuleset: spec.minRuleset }),
    ...(spec.maxRuleset === undefined ? {} : { maxRuleset: spec.maxRuleset }),
    supports: (context) => context.catalog.some(spec.catalogPredicate),
    apply: (context) => spec.expand(context.catalog.filter(spec.catalogPredicate), context),
  };
}

const CatalogRelationSchema = BuildGraphSchema.shape.edges.element.omit({ from: true });

function catalogText(entry: ContentCatalogEntry): string {
  return `${entry.id} ${entry.kind} ${entry.name ?? ""}`.toLowerCase();
}

function expandCatalogEntries(
  entries: readonly ContentCatalogEntry[],
  context: MechanicAdapterContext,
): MechanicAdapterOutput {
  const existingNodes = new Set(context.graph.nodes.map((node) => node.id));
  const nodes = entries
    .filter((entry) => !existingNodes.has(entry.id))
    .map((entry): DomainNode => ({
      id: entry.id,
      domain: entry.domain,
      kind: entry.kind,
      data: {
        ...entry.data,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        available: entry.available,
      },
    }));
  const edges: DomainEdge[] = [];
  const existingEdges = new Set(context.graph.edges.map((edge) =>
    `${edge.from}:${edge.relation}:${edge.to}`));
  for (const entry of entries) {
    const rawRelations = entry.data.relations;
    if (!Array.isArray(rawRelations)) continue;
    for (const relation of rawRelations) {
      const parsed = CatalogRelationSchema.safeParse(relation);
      if (parsed.success) {
        const key = `${entry.id}:${parsed.data.relation}:${parsed.data.to}`;
        if (!existingEdges.has(key)) {
          edges.push({ from: entry.id, ...parsed.data });
          existingEdges.add(key);
        }
      }
    }
  }
  return { nodes, edges };
}

function keywordAdapter(
  id: string,
  domain: ContentCatalogEntry["domain"],
  keywords: readonly string[],
): MechanicAdapter {
  return createDeclarativeMechanicAdapter({
    id,
    version: 1,
    catalogPredicate: (entry) => entry.domain === domain
      && keywords.some((keyword) => catalogText(entry).includes(keyword)),
    expand: expandCatalogEntries,
  });
}

function conditionClaimsFromCatalog(
  entries: readonly ContentCatalogEntry[],
): ConditionClaimInput[] {
  const claims: ConditionClaimInput[] = [];
  for (const entry of entries) {
    const rawClaims = entry.data.conditionClaims;
    if (!Array.isArray(rawClaims)) continue;
    for (const raw of rawClaims) {
      const direct = ConditionClaimSchema.safeParse(raw);
      const nativeShape = raw !== null && typeof raw === "object" && !Array.isArray(raw)
        && ("sources" in raw || "manual" in raw || "configKey" in raw);
      if (direct.success && nativeShape) {
        claims.push({
          ...direct.data,
          configKey: direct.data.configKey ?? direct.data.condition,
        });
        continue;
      }
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      if (typeof value.condition !== "string" || value.condition.length === 0) continue;
      const sourceStatus = typeof value.sourceStatus === "string" ? value.sourceStatus : "unknown";
      const sourceId = typeof value.source === "string" && value.source.length > 0
        ? value.source
        : undefined;
      const triggerValue = sourceStatus === "manual" ? "manual" : value.trigger;
      const trigger = ConditionTriggerSchema.safeParse(triggerValue);
      const uptime = typeof value.uptime === "number" && Number.isFinite(value.uptime)
        ? Math.max(0, Math.min(1, value.uptime))
        : undefined;
      const sourceProven = sourceStatus === "proven_sustainable"
        || sourceStatus === "proven_peak"
        || sourceStatus === "intermittent";
      const parsed = ConditionClaimSchema.parse({
        condition: value.condition,
        configKey: typeof value.configKey === "string" ? value.configKey : value.condition,
        value: value.value ?? true,
        manual: value.manual === true || sourceStatus === "manual",
        conflictsWith: Array.isArray(value.conflictsWith) ? value.conflictsWith : [],
        sources: sourceId !== undefined && trigger.success && (sourceProven || trigger.data === "manual")
          ? [{
              id: sourceId,
              trigger: trigger.data,
              triggerChain: Array.isArray(value.triggerChain) ? value.triggerChain : [],
              ...(uptime === undefined ? {} : { uptime }),
              peakOnly: sourceStatus === "proven_peak",
              resourcesSustainable: sourceStatus !== "proven_peak",
            }]
          : [],
      });
      claims.push(parsed);
    }
  }
  return claims;
}

function configurationEvidenceAdapter(): MechanicAdapter {
  return createDeclarativeMechanicAdapter({
    id: "configuration-evidence",
    version: 1,
    catalogPredicate: (entry) => entry.domain === "config" && Array.isArray(entry.data.conditionClaims),
    expand: (entries) => ({ conditionClaims: conditionClaimsFromCatalog(entries) }),
  });
}

/** Versioned adapters for content that commonly needs rules beyond generic PoB fields. */
export function createDefaultMechanicAdapterRegistry(): MechanicAdapterRegistry {
  const registry = new MechanicAdapterRegistry()
    .register(configurationEvidenceAdapter())
    .register(keywordAdapter("identity-mechanics", "identity", [
      "ascend", "bloodline", "pact", "bandit", "pantheon",
    ]))
    .register(keywordAdapter("advanced-passives", "tree", [
      "cluster", "mastery", "timeless", "tattoo", "runegraft", "anoint",
    ]))
    .register(keywordAdapter("skill-mechanics", "skills", [
      "vaal", "transfigured", "awakened", "imbued", "trigger", "reservation", "rotation",
    ]))
    .register(keywordAdapter("equipment-mechanics", "gear", [
      "flask", "tincture", "graft", "foulborn", "jewel", "guardian",
    ]))
    .register(keywordAdapter("actor-mechanics", "actor", [
      "minion", "spectre", "guardian", "party", "aura", "buff",
    ]));
  for (const adapter of createActorSeasonAdapters()) registry.register(adapter);
  return registry;
}
