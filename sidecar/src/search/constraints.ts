import type { EvaluatedCandidate, HardConstraint } from "./types.js";

export interface ConstraintViolation {
  readonly constraintId: string;
  readonly metric: string;
  readonly scenario: string;
  readonly expected: string;
  readonly actual?: number;
  readonly reason: "missing_metric" | "comparison_failed";
}

export interface ConstraintResult {
  readonly satisfied: boolean;
  readonly violations: readonly ConstraintViolation[];
}

function compare(actual: number, constraint: HardConstraint): boolean {
  switch (constraint.operator) {
    case "gte": return actual >= constraint.value;
    case "gt": return actual > constraint.value;
    case "lte": return actual <= constraint.value;
    case "lt": return actual < constraint.value;
    case "eq": return actual === constraint.value;
    case "ne": return actual !== constraint.value;
  }
}

export function evaluateConstraints<Action>(
  candidate: EvaluatedCandidate<Action>,
  constraints: readonly HardConstraint[],
  sustainableScenarios: readonly string[],
): ConstraintResult {
  const violations: ConstraintViolation[] = [];
  for (const constraint of constraints) {
    const scenarios = constraint.scenarios?.length ? constraint.scenarios : sustainableScenarios;
    for (const scenario of scenarios) {
      const actual = candidate.metricsByScenario[scenario]?.[constraint.metric];
      const expected = `${constraint.operator} ${constraint.value}`;
      if (actual === undefined || !Number.isFinite(actual)) {
        violations.push({
          constraintId: constraint.id,
          metric: constraint.metric,
          scenario,
          expected,
          reason: "missing_metric",
        });
      } else if (!compare(actual, constraint)) {
        violations.push({
          constraintId: constraint.id,
          metric: constraint.metric,
          scenario,
          expected,
          actual,
          reason: "comparison_failed",
        });
      }
    }
  }
  return { satisfied: violations.length === 0, violations };
}
