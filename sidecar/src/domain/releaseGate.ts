import { z } from "zod";
import {
  BuildActionSchema,
  BuildSnapshotSchema,
  ContentCatalogEntrySchema,
  MetricSetSchema,
  type BuildSnapshot,
  type MetricSet,
} from "../schemas.js";
import { CoverageRegistry, type CoverageDomain } from "./coverage.js";
import { assertValidDomainGraph } from "./graph.js";
import {
  SEARCH_DOMAINS,
  type SearchCandidate,
  type SearchDomain,
} from "../search/types.js";

/** Version of the on-disk Golden corpus manifest, independent from RPC schemas. */
export const GOLDEN_CORPUS_SCHEMA_VERSION = 2 as const;
export const GOLDEN_PROJECTION_SCHEMA_VERSION = 1 as const;

export const GOLDEN_SCENARIO_IDS = [
  "mapping",
  "standardBoss",
  "pinnacle",
  "uber",
] as const;
export type GoldenScenarioId = (typeof GOLDEN_SCENARIO_IDS)[number];
export const GoldenScenarioIdSchema = z.enum(GOLDEN_SCENARIO_IDS);

export const GoldenMetricExpectationSchema = z.object({
  value: z.number().finite(),
  absTolerance: z.number().finite().nonnegative().default(1e-6),
  relTolerance: z.number().finite().nonnegative().default(1e-4),
});
export type GoldenMetricExpectation = z.infer<typeof GoldenMetricExpectationSchema>;

export const GoldenFieldPolicySchema = z.object({
  pattern: z.string().min(1),
  domain: z.enum([
    "rules",
    "identity",
    "skills",
    "gear",
    "tree",
    "actor",
    "config",
    "external",
    "progression",
  ]),
  policy: z.enum(["searchable", "nonSearchable"]),
  mechanicAdapterId: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});
export type GoldenFieldPolicy = z.infer<typeof GoldenFieldPolicySchema>;

export const GoldenCandidateRequirementSchema = z.object({
  domain: z.enum(SEARCH_DOMAINS),
  minCandidates: z.number().int().nonnegative().default(1),
  actionKinds: z.array(z.string().min(1)).default([]),
});
export type GoldenCandidateRequirement = z.infer<typeof GoldenCandidateRequirementSchema>;

export const GoldenScenarioMetricsSchema = z.object({
  mapping: z.record(z.string().min(1), GoldenMetricExpectationSchema).default({}),
  standardBoss: z.record(z.string().min(1), GoldenMetricExpectationSchema).default({}),
  pinnacle: z.record(z.string().min(1), GoldenMetricExpectationSchema).default({}),
  uber: z.record(z.string().min(1), GoldenMetricExpectationSchema).default({}),
});

export const GoldenProjectionFixtureSchema = z.object({
  schemaVersion: z.literal(GOLDEN_PROJECTION_SCHEMA_VERSION),
  ruleset: z.enum(["3_29", "3_29_ruthless"]),
  gameplayFieldPaths: z.array(z.string().min(1)).min(1),
  contentCatalog: z.array(ContentCatalogEntrySchema).min(1),
  candidates: z.array(z.object({
    domain: z.enum(SEARCH_DOMAINS),
    actions: z.array(BuildActionSchema).min(1),
  })).min(1),
});
export type GoldenProjectionFixture = z.infer<typeof GoldenProjectionFixtureSchema>;

export const GoldenBuildSpecSchema = z.object({
  id: z.string().min(1),
  variant: z.enum(["standard", "ruthless"]),
  ruleset: z.enum(["3_29", "3_29_ruthless"]),
  dataVersion: z.string().min(1),
  xmlPath: z.string().min(1),
  projectionPath: z.string().min(1),
  fieldPolicies: z.array(GoldenFieldPolicySchema).min(1),
  requiredMechanicAdapters: z.array(z.string().min(1)).default([]),
  requiredGraphNodeIds: z.array(z.string().min(1)).default([]),
  candidateRequirements: z.array(GoldenCandidateRequirementSchema).default([]),
  baselineMetrics: z.record(z.string().min(1), GoldenMetricExpectationSchema).default({}),
  scenarios: GoldenScenarioMetricsSchema.default({
    mapping: {},
    standardBoss: {},
    pinnacle: {},
    uber: {},
  }),
}).superRefine((spec, context) => {
  if (spec.xmlPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec.xmlPath)
    || spec.xmlPath.match(/(^|[\\/])\.\.([\\/]|$)/) !== null
    || !spec.xmlPath.toLowerCase().endsWith(".xml")) {
    context.addIssue({ code: "custom", message: "xmlPath must be a repository-relative XML file", path: ["xmlPath"] });
  }
  if (spec.projectionPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(spec.projectionPath)
    || spec.projectionPath.match(/(^|[\\/])\.\.([\\/]|$)/) !== null
    || !spec.projectionPath.toLowerCase().endsWith(".json")) {
    context.addIssue({ code: "custom", message: "projectionPath must be a repository-relative JSON file", path: ["projectionPath"] });
  }
  if ((spec.variant === "standard" && spec.ruleset !== "3_29")
    || (spec.variant === "ruthless" && spec.ruleset !== "3_29_ruthless")) {
    context.addIssue({ code: "custom", message: "variant and ruleset do not agree", path: ["ruleset"] });
  }
  const patterns = new Set<string>();
  for (const [index, policy] of spec.fieldPolicies.entries()) {
    if (patterns.has(policy.pattern)) {
      context.addIssue({ code: "custom", message: `duplicate field policy: ${policy.pattern}`, path: ["fieldPolicies", index, "pattern"] });
    }
    patterns.add(policy.pattern);
  }
  const domains = new Set<string>();
  for (const [index, requirement] of spec.candidateRequirements.entries()) {
    if (domains.has(requirement.domain)) {
      context.addIssue({ code: "custom", message: `duplicate candidate requirement: ${requirement.domain}`, path: ["candidateRequirements", index, "domain"] });
    }
    domains.add(requirement.domain);
  }
});
export type GoldenBuildSpec = z.infer<typeof GoldenBuildSpecSchema>;

export const GoldenCorpusManifestSchema = z.object({
  schemaVersion: z.literal(GOLDEN_CORPUS_SCHEMA_VERSION),
  corpusVersion: z.string().min(1),
  defaults: z.object({
    absTolerance: z.number().finite().nonnegative().default(1e-6),
    relTolerance: z.number().finite().nonnegative().default(1e-4),
  }).default({ absTolerance: 1e-6, relTolerance: 1e-4 }),
  builds: z.array(GoldenBuildSpecSchema).min(1),
}).superRefine((manifest, context) => {
  const ids = new Set<string>();
  for (const [index, build] of manifest.builds.entries()) {
    if (ids.has(build.id)) {
      context.addIssue({ code: "custom", message: `duplicate Golden build id: ${build.id}`, path: ["builds", index, "id"] });
    }
    ids.add(build.id);
  }
});
export type GoldenCorpusManifest = z.infer<typeof GoldenCorpusManifestSchema>;

export interface GoldenCaseRuntime<Action = unknown> {
  readonly id: string;
  readonly snapshot: BuildSnapshot;
  readonly appliedMechanicAdapterIds?: readonly string[];
  readonly candidatesByDomain?: Partial<Readonly<Record<SearchDomain, readonly SearchCandidate<Action>[]>>>;
  readonly baselineMetrics?: MetricSet;
  readonly scenarioMetrics?: Readonly<Partial<Record<GoldenScenarioId, MetricSet>>>;
}

export interface GoldenGateOptions {
  readonly coverageRegistry: CoverageRegistry;
  readonly registeredMechanicAdapterIds?: readonly string[];
  readonly registeredSearchDomains?: readonly SearchDomain[];
}

export interface GoldenCaseReport {
  readonly id: string;
  readonly ok: boolean;
  readonly failures: readonly string[];
}

export interface GoldenCorpusReport {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly cases: readonly GoldenCaseReport[];
}

export class GoldenGateError extends Error {
  public constructor(public readonly report: GoldenCorpusReport) {
    super(report.failures.join("; "));
    this.name = "GoldenGateError";
  }
}

function normalizePath(path: string): string[] {
  return path
    .replaceAll("[", ".")
    .replaceAll("]", "")
    .split(".")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function globMatches(pattern: string, path: string): boolean {
  const patternSegments = normalizePath(pattern);
  const pathSegments = normalizePath(path);
  const visit = (patternIndex: number, pathIndex: number): boolean => {
    if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
    const segment = patternSegments[patternIndex];
    if (segment === "**") {
      if (patternIndex === patternSegments.length - 1) return true;
      for (let index = pathIndex; index <= pathSegments.length; index += 1) {
        if (visit(patternIndex + 1, index)) return true;
      }
      return false;
    }
    if (pathIndex >= pathSegments.length) return false;
    if (segment !== "*" && segment !== pathSegments[pathIndex]) return false;
    return visit(patternIndex + 1, pathIndex + 1);
  };
  return visit(0, 0);
}

function policySpecificity(pattern: string): number {
  return normalizePath(pattern).reduce((score, segment) => {
    if (segment === "**") return score;
    if (segment === "*") return score + 1;
    return score + 4;
  }, 0);
}

function policyForPath(policies: readonly GoldenFieldPolicy[], path: string): GoldenFieldPolicy | undefined {
  return policies
    .filter((policy) => globMatches(policy.pattern, path))
    .sort((left, right) => policySpecificity(right.pattern) - policySpecificity(left.pattern))[0];
}

function adapterMatches(required: string, actual: readonly string[]): boolean {
  return actual.some((entry) => entry === required || entry.startsWith(`${required}@`));
}

function finiteMetricSet(value: MetricSet | undefined): MetricSet | undefined {
  if (value === undefined) return undefined;
  const parsed = MetricSetSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Returns true when an observed metric is within absolute or relative tolerance. */
export function metricMatches(actual: number, expected: GoldenMetricExpectation): boolean {
  if (!Number.isFinite(actual)) return false;
  const delta = Math.abs(actual - expected.value);
  const scale = Math.max(Math.abs(actual), Math.abs(expected.value));
  return delta <= expected.absTolerance || delta <= expected.relTolerance * scale;
}

function auditMetrics(
  label: string,
  expected: Readonly<Record<string, GoldenMetricExpectation>>,
  actual: MetricSet | undefined,
  failures: string[],
): void {
  const parsed = finiteMetricSet(actual);
  if (parsed === undefined) {
    failures.push(`${label}: metric set missing or invalid`);
    return;
  }
  for (const [key, expectation] of Object.entries(expected)) {
    const observed = parsed[key];
    if (observed === undefined) {
      failures.push(`${label}.${key}: metric missing`);
    } else if (!metricMatches(observed, expectation)) {
      failures.push(`${label}.${key}: expected ${expectation.value}, got ${observed}`);
    }
  }
}

function actionKind(action: unknown): string | undefined {
  if (action === null || typeof action !== "object" || Array.isArray(action)) return undefined;
  const kind = (action as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}

function auditCandidates<Action>(
  spec: GoldenBuildSpec,
  snapshot: BuildSnapshot,
  candidatesByDomain: Partial<Readonly<Record<SearchDomain, readonly SearchCandidate<Action>[]>>> | undefined,
  failures: string[],
): void {
  for (const domain of SEARCH_DOMAINS) {
    for (const candidate of candidatesByDomain?.[domain] ?? []) {
      if (candidate.domain !== undefined && candidate.domain !== domain) {
        failures.push(`${domain}/${candidate.id}: candidate domain mismatch`);
      }
      if (candidate.baseFingerprint !== snapshot.fingerprint) {
        failures.push(`${domain}/${candidate.id}: base fingerprint mismatch`);
      }
      if (candidate.actions.some((action) => !BuildActionSchema.safeParse(action).success)) {
        failures.push(`${domain}/${candidate.id}: contains invalid Build Action`);
      }
    }
  }
  const requirements = [...spec.candidateRequirements];
  for (const policy of spec.fieldPolicies) {
    if (policy.policy !== "searchable") continue;
    if (!requirements.some((requirement) => requirement.domain === policy.domain)) {
      failures.push(`searchable field policy ${policy.pattern} has no candidate requirement`);
    }
  }
  for (const requirement of requirements) {
    const candidates = candidatesByDomain?.[requirement.domain] ?? [];
    if (candidates.length < requirement.minCandidates) {
      failures.push(`${requirement.domain}: expected at least ${requirement.minCandidates} candidates, got ${candidates.length}`);
    }
    for (const kind of requirement.actionKinds) {
      if (!candidates.some((candidate) => candidate.actions.some((action) => actionKind(action) === kind))) {
        failures.push(`${requirement.domain}: candidate action kind ${kind} missing`);
      }
    }
  }
}

export function evaluateGoldenCase<Action>(
  specInput: GoldenBuildSpec,
  runtime: GoldenCaseRuntime<Action>,
  options: GoldenGateOptions,
): GoldenCaseReport {
  const spec = GoldenBuildSpecSchema.parse(specInput);
  const failures: string[] = [];
  if (runtime.id !== spec.id) failures.push(`runtime id ${runtime.id} does not match ${spec.id}`);

  const snapshotResult = BuildSnapshotSchema.safeParse(runtime.snapshot);
  if (!snapshotResult.success) {
    failures.push(`${spec.id}: snapshot schema invalid`);
    return { id: spec.id, ok: false, failures };
  }
  const snapshot = snapshotResult.data;
  if (snapshot.ruleset !== spec.ruleset) failures.push(`${spec.id}: ruleset mismatch`);
  if (snapshot.dataVersion !== spec.dataVersion) failures.push(`${spec.id}: dataVersion mismatch`);

  const coverage = options.coverageRegistry.audit(snapshot.gameplayFieldPaths);
  for (const path of coverage.unclassified) failures.push(`${spec.id}: unclassified gameplay field ${path}`);
  for (const path of snapshot.gameplayFieldPaths) {
    const classification = options.coverageRegistry.classify(path);
    if (classification.excluded) continue;
    const policy = policyForPath(spec.fieldPolicies, path);
    if (policy === undefined) {
      failures.push(`${spec.id}: field policy missing for ${path}`);
      continue;
    }
    if (classification.domain !== policy.domain) {
      failures.push(`${spec.id}: policy domain mismatch for ${path} (${policy.domain}/${classification.domain ?? "unclassified"})`);
    }
    if (policy.mechanicAdapterId !== undefined
      && classification.mechanicAdapterId !== policy.mechanicAdapterId) {
      failures.push(`${spec.id}: mechanic adapter mismatch for ${path}`);
    }
  }

  const registered = options.registeredMechanicAdapterIds ?? [];
  const applied = runtime.appliedMechanicAdapterIds ?? [];
  for (const adapter of spec.requiredMechanicAdapters) {
    if (!adapterMatches(adapter, registered)) failures.push(`${spec.id}: mechanic adapter not registered ${adapter}`);
    if (!adapterMatches(adapter, applied)) failures.push(`${spec.id}: mechanic adapter not applied ${adapter}`);
  }
  if (snapshot.buildGraph !== undefined) {
    try {
      assertValidDomainGraph(snapshot.buildGraph);
    } catch (error) {
      failures.push(`${spec.id}: invalid domain graph: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const graphNodeIds = new Set(snapshot.buildGraph?.nodes.map((node) => node.id) ?? []);
  for (const nodeId of spec.requiredGraphNodeIds) {
    if (!graphNodeIds.has(nodeId)) failures.push(`${spec.id}: required graph node missing ${nodeId}`);
  }

  auditCandidates(spec, snapshot, runtime.candidatesByDomain, failures);
  auditMetrics(spec.id, spec.baselineMetrics, runtime.baselineMetrics ?? snapshot.metrics, failures);
  const scenarioMetrics = runtime.scenarioMetrics;
  for (const scenario of GOLDEN_SCENARIO_IDS) {
    if (scenarioMetrics === undefined || scenarioMetrics[scenario] === undefined) {
      failures.push(`${spec.id}.${scenario}: sustainable scenario metrics missing`);
    }
    auditMetrics(`${spec.id}.${scenario}`, spec.scenarios[scenario], scenarioMetrics?.[scenario], failures);
  }

  return { id: spec.id, ok: failures.length === 0, failures };
}

export function evaluateGoldenCorpus<Action>(
  manifestInput: GoldenCorpusManifest,
  runtimes: readonly GoldenCaseRuntime<Action>[],
  options: GoldenGateOptions,
): GoldenCorpusReport {
  const manifest = GoldenCorpusManifestSchema.parse(manifestInput);
  const failures: string[] = [];
  if (options.registeredSearchDomains !== undefined) {
    for (const domain of SEARCH_DOMAINS) {
      if (!options.registeredSearchDomains.includes(domain)) failures.push(`search adapter missing: ${domain}`);
    }
  }
  const runtimeIds = new Set(runtimes.map((runtime) => runtime.id));
  const cases = manifest.builds.map((spec) => {
    const runtime = runtimes.find((candidate) => candidate.id === spec.id);
    if (runtime === undefined) {
      const failure = `${spec.id}: runtime fixture missing`;
      failures.push(failure);
      return { id: spec.id, ok: false, failures: [failure] };
    }
    const report = evaluateGoldenCase(spec, runtime, options);
    failures.push(...report.failures);
    return report;
  });
  for (const runtimeId of runtimeIds) {
    if (!manifest.builds.some((spec) => spec.id === runtimeId)) failures.push(`runtime fixture not in manifest: ${runtimeId}`);
  }
  return { ok: failures.length === 0, failures, cases };
}

export function assertGoldenCorpus<Action>(
  manifest: GoldenCorpusManifest,
  runtimes: readonly GoldenCaseRuntime<Action>[],
  options: GoldenGateOptions,
): GoldenCorpusReport {
  const report = evaluateGoldenCorpus(manifest, runtimes, options);
  if (!report.ok) throw new GoldenGateError(report);
  return report;
}

/** Useful for callers that need to validate a corpus before executing it. */
export function parseGoldenCorpusManifest(input: unknown): GoldenCorpusManifest {
  return GoldenCorpusManifestSchema.parse(input);
}

export type GoldenPolicyDomain = CoverageDomain;
