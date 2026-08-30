import { describe, expect, it } from "vitest";
import {
  DomainGraph,
  InvalidDomainGraphError,
  assertValidDomainGraph,
  validateDomainGraph,
} from "../src/domain/index.js";

describe("DomainGraph", () => {
  it("stores typed relationships and treats conflicts as symmetric", () => {
    const graph = new DomainGraph()
      .addNode({ id: "skill:main", domain: "skills", kind: "active", data: {} })
      .addNode({ id: "buff:rage", domain: "config", kind: "condition", data: {} })
      .addNode({ id: "buff:no-rage", domain: "config", kind: "condition", data: {} })
      .addEdge({
        from: "skill:main",
        to: "buff:rage",
        relation: "grants",
        data: {},
      })
      .addEdge({
        from: "buff:rage",
        to: "buff:no-rage",
        relation: "conflicts",
        data: {},
      });

    expect(graph.related("skill:main", "grants").map((node) => node.id)).toEqual(["buff:rage"]);
    expect(graph.related("buff:no-rage", "conflicts").map((node) => node.id)).toEqual(["buff:rage"]);
    expect(graph.toJSON().edges).toHaveLength(2);
  });

  it("rejects missing endpoints, duplicate logical edges, and invalid availability targets", () => {
    const invalid = {
      nodes: [
        { id: "skill", domain: "skills", kind: "active", data: {} },
        { id: "gear", domain: "gear", kind: "item", data: {} },
      ],
      edges: [
        { from: "skill", to: "missing", relation: "requires" as const, data: {} },
        { from: "skill", to: "gear", relation: "availableIn" as const, data: {} },
        { from: "skill", to: "gear", relation: "availableIn" as const, data: {} },
      ],
    };

    expect(validateDomainGraph(invalid).map((issue) => issue.code)).toEqual([
      "missing_target",
      "invalid_availability_target",
      "duplicate_edge",
      "invalid_availability_target",
    ]);
    expect(() => assertValidDomainGraph(invalid)).toThrow(InvalidDomainGraphError);
  });

  it("creates graph nodes from the normalized content catalog", () => {
    const graph = DomainGraph.fromCatalog([
      {
        id: "rules:current",
        domain: "rules",
        kind: "ruleset",
        available: true,
        data: {},
      },
      {
        id: "unique:example",
        domain: "gear",
        kind: "unique",
        name: "Example",
        available: true,
        data: {
          slot: "Body Armour",
          relations: [{ to: "rules:current", relation: "availableIn", data: {} }],
        },
      },
    ]);

    expect(graph.getNode("unique:example")).toEqual({
      id: "unique:example",
      domain: "gear",
      kind: "unique",
      data: {
        slot: "Body Armour",
        relations: [{ to: "rules:current", relation: "availableIn", data: {} }],
        name: "Example",
        available: true,
      },
    });
    expect(graph.related("unique:example", "availableIn").map((node) => node.id))
      .toEqual(["rules:current"]);
  });
});
