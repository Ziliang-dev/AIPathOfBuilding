import { EMPTY_PROJECTION_FINGERPRINT, emptyModifierProjection } from "./mechanicsFixture.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTOR_SEASON_ADAPTER_IDS,
  CoverageRegistry,
  DomainGraph,
  createDefaultMechanicAdapterRegistry,
  createDefaultCoverageRegistry,
} from "../src/domain/index.js";
import {
  GoldenCorpusManifestSchema,
  GoldenGateError,
  GoldenProjectionFixtureSchema,
  assertGoldenCorpus,
  evaluateGoldenCase,
  evaluateGoldenCorpus,
  metricMatches,
  type GoldenCaseRuntime,
  type GoldenCorpusManifest,
  type GoldenMetricExpectation,
} from "../src/domain/releaseGate.js";
import { SCHEMA_VERSION, type BuildSnapshot } from "../src/schemas.js";
import { SEARCH_DOMAINS } from "../src/search/types.js";

function loadManifest(): GoldenCorpusManifest {
  const manifestPath = resolve(process.cwd(), "../spec/AIPoBGolden/manifest.json");
  return GoldenCorpusManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
}

function firstSpec(manifest: GoldenCorpusManifest): GoldenCorpusManifest["builds"][number] {
  const spec = manifest.builds[0];
  if (spec === undefined) throw new Error("Golden corpus manifest has no builds");
  return spec;
}

function projectionFor(spec: GoldenCorpusManifest["builds"][number]) {
  const projectionPath = resolve(process.cwd(), "..", spec.projectionPath);
  return GoldenProjectionFixtureSchema.parse(JSON.parse(readFileSync(projectionPath, "utf8")));
}

function snapshotFor(
  spec: GoldenCorpusManifest["builds"][number],
  gameplayFieldPaths = [
    "Build.targetVersion",
    "Build.level",
    "Build.className",
    "Build.mainSocketGroup",
  ],
  buildGraph?: BuildSnapshot["buildGraph"],
): BuildSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    mechanicProjection: emptyModifierProjection(),
    mechanicProjectionFingerprint: EMPTY_PROJECTION_FINGERPRINT,
    xml: `<PathOfBuilding><Build targetVersion="3_0" /></PathOfBuilding>`,
    fingerprint: `fingerprint:${spec.id}`,
    engineVersion: "test-engine",
    dataVersion: spec.dataVersion,
    ruleset: spec.ruleset,
    metrics: { fullDps: 0 },
    config: {},
    buildState: {},
    gameplayFieldPaths,
    ...(buildGraph === undefined ? {} : { buildGraph }),
  };
}

function runtimeFor(spec: GoldenCorpusManifest["builds"][number]): GoldenCaseRuntime {
  const projection = projectionFor(spec);
  const registry = createDefaultMechanicAdapterRegistry();
  const applied = registry.apply(
    DomainGraph.fromCatalog(projection.contentCatalog),
    {
      ruleset: projection.ruleset,
      dataVersion: spec.dataVersion,
      catalog: projection.contentCatalog,
    },
  );
  const fingerprint = `fingerprint:${spec.id}`;
  const candidatesByDomain = Object.fromEntries(projection.candidates.map((candidate, index) => [
    candidate.domain,
    [{
      id: `golden:${spec.id}:${candidate.domain}:${index}`,
      domain: candidate.domain,
      baseFingerprint: fingerprint,
      actions: candidate.actions,
    }],
  ]));
  return {
    id: spec.id,
    snapshot: snapshotFor(spec, projection.gameplayFieldPaths, applied.graph.toJSON()),
    appliedMechanicAdapterIds: applied.appliedAdapterIds,
    candidatesByDomain,
    baselineMetrics: { fullDps: 0 },
    scenarioMetrics: {
      mapping: { fullDps: 0 },
      standardBoss: { fullDps: 0 },
      pinnacle: { fullDps: 0 },
      uber: { fullDps: 0 },
    },
  };
}

describe("Golden corpus release gate", () => {
  it("parses and audits the initial standard and ruthless fixtures", () => {
    const manifest = loadManifest();
    expect(manifest.builds.map((build) => build.ruleset)).toEqual(["3_29", "3_29_ruthless"]);
    const report = evaluateGoldenCorpus(
      manifest,
      manifest.builds.map(runtimeFor),
      {
        coverageRegistry: createDefaultCoverageRegistry(),
        registeredMechanicAdapterIds: ACTOR_SEASON_ADAPTER_IDS,
        registeredSearchDomains: SEARCH_DOMAINS,
      },
    );
    expect(report.ok).toBe(true);
    expect(report.cases).toHaveLength(2);
  });

  it("requires an explicit policy for every searchable field", () => {
    const manifest = loadManifest();
    const baseSpec = firstSpec(manifest);
    const spec = {
      ...baseSpec,
      fieldPolicies: [{
        pattern: "Build.**",
        domain: "identity" as const,
        policy: "searchable" as const,
      }],
      candidateRequirements: [],
    };
    const report = evaluateGoldenCase(spec, {
      ...runtimeFor(spec),
      candidatesByDomain: { identity: [] },
    }, { coverageRegistry: createDefaultCoverageRegistry() });
    expect(report.ok).toBe(false);
    expect(report.failures.some((failure) => failure.includes("candidate requirement"))).toBe(true);
  });

  it("rejects stale candidate fingerprints and invalid actions", () => {
    const manifest = loadManifest();
    const spec = firstSpec(manifest);
    const report = evaluateGoldenCase(spec, {
      ...runtimeFor(spec),
      candidatesByDomain: {
        gear: [{
          id: "candidate:gear:test",
          baseFingerprint: "stale",
          actions: [{
            id: "action:bad",
            kind: "not-a-build-action",
            description: "bad",
            payload: {},
          }],
        }],
      },
    }, { coverageRegistry: createDefaultCoverageRegistry() });
    expect(report.ok).toBe(false);
    expect(report.failures.join("\n")).toContain("base fingerprint mismatch");
    expect(report.failures.join("\n")).toContain("invalid Build Action");
  });

  it("checks graph validity, adapter application, and metric tolerance", () => {
    const manifest = loadManifest();
    const baseSpec = firstSpec(manifest);
    const spec = {
      ...baseSpec,
      requiredMechanicAdapters: ["seasonal@1"],
      requiredGraphNodeIds: [],
      baselineMetrics: {
        fullDps: { value: 100, absTolerance: 0, relTolerance: 0 },
      },
    };
    const runtime = {
      ...runtimeFor(spec),
      snapshot: {
        ...snapshotFor(spec),
        metrics: { fullDps: 100 },
        buildGraph: {
          nodes: [{ id: "node:a", domain: "config", kind: "condition", data: {} }],
          edges: [],
        },
      },
      baselineMetrics: { fullDps: 100 },
      appliedMechanicAdapterIds: ["seasonal@1"],
    } satisfies GoldenCaseRuntime;
    const report = evaluateGoldenCase(spec, runtime, {
      coverageRegistry: createDefaultCoverageRegistry(),
      registeredMechanicAdapterIds: ["seasonal@1"],
    });
    expect(report.ok).toBe(true);
  });

  it("exposes deterministic absolute/relative metric matching", () => {
    const expectation: GoldenMetricExpectation = {
      value: 10,
      absTolerance: 0.1,
      relTolerance: 0.01,
    };
    expect(metricMatches(10.05, expectation)).toBe(true);
    expect(metricMatches(10.2, expectation)).toBe(false);
  });

  it("throws a typed error for a failed corpus assertion", () => {
    const manifest = loadManifest();
    const runtime = runtimeFor(firstSpec(manifest));
    expect(() => assertGoldenCorpus(
        manifest,
        [{ ...runtime, id: "not-in-manifest" }],
        { coverageRegistry: new CoverageRegistry() },
      )).toThrow(GoldenGateError);
  });
});
