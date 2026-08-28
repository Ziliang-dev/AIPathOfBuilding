import type { Candidate, DeepLimits, ObjectiveSpec } from "../schemas.js";
import type {
  EvaluatedCandidate,
  HardConstraint,
  SearchObjective,
} from "./types.js";

const operatorMap = {
  ">=": "gte",
  ">": "gt",
  "<=": "lte",
  "<": "lt",
  "==": "eq",
} as const;

export function objectiveFromSchema(spec: ObjectiveSpec): SearchObjective {
  const constraints: HardConstraint[] = spec.hardConstraints.map((constraint, index) => ({
    id: `constraint:${index}:${constraint.metric}`,
    metric: constraint.metric,
    operator: operatorMap[constraint.operator],
    value: constraint.value,
    ...(constraint.scenario ? { scenarios: [constraint.scenario] } : {}),
  }));
  return {
    primaryMetric: spec.goals[0]?.metric ?? "TotalDPS",
    primaryScenario: spec.primaryScenario,
    metrics: spec.goals.map((goal) => ({
      key: goal.metric,
      direction: goal.direction,
      weight: goal.weight,
      role: inferMetricRole(goal.metric),
    })),
    scenarioWeights: spec.scenarioWeights,
    hardConstraints: constraints,
    candidatePolicy: {
      ...(spec.budgetDivine !== undefined ? { budgetDivine: spec.budgetDivine } : {}),
      sources: spec.candidateSources,
      locks: spec.locks,
    },
  };
}

export function candidateFromSchema(candidate: Candidate): EvaluatedCandidate {
  return {
    id: candidate.id,
    baseFingerprint: candidate.baseFingerprint,
    actions: candidate.actions,
    metricsByScenario: candidate.scenarioMetrics,
    estimatedCost: candidate.cost.divine,
    metadata: { label: candidate.label, summary: candidate.summary, publicCandidate: candidate },
  };
}

export function deepLimitsFromSchema(limits: DeepLimits): DeepLimits {
  return { ...limits };
}

function inferMetricRole(metric: string): "offence" | "defence" | "utility" {
  const normalized = metric.toLowerCase();
  if (/(dps|damage|speed|rate|crit)/u.test(normalized)) return "offence";
  if (/(ehp|maxhit|effectivehitpool|recovery|regen|leech|block|suppress|armour|armor|evasion|resist)/u.test(normalized)) {
    return "defence";
  }
  return "utility";
}
