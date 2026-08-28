import {
  BuildSnapshotSchema,
  CandidateSchema,
  ObjectiveSpecDraftSchema,
  ScenarioSpecSchema,
  SearchStopReasonSchema,
  TransactionResultSchema,
  normalizeObjectiveSpec,
  type DeepLimits,
  type ScenarioSpec,
} from "../schemas.js";
import {
  createCurrentDiagnosticScenario,
  generateStandardScenarios,
} from "../domain/scenarios.js";
import { currentLimitStopReason, remainingBudget } from "./limits.js";
import type {
  WorkflowNodeName,
  WorkflowNodeUpdate,
  WorkflowState,
  WorkflowStateUpdate,
} from "./state.js";

export interface WorkflowNodeContext {
  node: WorkflowNodeName;
  limits: DeepLimits;
  nowMs: number;
  remaining: ReturnType<typeof remainingBudget>;
  sustainableScenarios: readonly ScenarioSpec[];
  peakScenarios: readonly ScenarioSpec[];
}

export type WorkflowNodeHandler = (
  state: Readonly<WorkflowState>,
  context: Readonly<WorkflowNodeContext>,
) => WorkflowNodeUpdate | Promise<WorkflowNodeUpdate>;

export interface WorkflowNodeDependencies {
  captureBuild: WorkflowNodeHandler;
  draftObjective: WorkflowNodeHandler;
  confirmObjective: WorkflowNodeHandler;
  buildScenarios: WorkflowNodeHandler;
  inspect: WorkflowNodeHandler;
  diagnose: WorkflowNodeHandler;
  planSearch: WorkflowNodeHandler;
  searchDomains: WorkflowNodeHandler;
  mergePareto: WorkflowNodeHandler;
  verify: WorkflowNodeHandler;
  refineSearch: WorkflowNodeHandler;
  explain: WorkflowNodeHandler;
  preview: WorkflowNodeHandler;
  reject: WorkflowNodeHandler;
  finalVerify: WorkflowNodeHandler;
}

const noop: WorkflowNodeHandler = () => ({});

export const DEFAULT_NODE_DEPENDENCIES: WorkflowNodeDependencies = {
  captureBuild: (state) => ({ snapshot: BuildSnapshotSchema.parse(state.snapshot) }),
  draftObjective: (state) => {
    if (state.objective !== undefined) return { objective: normalizeObjectiveSpec(state.objective) };
    if (state.objectiveDraft === undefined) throw new Error("Objective draft is required");
    const draft = ObjectiveSpecDraftSchema.parse(state.objectiveDraft);
    return { objectiveDraft: draft, objective: normalizeObjectiveSpec(draft) };
  },
  confirmObjective: (state) => {
    if (state.objective === undefined) throw new Error("Confirmed ObjectiveSpec is required");
    return { objective: normalizeObjectiveSpec(state.objective), objectiveConfirmed: true };
  },
  buildScenarios: (state) => ({ scenarios: defaultScenarios(state) }),
  inspect: noop,
  diagnose: noop,
  planSearch: noop,
  searchDomains: noop,
  mergePareto: noop,
  verify: () => ({ needsRefinement: false, improvementRatio: 0 }),
  refineSearch: noop,
  explain: (state) => ({
    explanation: state.frontier.length === 0
      ? "No feasible candidate was found."
      : `${state.frontier.length} Pareto candidate(s) verified.`,
  }),
  preview: (state) => ({
    preview: {
      runId: state.runId,
      baseFingerprint: state.snapshot.fingerprint,
      candidates: (state.selected.length > 0 ? state.selected : state.frontier).map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        summary: candidate.summary,
      })),
    },
  }),
  reject: noop,
  finalVerify: noop,
};

export function resolveNodeDependencies(
  dependencies: Partial<WorkflowNodeDependencies> = {},
): WorkflowNodeDependencies {
  return { ...DEFAULT_NODE_DEPENDENCIES, ...dependencies };
}

export interface WrappedNodeOptions {
  expensive?: boolean;
  verify?: boolean;
  refine?: boolean;
  reject?: boolean;
  pause?: boolean;
  final?: boolean;
}

export function wrapNode(
  node: WorkflowNodeName,
  handler: WorkflowNodeHandler,
  limits: DeepLimits,
  now: () => number,
  options: WrappedNodeOptions = {},
): (state: WorkflowState) => Promise<WorkflowStateUpdate> {
  return async (state) => {
    const nowMs = now();
    const base: WorkflowStateUpdate = {
      phase: node,
      updatedAtMs: nowMs,
      trace: node,
    };
    if (node === "CaptureBuild") {
      base.startedAtMs = state.startedAtMs > 0 ? state.startedAtMs : nowMs;
      base.status = "running";
    }

    if (state.stopReason === "failed") {
      return options.final ? finalize(state, base, nowMs) : base;
    }

    const preStop = options.expensive ? currentLimitStopReason(state, limits, nowMs) : undefined;
    if (preStop !== undefined) {
      base.stopReason = preStop;
      base.status = preStop === "cancelled" ? "cancelled" : "running";
      return options.final ? finalize(state, base, nowMs) : base;
    }

    try {
      const output = validateNodeUpdate(await handler(state, {
        node,
        limits,
        nowMs,
        remaining: remainingBudget(state, limits, nowMs),
        sustainableScenarios: state.scenarios.filter(({ profile }) => profile === "sustainable"),
        peakScenarios: state.scenarios.filter(({ profile }) => profile === "peak"),
      }));
      Object.assign(base, publicUpdate(output, state));
      const evaluations = state.evaluations + (output.usage?.evaluations ?? 0);
      const modelCalls = state.modelCalls + (output.usage?.modelCalls ?? 0);
      base.evaluations = evaluations;
      base.modelCalls = modelCalls;
      base.providerFallback = state.providerFallback || output.providerFallback === true;

      if (output.toolCallFingerprint !== undefined) {
        const duplicate = output.toolCallFingerprint === state.lastToolCallFingerprint
          ? state.duplicateToolCalls + 1
          : 1;
        base.lastToolCallFingerprint = output.toolCallFingerprint;
        base.duplicateToolCalls = duplicate;
      }

      if (options.verify === true) {
        const improvement = output.improvementRatio ?? 0;
        base.latestImprovementRatio = improvement;
        base.noImprovementRounds = output.paretoFrontierChanged !== true
          && improvement < limits.convergenceThreshold
          ? state.noImprovementRounds + 1
          : 0;
        base.needsRefinement = output.needsRefinement ?? false;
      }
      if (options.refine === true) base.refinementRounds = state.refinementRounds + 1;
      if (options.reject === true) base.stopReason = "rejected";
      if (options.pause === true && base.stopReason === undefined) base.status = "paused";

      const projected = { ...state, ...base } as WorkflowState;
      const hardStop = currentLimitStopReason(projected, limits, nowMs);
      if (hardStop !== undefined) base.stopReason = hardStop;
      if (options.final === true) return finalize(projected, base, nowMs);
      return base;
    } catch (error) {
      const failed: WorkflowStateUpdate = {
        ...base,
        status: "failed",
        stopReason: "failed",
        error: errorMessage(error),
      };
      return options.final ? finalize({ ...state, ...failed } as WorkflowState, failed, nowMs) : failed;
    }
  };
}

function publicUpdate(update: WorkflowNodeUpdate, state: WorkflowState): WorkflowStateUpdate {
  const result: WorkflowStateUpdate = {};
  if (update.snapshot !== undefined) result.snapshot = update.snapshot;
  if (update.objectiveDraft !== undefined) result.objectiveDraft = update.objectiveDraft;
  if (update.objective !== undefined) result.objective = update.objective;
  if (update.objectiveConfirmed !== undefined) result.objectiveConfirmed = update.objectiveConfirmed;
  if (update.scenarios !== undefined) result.scenarios = update.scenarios;
  if (update.artifacts !== undefined) result.artifacts = { ...state.artifacts, ...update.artifacts };
  if (update.frontier !== undefined) result.frontier = update.frontier;
  if (update.selected !== undefined) result.selected = update.selected;
  if (update.explanation !== undefined) result.explanation = update.explanation;
  if (update.preview !== undefined) result.preview = update.preview;
  if (update.transactionResult !== undefined) result.transactionResult = update.transactionResult;
  if (update.searchStopReason !== undefined) result.searchStopReason = update.searchStopReason;
  return result;
}

function validateNodeUpdate(update: WorkflowNodeUpdate): WorkflowNodeUpdate {
  const validated = { ...update };
  if (update.snapshot !== undefined) validated.snapshot = BuildSnapshotSchema.parse(update.snapshot);
  if (update.objectiveDraft !== undefined) validated.objectiveDraft = ObjectiveSpecDraftSchema.parse(update.objectiveDraft);
  if (update.objective !== undefined) validated.objective = normalizeObjectiveSpec(update.objective);
  if (update.scenarios !== undefined) {
    validated.scenarios = update.scenarios.map((scenario) => ScenarioSpecSchema.parse(scenario));
  }
  if (update.frontier !== undefined) {
    validated.frontier = update.frontier.map((candidate) => CandidateSchema.parse(candidate));
  }
  if (update.selected !== undefined) {
    if (update.selected.length > 3) throw new Error("At most three candidates may be selected");
    validated.selected = update.selected.map((candidate) => CandidateSchema.parse(candidate));
  }
  if (update.transactionResult !== undefined) {
    validated.transactionResult = TransactionResultSchema.parse(update.transactionResult);
  }
  if (update.searchStopReason !== undefined) {
    validated.searchStopReason = SearchStopReasonSchema.parse(update.searchStopReason);
  }
  if (update.improvementRatio !== undefined && (!Number.isFinite(update.improvementRatio) || update.improvementRatio < 0)) {
    throw new Error("improvementRatio must be a finite non-negative number");
  }
  for (const [name, value] of Object.entries(update.usage ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} usage must be a non-negative integer`);
  }
  if (update.toolCallFingerprint !== undefined && update.toolCallFingerprint.length === 0) {
    throw new Error("toolCallFingerprint must not be empty");
  }
  return validated;
}

function finalize(state: WorkflowState, base: WorkflowStateUpdate, nowMs: number): WorkflowStateUpdate {
  const stopReason = state.stopReason
    ?? (state.providerFallback ? "provider_fallback" : "completed");
  return {
    ...base,
    phase: "end",
    updatedAtMs: nowMs,
    stopReason,
    status: stopReason === "cancelled"
      ? "cancelled"
      : stopReason === "failed"
        ? "failed"
        : "completed",
  };
}

function defaultScenarios(state: WorkflowState): ScenarioSpec[] {
  const config = state.snapshot.config;
  const mapModifiers = stringArray(config["mapModifiers"]);
  const bossSkillPreset = typeof config["presetBossSkills"] === "string"
    ? config["presetBossSkills"]
    : typeof config["bossSkillPreset"] === "string"
      ? config["bossSkillPreset"]
      : undefined;
  const currentBoss = config["enemyIsBoss"];
  const currentEnemy = currentBoss === "Boss" || currentBoss === "Pinnacle" || currentBoss === "Uber"
    ? currentBoss
    : "None";
  const current = ScenarioSpecSchema.parse({
    ...createCurrentDiagnosticScenario(currentEnemy, { config }),
    mapModifiers,
    ...(bossSkillPreset === undefined ? {} : { bossSkillPreset }),
  });
  const standard = generateStandardScenarios({
    mapModifiers,
    ...(bossSkillPreset === undefined ? {} : { bossSkillPreset }),
  });
  const mappingInputs = mappingConfigInputs(config);
  return [
    current,
    ...standard.map((scenario) => scenario.id === "mapping"
      ? ScenarioSpecSchema.parse({
          ...scenario,
          assumptions: { ...scenario.assumptions, configInputs: mappingInputs },
        })
      : scenario),
  ];
}

function mappingConfigInputs(config: Readonly<Record<string, unknown>>): Record<string, string | number | boolean> {
  const keys = [
    "multiplierMapModEffect",
    "multiplierMapModTier",
    ...Array.from({ length: 4 }, (_, index) => `MapPrefix${index + 1}`),
    ...Array.from({ length: 4 }, (_, index) => `MapSuffix${index + 1}`),
  ];
  const result: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = value;
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
