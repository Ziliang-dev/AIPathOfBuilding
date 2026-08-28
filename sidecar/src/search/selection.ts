import { directed, objectiveMetricValue, worstScenarioMetric } from "./metrics.js";
import type {
  CandidateSelections,
  EvaluatedCandidate,
  MetricSpec,
  SearchObjective,
} from "./types.js";

interface Range {
  readonly min: number;
  readonly max: number;
}

function stableBest<Action>(
  candidates: readonly EvaluatedCandidate<Action>[],
  value: (candidate: EvaluatedCandidate<Action>) => number,
): EvaluatedCandidate<Action> | undefined {
  return [...candidates].sort((left, right) => {
    const difference = value(right) - value(left);
    return difference || left.id.localeCompare(right.id);
  })[0];
}

function metricRange<Action>(
  candidates: readonly EvaluatedCandidate<Action>[],
  metric: MetricSpec,
  objective: SearchObjective,
): Range | undefined {
  const values = candidates
    .map((candidate) => objectiveMetricValue(candidate, metric, objective))
    .filter((value): value is number => value !== undefined);
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : undefined;
}

function normalizedUtility(value: number, range: Range, metric: MetricSpec): number {
  if (range.max === range.min) return 1;
  const ascending = (value - range.min) / (range.max - range.min);
  return metric.direction === "maximize" ? ascending : 1 - ascending;
}

export function selectCandidates<Action>(
  candidates: readonly EvaluatedCandidate<Action>[],
  objective: SearchObjective,
  sustainableScenarios: readonly string[],
): CandidateSelections<Action> {
  if (!candidates.length) return {};
  const ranges = new Map(objective.metrics.map((metric) => [metric.key, metricRange(candidates, metric, objective)]));
  const primary = objective.metrics.find((metric) => metric.key === objective.primaryMetric) ?? objective.metrics[0];
  const defenceMetrics = objective.metrics.filter((metric) => metric.role === "defence");

  const score = (candidate: EvaluatedCandidate<Action>, metrics: readonly MetricSpec[]): number => {
    let total = 0;
    let weights = 0;
    for (const metric of metrics) {
      const value = objectiveMetricValue(candidate, metric, objective);
      const range = ranges.get(metric.key);
      if (value === undefined || !range) continue;
      const weight = metric.weight ?? 1;
      total += normalizedUtility(value, range, metric) * weight;
      weights += weight;
    }
    return weights ? total / weights : Number.NEGATIVE_INFINITY;
  };

  const offence = stableBest(candidates, (candidate) => {
    if (!primary) return Number.NEGATIVE_INFINITY;
    const value = objectiveMetricValue(candidate, primary, objective);
    return value === undefined ? Number.NEGATIVE_INFINITY : directed(value, primary.direction);
  });

  const balanced = stableBest(candidates, (candidate) => {
    let squaredDistance = 0;
    let weights = 0;
    for (const metric of objective.metrics) {
      const value = objectiveMetricValue(candidate, metric, objective);
      const range = ranges.get(metric.key);
      if (value === undefined || !range) return Number.NEGATIVE_INFINITY;
      const weight = metric.weight ?? 1;
      const distance = 1 - normalizedUtility(value, range, metric);
      squaredDistance += weight * distance * distance;
      weights += weight;
    }
    return weights ? -Math.sqrt(squaredDistance / weights) : Number.NEGATIVE_INFINITY;
  });

  const defence = stableBest(candidates, (candidate) => {
    if (!defenceMetrics.length) return score(candidate, objective.metrics);
    let total = 0;
    let weights = 0;
    for (const metric of defenceMetrics) {
      const value = worstScenarioMetric(candidate, metric, sustainableScenarios);
      if (value === undefined) return Number.NEGATIVE_INFINITY;
      const allWorstValues = candidates
        .map((entry) => worstScenarioMetric(entry, metric, sustainableScenarios))
        .filter((entry): entry is number => entry !== undefined);
      const range = { min: Math.min(...allWorstValues), max: Math.max(...allWorstValues) };
      const weight = metric.weight ?? 1;
      total += normalizedUtility(value, range, metric) * weight;
      weights += weight;
    }
    return weights ? total / weights : Number.NEGATIVE_INFINITY;
  });

  return {
    ...(offence ? { offence } : {}),
    ...(balanced ? { balanced } : {}),
    ...(defence ? { defence } : {}),
  };
}
