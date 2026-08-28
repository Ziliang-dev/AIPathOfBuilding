import type { DeepLimits } from "../schemas.js";
import type { PlannerStore } from "../storage/types.js";
import type {
  PobWorkerEvaluatePayload,
  WorkerEvaluation,
  WorkerJob,
  WorkerPool,
} from "../worker/index.js";
import type { AdapterRegistry } from "./adapters.js";
import { PlannerStoreEvaluationCache, type EvaluationCache } from "./cache.js";
import { canonicalHash, createSearchCacheKey } from "./canonical.js";
import { directed, objectiveMetricValue } from "./metrics.js";
import { ParetoFrontier } from "./pareto.js";
import { selectCandidates } from "./selection.js";
import type {
  DomainSearchState,
  EvaluatedCandidate,
  SearchCandidate,
  SearchObjective,
  SearchProgress,
  SearchResult,
  SearchStopReason,
} from "./types.js";

export const DEFAULT_SEARCH_LIMITS: DeepLimits = {
  recursionLimit: 40,
  wallTimeMs: 30 * 60 * 1000,
  evaluationLimit: 100_000,
  modelCallLimit: 16,
  convergenceRounds: 3,
  convergenceThreshold: 0.005,
  duplicateCallLimit: 3,
};

export class SearchControl {
  readonly #controller = new AbortController();
  readonly #toolCalls = new Map<string, number>();
  #modelCalls = 0;
  #doomLoop = false;

  public get signal(): AbortSignal { return this.#controller.signal; }
  public get modelCalls(): number { return this.#modelCalls; }
  public get doomLoop(): boolean { return this.#doomLoop; }
  public cancel(): void { this.#controller.abort(); }

  public recordModelCall(): number {
    this.#modelCalls += 1;
    return this.#modelCalls;
  }

  /** A fingerprint must include normalized tool arguments and current graph state. */
  public recordToolCall(fingerprint: string, duplicateLimit: number): number {
    const count = (this.#toolCalls.get(fingerprint) ?? 0) + 1;
    this.#toolCalls.set(fingerprint, count);
    if (count >= duplicateLimit) this.#doomLoop = true;
    return count;
  }
}

export interface SearchEngineOptions<State extends DomainSearchState<Action>, Action> {
  readonly runId: string;
  readonly state: State;
  readonly initialCandidates: readonly EvaluatedCandidate<Action>[];
  readonly sustainableScenarios: readonly string[];
  readonly objective: SearchObjective;
  readonly registry: AdapterRegistry<State, Action>;
  readonly workerPool: WorkerPool<PobWorkerEvaluatePayload<Action>, WorkerEvaluation>;
  readonly limits?: DeepLimits;
  readonly beamWidth?: number;
  readonly control?: SearchControl;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly onProgress?: (progress: SearchProgress<Action>) => void;
  readonly store?: Pick<PlannerStore, "getCache" | "setCache">;
  readonly evaluationCache?: EvaluationCache;
  readonly cacheContext?: EvaluationCacheContext;
}

export interface EvaluationCacheContext {
  readonly engineCommit: string;
  readonly ruleset: string;
  readonly buildFingerprint: string;
  readonly objectiveVersion: string | number;
}

export class SearchEngine<State extends DomainSearchState<Action>, Action = unknown> {
  readonly #options: SearchEngineOptions<State, Action>;

  public constructor(options: SearchEngineOptions<State, Action>) {
    if (!options.initialCandidates.length) throw new Error("Search requires at least one evaluated initial candidate");
    if (!options.sustainableScenarios.length) throw new Error("Search requires sustainable scenarios");
    options.registry.assertComplete();
    this.#options = options;
  }

  public async run(): Promise<SearchResult<Action>> {
    const limits = this.#options.limits ?? DEFAULT_SEARCH_LIMITS;
    const beamWidth = this.#options.beamWidth ?? 12;
    if (!Number.isInteger(beamWidth) || beamWidth < 1) throw new RangeError("beamWidth must be a positive integer");
    const now = this.#options.now ?? Date.now;
    const startedAt = now();
    const control = this.#options.control ?? new SearchControl();
    const runSignal = this.#options.signal
      ? AbortSignal.any([control.signal, this.#options.signal])
      : control.signal;
    const frontier = new ParetoFrontier<Action>(this.#options.objective, this.#options.sustainableScenarios);
    frontier.addAll(this.#options.initialCandidates);
    // Keep evaluated but currently infeasible seeds in the beam. A second action may
    // repair their constraint violation; only the public Pareto frontier is feasible-only.
    let beam = selectBeam(
      uniqueCandidates([...frontier.values(), ...this.#options.initialCandidates]),
      this.#options.objective,
      beamWidth,
    );
    let evaluations = 0;
    let rounds = 0;
    let convergenceRounds = 0;
    let stopReason: SearchStopReason = "exhausted";
    let bestPrimary = bestPrimaryValue(frontier.values(), this.#options.objective);

    outer: for (let round = 1; round <= limits.recursionLimit; round += 1) {
      rounds = round;
      const beforeHash = canonicalHash(frontier.values().map((candidate) => candidate.id));
      let generatedThisRound = 0;

      for (const adapter of this.#options.registry.list()) {
        const reason = this.#stopReason(limits, evaluations, startedAt, now(), control);
        if (reason) { stopReason = reason; break outer; }

        const generated = new Map<string, SearchCandidate<Action>>();
        for (const seed of beam) {
          const stateFingerprint = canonicalHash({
            domain: adapter.domain,
            seed: seed.id,
            frontier: frontier.values().map((candidate) => candidate.id),
            state: this.#options.state,
          });
          control.recordToolCall(stateFingerprint, limits.duplicateCallLimit);
          if (control.doomLoop) { stopReason = "doom_loop"; break outer; }
          const candidates = await adapter.generate({
            state: this.#options.state,
            seed,
            frontier: frontier.values(),
            objective: this.#options.objective,
            round,
            signal: runSignal,
          });
          for (const candidate of candidates) {
            if (!generated.has(candidate.id) && !frontier.values().some((entry) => entry.id === candidate.id)) {
              generated.set(candidate.id, candidate);
            }
          }
        }

        const candidates = [...generated.values()].sort((left, right) => left.id.localeCompare(right.id));
        if (!candidates.length) continue;
        generatedThisRound += candidates.length;
        const remainingEvaluations = limits.evaluationLimit - evaluations;
        let evaluated: EvaluatedCandidate<Action>[];
        let performedEvaluations: number;
        let evaluationBudgetExhausted: boolean;
        try {
          const outcome = await this.#evaluate(candidates, runSignal, remainingEvaluations);
          evaluated = outcome.candidates;
          performedEvaluations = outcome.evaluations;
          evaluationBudgetExhausted = outcome.budgetExhausted;
        } catch (error) {
          if (runSignal.aborted) {
            stopReason = "cancelled";
            break outer;
          }
          throw error;
        }
        evaluations += performedEvaluations;
        frontier.addAll(evaluated);
        beam = selectBeam(
          uniqueCandidates([...frontier.values(), ...beam, ...evaluated]),
          this.#options.objective,
          beamWidth,
        );
        this.#emit("searching", round, evaluations, frontier.values(), startedAt, now(), adapter.domain);
        if (evaluationBudgetExhausted) { stopReason = "evaluation_limit"; break outer; }
      }

      if (generatedThisRound === 0) { stopReason = "exhausted"; break; }
      const afterHash = canonicalHash(frontier.values().map((candidate) => candidate.id));
      const nextBest = bestPrimaryValue(frontier.values(), this.#options.objective);
      const improvement = relativeImprovement(bestPrimary, nextBest);
      if (beforeHash === afterHash || improvement < limits.convergenceThreshold) convergenceRounds += 1;
      else convergenceRounds = 0;
      bestPrimary = Math.max(bestPrimary, nextBest);
      if (convergenceRounds >= limits.convergenceRounds) {
        stopReason = "converged";
        this.#emit("converged", round, evaluations, frontier.values(), startedAt, now());
        break;
      }
      if (round === limits.recursionLimit) stopReason = "recursion_limit";
    }

    const elapsedMs = Math.max(0, now() - startedAt);
    const values = frontier.values();
    this.#emit("stopped", rounds, evaluations, values, startedAt, now());
    return {
      frontier: values,
      beam,
      rounds,
      evaluations,
      modelCalls: control.modelCalls,
      elapsedMs,
      stopReason,
      selections: selectCandidates(values, this.#options.objective, this.#options.sustainableScenarios),
    };
  }

  async #evaluate(
    candidates: readonly SearchCandidate<Action>[],
    signal: AbortSignal,
    remainingEvaluationBudget: number,
  ): Promise<{
    readonly candidates: EvaluatedCandidate<Action>[];
    readonly evaluations: number;
    readonly budgetExhausted: boolean;
  }> {
    const ready: EvaluatedCandidate<Action>[] = [];
    const pending: { candidate: SearchCandidate<Action>; cached: Record<string, Readonly<Record<string, number>>>; missing: string[] }[] = [];
    const cacheContext = this.#options.cacheContext;
    const cache = this.#options.evaluationCache
      ?? (this.#options.store ? new PlannerStoreEvaluationCache(this.#options.store) : undefined);
    if (cache && !cacheContext) throw new Error("evaluation cache requires cacheContext");
    for (const candidate of candidates) {
      if (candidate.metricsByScenario) ready.push(candidate as EvaluatedCandidate<Action>);
      else {
        const cached: Record<string, Readonly<Record<string, number>>> = {};
        const missing: string[] = [];
        for (const scenario of this.#options.sustainableScenarios) {
          const scenarioSpec = this.#options.state.scenarioSpecs?.find((entry) => entry.id === scenario);
          const key = cacheContext ? createSearchCacheKey({
            ...cacheContext,
            actions: candidate.actions,
            scenario: scenarioSpec ?? scenario,
          }) : undefined;
          const value = key ? cache?.get(key) : undefined;
          if (value && validMetricVector(value)) cached[scenario] = value;
          else missing.push(scenario);
        }
        if (missing.length === 0) ready.push({ ...candidate, metricsByScenario: cached });
        else pending.push({ candidate, cached, missing });
      }
    }
    if (pending.length && (!this.#options.state.buildXml || !this.#options.state.scenarioSpecs)) {
      throw new Error("Worker evaluation requires state.buildXml and state.scenarioSpecs");
    }
    let budget = remainingEvaluationBudget;
    const admitted = pending.filter((entry) => {
      if (entry.missing.length > budget) return false;
      budget -= entry.missing.length;
      return true;
    });
    const jobs: WorkerJob<PobWorkerEvaluatePayload<Action>>[] = admitted.map(({ candidate, missing }) => ({
      id: `${this.#options.runId}:${candidate.id}`,
      runId: this.#options.runId,
      candidateId: candidate.id,
      buildFingerprint: candidate.baseFingerprint,
      scenarios: missing,
      payload: {
        xml: this.#options.state.buildXml ?? "",
        actions: candidate.actions,
        scenarios: (this.#options.state.scenarioSpecs ?? []).filter((scenario) => missing.includes(scenario.id)),
        evidence: this.#options.state.evidence ?? [],
      },
    }));
    const results = await this.#options.workerPool.evaluateBatch(jobs, signal);
    const byId = new Map(admitted.map((entry) => [entry.candidate.id, entry]));
    for (const result of results) {
      const entry = byId.get(result.candidateId);
      if (!entry) throw new Error(`Worker returned unknown candidate: ${result.candidateId}`);
      const metricsByScenario = { ...entry.cached, ...result.metricsByScenario };
      for (const scenario of entry.missing) {
        const metrics = result.metricsByScenario[scenario];
        if (!metrics || !validMetricVector(metrics)) throw new Error(`Worker omitted metrics for ${result.candidateId}/${scenario}`);
        if (cacheContext && cache) {
          const scenarioSpec = this.#options.state.scenarioSpecs?.find((candidate) => candidate.id === scenario);
          cache.set(createSearchCacheKey({
            ...cacheContext,
            actions: entry.candidate.actions,
            scenario: scenarioSpec ?? scenario,
          }), metrics);
        }
      }
      ready.push({
        ...entry.candidate,
        metricsByScenario,
        metadata: {
          ...entry.candidate.metadata,
          ...(result.candidateFingerprint === undefined ? {} : {
            candidateFingerprint: result.candidateFingerprint,
          }),
          ...(result.nativeProbeFingerprint === undefined ? {} : {
            nativeProbeFingerprint: result.nativeProbeFingerprint,
          }),
          ...(result.evidenceFingerprint === undefined ? {} : {
            evidenceFingerprint: result.evidenceFingerprint,
          }),
          ...(result.resolvedEvidence === undefined ? {} : {
            resolvedEvidence: result.resolvedEvidence,
          }),
        },
      });
    }
    return {
      candidates: ready.sort((left, right) => left.id.localeCompare(right.id)),
      evaluations: admitted.reduce((sum, entry) => sum + entry.missing.length, 0),
      budgetExhausted: admitted.length < pending.length,
    };
  }

  #stopReason(
    limits: DeepLimits,
    evaluations: number,
    startedAt: number,
    currentTime: number,
    control: SearchControl,
  ): SearchStopReason | undefined {
    if (this.#options.signal?.aborted || control.signal.aborted) return "cancelled";
    if (currentTime - startedAt >= limits.wallTimeMs) return "time_limit";
    if (evaluations >= limits.evaluationLimit) return "evaluation_limit";
    if (control.modelCalls >= limits.modelCallLimit) return "model_call_limit";
    if (control.doomLoop) return "doom_loop";
    return undefined;
  }

  #emit(
    phase: SearchProgress<Action>["phase"],
    round: number,
    evaluations: number,
    frontier: readonly EvaluatedCandidate<Action>[],
    startedAt: number,
    currentTime: number,
    domain?: SearchProgress<Action>["domain"],
  ): void {
    this.#options.onProgress?.({
      phase,
      round,
      evaluations,
      frontier,
      elapsedMs: Math.max(0, currentTime - startedAt),
      ...(domain ? { domain } : {}),
    });
  }
}

function uniqueCandidates<Action>(
  candidates: readonly EvaluatedCandidate<Action>[],
): EvaluatedCandidate<Action>[] {
  const byId = new Map<string, EvaluatedCandidate<Action>>();
  for (const candidate of candidates) byId.set(candidate.id, candidate);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function validMetricVector(value: unknown): value is Readonly<Record<string, number>> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every((metric) => typeof metric === "number" && Number.isFinite(metric));
}

function bestPrimaryValue<Action>(
  candidates: readonly EvaluatedCandidate<Action>[],
  objective: SearchObjective,
): number {
  const metric = objective.metrics.find((entry) => entry.key === objective.primaryMetric) ?? objective.metrics[0];
  if (!metric) return 0;
  return candidates.reduce((best, candidate) => {
    const value = objectiveMetricValue(candidate, metric, objective);
    return value === undefined ? best : Math.max(best, directed(value, metric.direction));
  }, Number.NEGATIVE_INFINITY);
}

function relativeImprovement(before: number, after: number): number {
  if (!Number.isFinite(before)) return Number.POSITIVE_INFINITY;
  if (after <= before) return 0;
  return (after - before) / Math.max(Math.abs(before), 1e-9);
}

function selectBeam<Action>(
  candidates: readonly EvaluatedCandidate<Action>[],
  objective: SearchObjective,
  beamWidth: number,
): EvaluatedCandidate<Action>[] {
  if (candidates.length <= beamWidth) return [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  const picked = new Map<string, EvaluatedCandidate<Action>>();
  for (const metric of objective.metrics) {
    const sorted = [...candidates].sort((left, right) => {
      const l = objectiveMetricValue(left, metric, objective);
      const r = objectiveMetricValue(right, metric, objective);
      const difference = directed(r ?? Number.NEGATIVE_INFINITY, metric.direction)
        - directed(l ?? Number.NEGATIVE_INFINITY, metric.direction);
      return difference || left.id.localeCompare(right.id);
    });
    const best = sorted[0];
    if (best) picked.set(best.id, best);
  }
  const selections = selectCandidates(candidates, objective, Object.keys(objective.scenarioWeights));
  for (const candidate of [selections.offence, selections.balanced, selections.defence]) {
    if (candidate) picked.set(candidate.id, candidate);
  }
  for (const candidate of [...candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    if (picked.size >= beamWidth) break;
    picked.set(candidate.id, candidate);
  }
  return [...picked.values()].slice(0, beamWidth);
}
