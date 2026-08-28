import { evaluateConstraints } from "./constraints.js";
import { directed, objectiveMetricValue } from "./metrics.js";
import type { EvaluatedCandidate, SearchObjective } from "./types.js";

export function dominates<Action>(
  left: EvaluatedCandidate<Action>,
  right: EvaluatedCandidate<Action>,
  objective: SearchObjective,
): boolean {
  let strictlyBetter = false;
  for (const metric of objective.metrics) {
    const leftValue = objectiveMetricValue(left, metric, objective);
    const rightValue = objectiveMetricValue(right, metric, objective);
    if (leftValue === undefined || rightValue === undefined) return false;
    const l = directed(leftValue, metric.direction);
    const r = directed(rightValue, metric.direction);
    if (l < r) return false;
    if (l > r) strictlyBetter = true;
  }
  return strictlyBetter;
}

export class ParetoFrontier<Action = unknown> {
  readonly #objective: SearchObjective;
  readonly #scenarios: readonly string[];
  #candidates: EvaluatedCandidate<Action>[] = [];

  public constructor(objective: SearchObjective, sustainableScenarios: readonly string[]) {
    this.#objective = objective;
    this.#scenarios = sustainableScenarios;
  }

  public values(): readonly EvaluatedCandidate<Action>[] {
    return [...this.#candidates];
  }

  public add(candidate: EvaluatedCandidate<Action>): boolean {
    if (!evaluateConstraints(candidate, this.#objective.hardConstraints, this.#scenarios).satisfied) {
      return false;
    }
    const sameId = this.#candidates.findIndex((entry) => entry.id === candidate.id);
    if (sameId >= 0) this.#candidates.splice(sameId, 1);
    if (this.#candidates.some((entry) => dominates(entry, candidate, this.#objective))) {
      return false;
    }
    this.#candidates = this.#candidates.filter((entry) => !dominates(candidate, entry, this.#objective));
    this.#candidates.push(candidate);
    this.#candidates.sort((a, b) => a.id.localeCompare(b.id));
    return true;
  }

  public addAll(candidates: readonly EvaluatedCandidate<Action>[]): number {
    let added = 0;
    for (const candidate of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
      if (this.add(candidate)) added += 1;
    }
    return added;
  }
}
