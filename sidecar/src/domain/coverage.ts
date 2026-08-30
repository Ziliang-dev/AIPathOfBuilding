import { z } from "zod";
import type { ContentCatalogEntry } from "../schemas.js";

export const COVERAGE_DOMAINS = [
  "rules",
  "identity",
  "skills",
  "gear",
  "tree",
  "actor",
  "config",
  "external",
  "progression",
] as const;

export type CoverageDomain = (typeof COVERAGE_DOMAINS)[number];

export const CoverageRuleSchema = z.object({
  pattern: z.string().min(1),
  domain: z.enum(COVERAGE_DOMAINS),
  mechanicAdapterId: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
});
export type CoverageRule = z.infer<typeof CoverageRuleSchema>;

export const CoverageExclusionSchema = z.object({
  pattern: z.string().min(1),
  reason: z.string().min(1),
});
export type CoverageExclusion = z.infer<typeof CoverageExclusionSchema>;

export interface CoverageClassification {
  readonly path: string;
  readonly domain?: CoverageDomain;
  readonly mechanicAdapterId?: string;
  readonly excluded: boolean;
  readonly reason?: string;
  readonly rule?: CoverageRule;
}

export interface CoverageAudit {
  readonly classified: readonly CoverageClassification[];
  readonly excluded: readonly CoverageClassification[];
  readonly unclassified: readonly string[];
  readonly complete: boolean;
}

export class CoverageGapError extends Error {
  public constructor(public readonly paths: readonly string[]) {
    super(`Unclassified gameplay fields: ${paths.join(", ")}`);
    this.name = "CoverageGapError";
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

function matches(pattern: string, path: string): boolean {
  const patternSegments = normalizePath(pattern);
  const pathSegments = normalizePath(path);
  const visit = (patternIndex: number, pathIndex: number): boolean => {
    if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
    const patternSegment = patternSegments[patternIndex];
    if (patternSegment === "**") {
      if (patternIndex === patternSegments.length - 1) return true;
      for (let index = pathIndex; index <= pathSegments.length; index += 1) {
        if (visit(patternIndex + 1, index)) return true;
      }
      return false;
    }
    if (pathIndex >= pathSegments.length) return false;
    if (patternSegment !== "*" && patternSegment !== pathSegments[pathIndex]) return false;
    return visit(patternIndex + 1, pathIndex + 1);
  };
  return visit(0, 0);
}

function specificity(pattern: string): number {
  return normalizePath(pattern).reduce((score, segment) => {
    if (segment === "**") return score;
    if (segment === "*") return score + 1;
    return score + 4;
  }, 0);
}

export class CoverageRegistry {
  readonly #rules: CoverageRule[] = [];
  readonly #exclusions: CoverageExclusion[] = [];

  public register(rule: CoverageRule): this {
    const parsed = CoverageRuleSchema.parse(rule);
    if (this.#rules.some((current) => current.pattern === parsed.pattern)) {
      throw new Error(`Coverage pattern already registered: ${parsed.pattern}`);
    }
    this.#rules.push(parsed);
    return this;
  }

  public exclude(exclusion: CoverageExclusion): this {
    const parsed = CoverageExclusionSchema.parse(exclusion);
    if (this.#exclusions.some((current) => current.pattern === parsed.pattern)) {
      throw new Error(`Coverage exclusion already registered: ${parsed.pattern}`);
    }
    this.#exclusions.push(parsed);
    return this;
  }

  public classify(path: string): CoverageClassification {
    const exclusion = this.#exclusions
      .filter((entry) => matches(entry.pattern, path))
      .sort((left, right) => specificity(right.pattern) - specificity(left.pattern))[0];
    if (exclusion !== undefined) {
      return { path, excluded: true, reason: exclusion.reason };
    }

    const rule = this.#rules
      .filter((entry) => matches(entry.pattern, path))
      .sort((left, right) => specificity(right.pattern) - specificity(left.pattern))[0];
    if (rule === undefined) return { path, excluded: false };
    return {
      path,
      domain: rule.domain,
      ...(rule.mechanicAdapterId === undefined ? {} : { mechanicAdapterId: rule.mechanicAdapterId }),
      excluded: false,
      rule,
    };
  }

  public audit(paths: readonly string[]): CoverageAudit {
    const classifications = [...new Set(paths)].sort().map((path) => this.classify(path));
    const classified = classifications.filter((entry) => entry.domain !== undefined);
    const excluded = classifications.filter((entry) => entry.excluded);
    const unclassified = classifications
      .filter((entry) => !entry.excluded && entry.domain === undefined)
      .map((entry) => entry.path);
    return { classified, excluded, unclassified, complete: unclassified.length === 0 };
  }

  public auditCatalog(entries: readonly ContentCatalogEntry[]): CoverageAudit {
    return this.audit(entries.map((entry) => `${entry.domain}.${entry.kind}.${entry.id}`));
  }

  public assertComplete(paths: readonly string[]): CoverageAudit {
    const audit = this.audit(paths);
    if (!audit.complete) throw new CoverageGapError(audit.unclassified);
    return audit;
  }

  public rules(): readonly CoverageRule[] {
    return this.#rules.map((rule) => ({ ...rule }));
  }
}

/** Default classification for gameplay-relevant Build:SaveDB state. */
export function createDefaultCoverageRegistry(): CoverageRegistry {
  const registry = new CoverageRegistry();

  registry
    .exclude({ pattern: "Calcs.**", reason: "Derived calculator output" })
    .exclude({ pattern: "Notes.**", reason: "User prose is not gameplay state" })
    .exclude({ pattern: "TreeView.**", reason: "Passive-tree viewport state" })
    .exclude({ pattern: "Import.**", reason: "Import metadata is not active build state" })
    .exclude({ pattern: "Build.FullDPSSkill.**", reason: "Derived calculator output" })
    .exclude({ pattern: "Build.PlayerStat.**", reason: "Derived calculator output" })
    .exclude({ pattern: "Build.MinionStat.**", reason: "Derived calculator output" })
    .exclude({ pattern: "UI.**", reason: "Presentation state" })
    .exclude({ pattern: "*.viewMode", reason: "Presentation state" });

  const rules: readonly CoverageRule[] = [
    { pattern: "Build", domain: "identity" },
    { pattern: "Config", domain: "config" },
    { pattern: "Party", domain: "actor" },
    { pattern: "Tree", domain: "tree" },
    { pattern: "Items", domain: "gear" },
    { pattern: "Skills", domain: "skills" },
    { pattern: "rules.**", domain: "rules" },
    { pattern: "identity.**", domain: "identity" },
    { pattern: "skills.**", domain: "skills" },
    { pattern: "gear.**", domain: "gear" },
    { pattern: "tree.**", domain: "tree" },
    { pattern: "actor.**", domain: "actor" },
    { pattern: "config.**", domain: "config" },
    { pattern: "external.**", domain: "external" },
    { pattern: "progression.**", domain: "progression" },
    { pattern: "Build.targetVersion", domain: "rules" },
    { pattern: "Build.gameVersion", domain: "rules" },
    { pattern: "Build.league", domain: "rules" },
    { pattern: "Build.mode", domain: "rules" },
    { pattern: "Build.level", domain: "identity" },
    { pattern: "Build.characterLevelAutoMode", domain: "identity" },
    { pattern: "Build.className", domain: "identity" },
    { pattern: "Build.ascendClassName", domain: "identity" },
    { pattern: "Build.bandit", domain: "identity" },
    { pattern: "Build.pantheonMajorGod", domain: "identity" },
    { pattern: "Build.pantheonMinorGod", domain: "identity" },
    { pattern: "Build.**", domain: "identity" },
    { pattern: "Build.bloodline", domain: "identity", mechanicAdapterId: "bloodline" },
    { pattern: "Build.bloodline.**", domain: "identity", mechanicAdapterId: "bloodline" },
    { pattern: "Build.pacts", domain: "identity", mechanicAdapterId: "pacts" },
    { pattern: "Build.pacts.**", domain: "identity", mechanicAdapterId: "pacts" },
    { pattern: "Build.mainSocketGroup", domain: "skills" },
    { pattern: "Build.Spectre.**", domain: "actor", mechanicAdapterId: "actor-mechanics" },
    { pattern: "Build.TimelessData.**", domain: "tree", mechanicAdapterId: "advanced-passives" },
    { pattern: "Skills.**", domain: "skills" },
    { pattern: "Items.**", domain: "gear" },
    { pattern: "Tree.**", domain: "tree" },
    { pattern: "Party.**", domain: "actor" },
    { pattern: "Actors.**", domain: "actor" },
    { pattern: "Config.**", domain: "config" },
    { pattern: "Trade.**", domain: "external" },
    { pattern: "External.**", domain: "external" },
    { pattern: "Progression.**", domain: "progression" },
    { pattern: "Planner.**", domain: "progression" },
    { pattern: "AIPlanner.**", domain: "progression" },
  ];
  for (const rule of rules) registry.register(rule);
  return registry;
}
