export interface ProgressionAction {
  readonly id: string;
  readonly description: string;
  readonly dependsOn?: readonly string[];
  readonly requires?: readonly string[];
  readonly provides?: readonly string[];
  readonly costDivine?: number;
}

export interface ProgressionStep<Action extends ProgressionAction> {
  readonly order: number;
  readonly action: Action;
  readonly dependencies: readonly string[];
  readonly cumulativeCostDivine: number;
  readonly milestone?: number;
}

export interface ProgressionPlan<Action extends ProgressionAction> {
  readonly steps: readonly ProgressionStep<Action>[];
  readonly edges: readonly { readonly from: string; readonly to: string }[];
  readonly totalCostDivine: number;
}

/** Build a stable DAG from explicit dependencies and requires/provides tokens. */
export function buildProgressionDag<Action extends ProgressionAction>(
  actions: readonly Action[],
  milestoneBudgets: readonly number[] = [],
): ProgressionPlan<Action> {
  const actionById = new Map<string, Action>();
  for (const action of actions) {
    if (actionById.has(action.id)) throw new Error(`Duplicate progression action: ${action.id}`);
    if ((action.costDivine ?? 0) < 0) throw new Error(`Negative action cost: ${action.id}`);
    actionById.set(action.id, action);
  }

  const providers = new Map<string, Action[]>();
  for (const action of actions) {
    for (const token of action.provides ?? []) {
      const entries = providers.get(token) ?? [];
      entries.push(action);
      entries.sort((left, right) => (left.costDivine ?? 0) - (right.costDivine ?? 0) || left.id.localeCompare(right.id));
      providers.set(token, entries);
    }
  }

  const dependencies = new Map<string, Set<string>>();
  for (const action of actions) {
    const deps = new Set(action.dependsOn ?? []);
    for (const dependency of deps) {
      if (!actionById.has(dependency)) throw new Error(`Missing progression dependency ${dependency} for ${action.id}`);
      if (dependency === action.id) throw new Error(`Self dependency for progression action: ${action.id}`);
    }
    for (const required of action.requires ?? []) {
      const provider = providers.get(required)?.find((candidate) => candidate.id !== action.id);
      if (!provider) throw new Error(`No provider for requirement ${required} of ${action.id}`);
      deps.add(provider.id);
    }
    dependencies.set(action.id, deps);
  }

  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const action of actions) indegree.set(action.id, dependencies.get(action.id)?.size ?? 0);
  for (const [to, deps] of dependencies) {
    for (const from of deps) {
      const targets = outgoing.get(from) ?? [];
      targets.push(to);
      targets.sort();
      outgoing.set(from, targets);
    }
  }

  const ready = actions.filter((action) => indegree.get(action.id) === 0).sort(actionOrder);
  const ordered: Action[] = [];
  while (ready.length) {
    const action = ready.shift();
    if (!action) break;
    ordered.push(action);
    for (const target of outgoing.get(action.id) ?? []) {
      const remaining = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        const next = actionById.get(target);
        if (next) {
          ready.push(next);
          ready.sort(actionOrder);
        }
      }
    }
  }
  if (ordered.length !== actions.length) {
    const cyclic = actions.filter((action) => !ordered.some((entry) => entry.id === action.id)).map((action) => action.id);
    throw new Error(`Progression dependency cycle: ${cyclic.sort().join(", ")}`);
  }

  const budgets = [...milestoneBudgets].filter((value) => value >= 0).sort((a, b) => a - b);
  let cumulative = 0;
  const steps = ordered.map((action, index): ProgressionStep<Action> => {
    cumulative += action.costDivine ?? 0;
    const milestone = budgets.find((budget) => cumulative <= budget);
    return {
      order: index + 1,
      action,
      dependencies: [...(dependencies.get(action.id) ?? [])].sort(),
      cumulativeCostDivine: cumulative,
      ...(milestone !== undefined ? { milestone } : {}),
    };
  });
  const edges = [...dependencies.entries()]
    .flatMap(([to, deps]) => [...deps].map((from) => ({ from, to })))
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return { steps, edges, totalCostDivine: cumulative };
}

function actionOrder(left: ProgressionAction, right: ProgressionAction): number {
  return (left.costDivine ?? 0) - (right.costDivine ?? 0) || left.id.localeCompare(right.id);
}
