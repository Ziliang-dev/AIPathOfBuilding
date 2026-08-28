import type { EvaluatedCandidate, MetricSpec, SearchObjective } from "./types.js";

export function scenarioWeightedMetric<Action>(
  candidate: EvaluatedCandidate<Action>,
  metric: string,
  scenarioWeights: Readonly<Record<string, number>>,
): number | undefined {
  let weighted = 0;
  let totalWeight = 0;
  for (const [scenario, weight] of Object.entries(scenarioWeights)) {
    if (weight <= 0) continue;
    const value = candidate.metricsByScenario[scenario]?.[metric];
    if (value === undefined || !Number.isFinite(value)) return undefined;
    weighted += value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : undefined;
}

export function objectiveMetricValue<Action>(
  candidate: EvaluatedCandidate<Action>,
  metric: MetricSpec,
  objective: SearchObjective,
): number | undefined {
  return scenarioWeightedMetric(candidate, metric.key, objective.scenarioWeights);
}

export function worstScenarioMetric<Action>(
  candidate: EvaluatedCandidate<Action>,
  metric: MetricSpec,
  scenarios: readonly string[],
): number | undefined {
  const values = scenarios.map((scenario) => candidate.metricsByScenario[scenario]?.[metric.key]);
  if (values.some((value) => value === undefined || !Number.isFinite(value))) return undefined;
  const numbers = values as number[];
  return metric.direction === "maximize" ? Math.min(...numbers) : Math.max(...numbers);
}

export function directed(value: number, direction: MetricSpec["direction"]): number {
  return direction === "maximize" ? value : -value;
}
