import {
  BuildGraphSchema,
  type BuildGraph,
  type ContentCatalogEntry,
} from "../schemas.js";

export const DOMAIN_RELATIONS = [
  "grants",
  "requires",
  "triggers",
  "scales",
  "consumes",
  "conflicts",
  "replaces",
  "usesSlot",
  "availableIn",
] as const;

export type DomainRelation = (typeof DOMAIN_RELATIONS)[number];
export type DomainNode = BuildGraph["nodes"][number];
export type DomainEdge = BuildGraph["edges"][number];

export interface GraphValidationIssue {
  readonly code:
    | "duplicate_node"
    | "duplicate_edge"
    | "missing_source"
    | "missing_target"
    | "self_relation"
    | "invalid_availability_target";
  readonly message: string;
  readonly nodeId?: string;
  readonly edge?: DomainEdge;
}

export class InvalidDomainGraphError extends Error {
  public constructor(public readonly issues: readonly GraphValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "InvalidDomainGraphError";
  }
}

function edgeKey(edge: DomainEdge): string {
  const relationKey = edge.relation === "conflicts"
    ? [edge.from, edge.to].sort().join("<->")
    : `${edge.from}->${edge.to}`;
  return `${relationKey}:${edge.relation}`;
}

/**
 * Validates graph-wide invariants that cannot be expressed by the wire schema.
 */
export function validateDomainGraph(input: BuildGraph): GraphValidationIssue[] {
  const graph = BuildGraphSchema.parse(input);
  const issues: GraphValidationIssue[] = [];
  const nodes = new Map<string, DomainNode>();

  for (const node of graph.nodes) {
    if (nodes.has(node.id)) {
      issues.push({
        code: "duplicate_node",
        message: `Duplicate domain node: ${node.id}`,
        nodeId: node.id,
      });
      continue;
    }
    nodes.set(node.id, node);
  }

  const edges = new Set<string>();
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from)) {
      issues.push({
        code: "missing_source",
        message: `Edge ${edge.relation} has missing source: ${edge.from}`,
        edge,
      });
    }
    if (!nodes.has(edge.to)) {
      issues.push({
        code: "missing_target",
        message: `Edge ${edge.relation} has missing target: ${edge.to}`,
        edge,
      });
    }
    if (edge.from === edge.to) {
      issues.push({
        code: "self_relation",
        message: `Self relation is not meaningful: ${edge.from} ${edge.relation}`,
        edge,
      });
    }

    const key = edgeKey(edge);
    if (edges.has(key)) {
      issues.push({
        code: "duplicate_edge",
        message: `Duplicate domain edge: ${key}`,
        edge,
      });
    }
    edges.add(key);

    const target = nodes.get(edge.to);
    if (edge.relation === "availableIn" && target !== undefined && target.domain !== "rules") {
      issues.push({
        code: "invalid_availability_target",
        message: `availableIn target must be in rules domain: ${edge.to}`,
        edge,
      });
    }
  }

  return issues;
}

export function assertValidDomainGraph(input: BuildGraph): BuildGraph {
  const graph = BuildGraphSchema.parse(input);
  const issues = validateDomainGraph(graph);
  if (issues.length > 0) {
    throw new InvalidDomainGraphError(issues);
  }
  return graph;
}

/**
 * Mutable builder with a small, immutable read surface. Wire data stays BuildGraph-compatible.
 */
export class DomainGraph {
  readonly #nodes = new Map<string, DomainNode>();
  readonly #edges = new Map<string, DomainEdge>();

  public constructor(input: BuildGraph = { nodes: [], edges: [] }) {
    const graph = assertValidDomainGraph(input);
    for (const node of graph.nodes) this.#nodes.set(node.id, structuredClone(node));
    for (const edge of graph.edges) this.#edges.set(edgeKey(edge), structuredClone(edge));
  }

  public static fromCatalog(entries: readonly ContentCatalogEntry[]): DomainGraph {
    const graph = new DomainGraph();
    for (const entry of entries) {
      graph.addNode({
        id: entry.id,
        domain: entry.domain,
        kind: entry.kind,
        data: {
          ...entry.data,
          ...(entry.name === undefined ? {} : { name: entry.name }),
          available: entry.available,
          ...(entry.kind === "currentBuild" ? { current: true } : {}),
        },
      });
    }
    const relationSchema = BuildGraphSchema.shape.edges.element.omit({ from: true });
    for (const entry of entries) {
      const relations = entry.data.relations;
      if (!Array.isArray(relations)) continue;
      for (const relation of relations) {
        const parsed = relationSchema.parse(relation);
        graph.addEdge({ from: entry.id, ...parsed });
      }
    }
    return graph;
  }

  public addNode(node: DomainNode): this {
    const parsed = BuildGraphSchema.shape.nodes.element.parse(node);
    if (this.#nodes.has(parsed.id)) {
      throw new InvalidDomainGraphError([{
        code: "duplicate_node",
        message: `Duplicate domain node: ${parsed.id}`,
        nodeId: parsed.id,
      }]);
    }
    this.#nodes.set(parsed.id, structuredClone(parsed));
    return this;
  }

  public addEdge(edge: DomainEdge): this {
    const parsed = BuildGraphSchema.shape.edges.element.parse(edge);
    const tentative = this.toJSON();
    tentative.edges.push(parsed);
    const issues = validateDomainGraph(tentative);
    if (issues.length > 0) throw new InvalidDomainGraphError(issues);
    this.#edges.set(edgeKey(parsed), structuredClone(parsed));
    return this;
  }

  public getNode(id: string): DomainNode | undefined {
    const node = this.#nodes.get(id);
    return node === undefined ? undefined : structuredClone(node);
  }

  public hasNode(id: string): boolean {
    return this.#nodes.has(id);
  }

  public related(
    id: string,
    relation?: DomainRelation,
    direction: "out" | "in" | "both" = "out",
  ): DomainNode[] {
    const relatedIds = new Set<string>();
    for (const edge of this.#edges.values()) {
      if (relation !== undefined && edge.relation !== relation) continue;
      const symmetric = edge.relation === "conflicts";
      if ((direction === "out" || direction === "both" || symmetric) && edge.from === id) {
        relatedIds.add(edge.to);
      }
      if ((direction === "in" || direction === "both" || symmetric) && edge.to === id) {
        relatedIds.add(edge.from);
      }
    }
    return [...relatedIds]
      .sort()
      .flatMap((nodeId) => {
        const node = this.#nodes.get(nodeId);
        return node === undefined ? [] : [structuredClone(node)];
      });
  }

  public toJSON(): BuildGraph {
    return {
      nodes: [...this.#nodes.values()].map((node) => structuredClone(node)),
      edges: [...this.#edges.values()].map((edge) => structuredClone(edge)),
    };
  }
}
