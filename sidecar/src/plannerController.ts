import { randomUUID } from "node:crypto";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";
import type {
  BuildAction,
  BuildSnapshot,
  Candidate,
  CandidateLabel,
  ConditionEvidence,
  MetricSet,
  ObjectiveSpec,
  OptimizationRun,
  RankedScenarioId,
  ScenarioSpec,
  SearchStopReason,
} from "./schemas.js";
import {
  DomainGraph,
  createDefaultCoverageRegistry,
  createDefaultMechanicAdapterRegistry,
  resolveConditionEvidence,
  type ConditionClaimInput,
} from "./domain/index.js";
import {
  BuildActionSchema,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  normalizeObjectiveSpec,
} from "./schemas.js";
import type {
  PlannerController,
  PlannerControllerContext,
  RpcParams,
} from "./rpc/controller.js";
import { JsonRpcError, JsonRpcErrorCode } from "./rpc/json-rpc.js";
import {
  BuildCaptureParamsSchema,
  CandidatePreviewParamsSchema,
  HelloParamsSchema,
  RunCancelParamsSchema,
  RunResumeParamsSchema,
  RunStartParamsSchema,
  RunStreamParamsSchema,
  TransactionResultParamsSchema,
} from "./protocol.js";
import {
  DEFAULT_SEARCH_LIMITS,
  SearchEngine,
  canonicalHash,
  createFullDomainRegistry,
  evaluateConstraints,
  objectiveFromSchema,
  type DomainSearchState,
  type EvaluatedCandidate,
  type SearchCandidate,
  type SearchDomain,
  type SearchProgress,
  type SearchResult,
} from "./search/index.js";
import type { PlannerStore } from "./storage/index.js";
import {
  type PobWorkerEvaluatePayload,
  type WorkerEvaluation,
  type WorkerPool,
} from "./worker/index.js";
import {
  createWorkflowGraph,
  createWorkflowInput,
  toOptimizationRun,
  workflowConfig,
  type WorkflowNodeContext,
  type WorkflowState,
} from "./workflow/index.js";

type EvaluationPool = WorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation>;
type WorkflowGraph = ReturnType<typeof createWorkflowGraph>;

export type WorkerPoolFactory = (
  snapshot: BuildSnapshot,
  signal: AbortSignal,
) => Promise<EvaluationPool> | EvaluationPool;

interface ActiveRun {
  readonly graph: WorkflowGraph;
  readonly snapshot: BuildSnapshot;
  readonly objective: ObjectiveSpec;
  readonly controller: AbortController;
  readonly pool: EvaluationPool;
  notify: PlannerControllerContext["notify"];
  cancelled: boolean;
}

interface PlannerControllerOptions {
  readonly store: PlannerStore;
  readonly checkpointer: BaseCheckpointSaver;
  readonly workerPoolFactory?: WorkerPoolFactory;
}

const SourceMetadataSchema = z.object({
  source: z.enum(["currentBuild", "unique", "targetRare", "trade"]).optional(),
  touches: z.array(z.string()).optional(),
});

export class DefaultPlannerController implements PlannerController {
  readonly #store: PlannerStore;
  readonly #checkpointer: BaseCheckpointSaver;
  readonly #workerPoolFactory: WorkerPoolFactory;
  readonly #active = new Map<string, ActiveRun>();
  readonly #pending = new Map<string, AbortController>();
  readonly #cancelled = new Set<string>();
  readonly #activations = new Map<string, Promise<ActiveRun>>();
  readonly #operations = new Set<string>();
  readonly #pools = new Set<EvaluationPool>();
  readonly #tasks = new Set<Promise<unknown>>();
  #closed = false;

  constructor(options: PlannerControllerOptions) {
    this.#store = options.store;
    this.#checkpointer = options.checkpointer;
    this.#workerPoolFactory = options.workerPoolFactory ?? (() => {
      throw new Error("PoB worker command is required; synthetic evaluation is disabled");
    });
  }

  hello(params: RpcParams): unknown {
    const hello = HelloParamsSchema.parse(params);
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverName: "AIPathOfBuilding Sidecar",
      serverVersion: "0.1.0",
      capabilities: {
        workflowGraph: true,
        domainGraph: true,
        deterministicFallback: true,
        humanGatedTransactions: true,
        trade: false,
        providerConfigured: false,
      },
      client: hello,
    };
  }

  captureBuild(params: RpcParams): unknown {
    const { snapshot } = BuildCaptureParamsSchema.parse(params);
    if (snapshot.gameplayFieldPaths.length === 0) {
      throw new JsonRpcError(
        JsonRpcErrorCode.InvalidParams,
        "Build snapshot must include gameplayFieldPaths for coverage auditing",
      );
    }
    createDefaultCoverageRegistry().assertComplete(snapshot.gameplayFieldPaths);
    this.#store.saveSnapshot(snapshot);
    return { snapshotFingerprint: snapshot.fingerprint, fingerprint: snapshot.fingerprint, captured: true };
  }

  startRun(params: RpcParams, context: PlannerControllerContext): unknown {
    if (this.#closed) throw new JsonRpcError(JsonRpcErrorCode.InternalError, "Planner controller is closed");
    this.#store.prune();
    const parsed = RunStartParamsSchema.parse(params);
    const snapshot = this.#store.getSnapshot(parsed.snapshotFingerprint);
    if (snapshot === undefined) throw notFound(`Build snapshot not found: ${parsed.snapshotFingerprint}`);
    const normalized = normalizeObjectiveSpec(parsed.objective);
    const hasCatalogSource = (source: "unique" | "targetRare"): boolean =>
      (snapshot.contentCatalog ?? []).some((entry) => {
        const metadata = SourceMetadataSchema.catch({}).parse(entry.data["metadata"] ?? entry.data);
        return entry.available && metadata.source === source && parseCatalogActions(entry.id, entry.data).length > 0;
      });
    const budgetEnabled = normalized.budgetDivine !== undefined;
    const uniqueEnabled = budgetEnabled && normalized.candidateSources.uniques && hasCatalogSource("unique");
    const targetRareEnabled = budgetEnabled && normalized.candidateSources.targetRares && hasCatalogSource("targetRare");
    const externalDisabled = normalized.candidateSources.trade
      || (normalized.candidateSources.uniques && !uniqueEnabled)
      || (normalized.candidateSources.targetRares && !targetRareEnabled);
    const objective: ObjectiveSpec = {
      ...normalized,
      candidateSources: {
        currentBuild: true,
        uniques: uniqueEnabled,
        targetRares: targetRareEnabled,
        trade: false,
      },
    };
    const runId = randomUUID();
    const now = new Date().toISOString();
    this.#store.saveRun({
      schemaVersion: SCHEMA_VERSION,
      id: runId,
      buildFingerprint: snapshot.fingerprint,
      status: "running",
      objective,
      scenarios: [],
      frontier: [],
      selected: [],
      evaluations: 0,
      modelCalls: 0,
      refinementRounds: 0,
      startedAt: now,
      updatedAt: now,
    });
    this.#pending.set(runId, new AbortController());
    this.#operations.add(runId);
    const task = this.#start(runId, snapshot, objective, context.notify);
    this.#trackTask(task);
    return {
      runId,
      status: "running",
      ...(externalDisabled ? {
        warnings: ["External item search disabled: authenticated PoB Trade/catalog broker is not connected"],
      } : {}),
    };
  }

  streamRun(params: RpcParams, context: PlannerControllerContext): unknown {
    const { runId } = RunStreamParamsSchema.parse(params);
    const run = this.#store.getRun(runId);
    if (run === undefined) throw notFound(`Run not found: ${runId}`);
    const active = this.#active.get(runId);
    if (active !== undefined) active.notify = context.notify;
    return {
      runId,
      status: run.status,
      evaluations: run.evaluations,
      modelCalls: run.modelCalls,
      frontier: run.frontier,
      candidates: run.selected,
      stopReason: run.stopReason,
      error: run.error,
    };
  }

  cancelRun(params: RpcParams): unknown {
    const { runId } = RunCancelParamsSchema.parse(params);
    const active = this.#active.get(runId);
    const pending = this.#pending.get(runId);
    const persisted = this.#store.getRun(runId);
    if (active === undefined && pending === undefined && persisted === undefined) throw notFound(`Run not found: ${runId}`);
    if (persisted?.status === "cancelled") return { runId, status: "cancelled" };
    if (persisted?.status === "completed" || persisted?.status === "failed") {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Run is terminal and cannot be cancelled: ${persisted.status}`);
    }
    this.#cancelled.add(runId);
    pending?.abort(new Error("Run cancelled by user"));
    if (active !== undefined) {
      active.cancelled = true;
      active.controller.abort(new Error("Run cancelled by user"));
      active.pool.cancel(runId);
      this.#trackTask(this.#releaseCancelledActive(runId, active));
    }
    this.#pending.delete(runId);
    if (persisted !== undefined) {
      const cancelled: OptimizationRun = {
        ...persisted,
        status: "cancelled",
        stopReason: "cancelled",
        updatedAt: new Date().toISOString(),
      };
      this.#store.saveRun(cancelled);
    }
    return { runId, status: "cancelled" };
  }

  resumeRun(params: RpcParams, context: PlannerControllerContext): Promise<unknown> {
    return this.#trackTask(this.#resumeRun(params, context));
  }

  async #resumeRun(params: RpcParams, context: PlannerControllerContext): Promise<unknown> {
    const resume = RunResumeParamsSchema.parse(params);
    const persisted = this.#store.getRun(resume.runId);
    if (persisted === undefined) throw notFound(`Run not found: ${resume.runId}`);
    if (persisted.status === "completed" || persisted.status === "failed" || persisted.status === "cancelled") {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Run is terminal and cannot be resumed: ${persisted.status}`);
    }
    return this.#withRunOperation(resume.runId, async () => {
    const active = await this.#ensureActive(resume.runId, context.notify, context.signal);
    const operationSignal = AbortSignal.any([active.controller.signal, context.signal]);
    operationSignal.throwIfAborted();
    active.notify = context.notify;
    if ("mode" in resume) {
      let output: WorkflowState;
      try {
        output = await active.graph.invoke(
          null as never,
          workflowConfig(resume.runId, undefined, undefined, operationSignal),
        ) as WorkflowState;
      } catch (error) {
        if (!operationSignal.aborted) await this.#failRun(resume.runId, error);
        throw error;
      }
      operationSignal.throwIfAborted();
      const run = toOptimizationRun(output);
      this.#store.saveRun(run);
      return { runId: run.id, status: run.status, candidates: run.selected };
    }
    if (resume.decision === "apply") {
      const persisted = this.#store.getRun(resume.runId);
      const candidate = persisted?.selected.find(({ id }) => id === resume.candidateId)
        ?? persisted?.frontier.find(({ id }) => id === resume.candidateId);
      if (persisted === undefined || candidate === undefined) {
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Candidate is not part of this run");
      }
      await this.#verifyCandidateForApply(active, persisted, candidate, operationSignal);
    }
    let output: WorkflowState;
    try {
      output = await active.graph.invoke(
        new Command({ resume }),
        workflowConfig(resume.runId, undefined, undefined, operationSignal),
      ) as WorkflowState;
    } catch (error) {
      if (!operationSignal.aborted) await this.#failRun(resume.runId, error);
      throw error;
    }
    operationSignal.throwIfAborted();
    const state = output;
    const run = toOptimizationRun(state);
    this.#store.saveRun(run);

    if (resume.decision === "reject") {
      context.notify({ method: "run.completed", params: { runId: run.id, candidates: run.selected } });
      await this.#releaseActive(run.id);
      return { runId: run.id, status: run.status };
    }
    const candidate = run.selected.find(({ id }) => id === resume.candidateId)
      ?? run.frontier.find(({ id }) => id === resume.candidateId);
    if (candidate === undefined) throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Candidate is not part of this run");
    const transactionScenarios = run.scenarios.filter(({ profile }) => profile === "sustainable");
    if (transactionScenarios.length !== 4) {
      throw new JsonRpcError(JsonRpcErrorCode.InternalError, "Transaction requires four sustainable scenario specs");
    }
    context.notify({
      method: "transaction.apply",
      params: { runId: run.id, candidateId: candidate.id, candidate, scenarios: transactionScenarios },
    });
    return {
      kind: "transaction-apply",
      runId: run.id,
      status: "awaiting_transaction",
      candidate,
      scenarios: transactionScenarios,
    };
    });
  }

  previewCandidate(params: RpcParams): unknown {
    const { runId, candidateId } = CandidatePreviewParamsSchema.parse(params);
    const candidate = this.#store.getCandidate(runId, candidateId);
    if (candidate === undefined) throw notFound(`Candidate not found: ${candidateId}`);
    return {
      runId,
      candidateId,
      baseFingerprint: candidate.baseFingerprint,
      summary: candidate.summary,
      diff: candidate.actions.map((action) => ({
        id: action.id,
        kind: action.kind,
        description: action.description,
        costDivine: action.costDivine ?? 0,
        preconditions: action.preconditions,
      })),
      metrics: candidate.metrics,
      scenarioMetrics: candidate.scenarioMetrics,
      peakScenarioMetrics: candidate.peakScenarioMetrics,
      evidence: candidate.evidence,
    };
  }

  recordTransactionResult(params: RpcParams, context: PlannerControllerContext): Promise<unknown> {
    return this.#trackTask(this.#recordTransactionResult(params, context));
  }

  async #recordTransactionResult(params: RpcParams, context: PlannerControllerContext): Promise<unknown> {
    const { result } = TransactionResultParamsSchema.parse(params);
    return this.#withRunOperation(result.runId, async () => {
    const persisted = this.#store.getRun(result.runId);
    if (persisted?.status === "completed" && result.applied) {
      return { runId: persisted.id, status: persisted.status, transaction: result, replayed: true };
    }
    if (persisted === undefined) throw notFound(`Run not found: ${result.runId}`);
    const candidate = persisted.selected.find(({ id }) => id === result.candidateId)
      ?? persisted.frontier.find(({ id }) => id === result.candidateId);
    if (candidate === undefined) {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Transaction candidate is not part of this run");
    }
    if (candidate.baseFingerprint !== persisted.buildFingerprint) {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Transaction candidate base fingerprint does not match the run");
    }
    if (result.applied) {
      if (result.metrics === undefined || result.scenarioMetrics === undefined || result.fingerprint === undefined) {
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Applied transaction proof is incomplete");
      }
      assertMetricSetMatches(candidate.metrics, result.metrics, "transaction");
      assertScenarioMetricsMatch(candidate.scenarioMetrics, result.scenarioMetrics);
    }
    this.#store.saveTransaction(result);
    const active = await this.#ensureActive(result.runId, context.notify, context.signal);
    const operationSignal = AbortSignal.any([active.controller.signal, context.signal]);
    operationSignal.throwIfAborted();
    let output: WorkflowState;
    try {
      output = await active.graph.invoke(
        new Command({ resume: result }),
        workflowConfig(result.runId, undefined, undefined, operationSignal),
      ) as WorkflowState;
    } catch (error) {
      if (!operationSignal.aborted) await this.#failRun(result.runId, error);
      throw error;
    }
    operationSignal.throwIfAborted();
    const run = toOptimizationRun(output);
    this.#store.saveRun(run);
    if (run.status === "failed") {
      context.notify({ method: "run.failed", params: { runId: run.id, error: run.error ?? result.error ?? "Transaction failed" } });
    } else {
      context.notify({ method: "run.completed", params: { runId: run.id, candidates: run.selected } });
    }
    await this.#releaseActive(run.id);
    return { runId: run.id, status: run.status, transaction: result };
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pause = (runId: string): void => {
      const run = this.#store.getRun(runId);
      if (run !== undefined && run.status === "running") {
        this.#store.saveRun({ ...run, status: "paused", updatedAt: new Date().toISOString() });
      }
    };
    for (const [runId, pending] of this.#pending) {
      pause(runId);
      this.#cancelled.add(runId);
      pending.abort(new Error("Planner controller closed"));
    }
    for (const [runId, active] of this.#active) {
      pause(runId);
      active.cancelled = true;
      active.controller.abort(new Error("Planner controller closed"));
      active.pool.cancel(runId);
    }
    await Promise.allSettled([...this.#tasks]);
    this.#pending.clear();
    this.#cancelled.clear();
    this.#operations.clear();
    await Promise.all([...this.#pools].map((pool) => pool.close()));
    this.#pools.clear();
    this.#active.clear();
  }

  async #start(
    runId: string,
    snapshot: BuildSnapshot,
    objective: ObjectiveSpec,
    notify: PlannerControllerContext["notify"],
  ): Promise<void> {
    let startedActive: ActiveRun | undefined;
    try {
      notify({
        method: "run.progress",
        params: {
          runId,
          phase: "WorkerStartup",
          progress: 0,
          evaluations: 0,
          frontierSize: 0,
          message: "Starting isolated PoB workers",
        },
      });
      const active = await this.#activate(runId, snapshot, objective, notify);
      startedActive = active;
      this.#pending.delete(runId);
      if (active.controller.signal.aborted) {
        active.cancelled = true;
        await this.#releaseActive(runId);
        this.#cancelled.delete(runId);
        return;
      }
      const state = await active.graph.invoke(
        createWorkflowInput({ runId, snapshot, objective }),
        workflowConfig(runId),
      ) as WorkflowState;
      if (active.cancelled) {
        await this.#releaseCancelledActive(runId, active);
        return;
      }
      const run = toOptimizationRun(state);
      this.#store.saveRun(run);
      if (run.status === "failed") {
        notify({ method: "run.failed", params: { runId, error: run.error ?? "Optimization failed" } });
        await this.#releaseActive(runId);
        return;
      }
      if (run.status === "cancelled") {
        await this.#releaseActive(runId);
        return;
      }
      notify({
        method: "run.progress",
        params: {
          runId,
          phase: "HumanApproval",
          progress: 1,
          evaluations: run.evaluations,
          frontierSize: run.frontier.length,
          message: "awaitingApproval",
        },
      });
      notify({ method: "run.awaitingApproval", params: { runId, candidates: run.selected } });
    } catch (error) {
      const active = this.#active.get(runId);
      if (startedActive?.cancelled || active?.cancelled || this.#pending.get(runId)?.signal.aborted || this.#cancelled.has(runId)) {
        await this.#releaseActive(runId);
        this.#pending.delete(runId);
        this.#cancelled.delete(runId);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const persisted = this.#store.getRun(runId);
      if (persisted !== undefined) {
        this.#store.saveRun({
          ...persisted,
          status: "failed",
          stopReason: "failed",
          error: message,
          updatedAt: new Date().toISOString(),
        });
      }
      this.#pending.delete(runId);
      notify({ method: "run.failed", params: { runId, error: message } });
      await this.#releaseActive(runId);
    } finally {
      this.#operations.delete(runId);
    }
  }

  async #createActive(
    runId: string,
    snapshot: BuildSnapshot,
    objective: ObjectiveSpec,
    notify: PlannerControllerContext["notify"],
    requestSignal?: AbortSignal,
  ): Promise<ActiveRun> {
    const existingController = this.#pending.get(runId);
    const controller = existingController ?? new AbortController();
    if (existingController === undefined) this.#pending.set(runId, controller);
    const startupSignal = requestSignal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, requestSignal]);
    let pool: EvaluationPool | undefined;
    try {
      pool = await this.#workerPoolFactory(snapshot, startupSignal);
      if (this.#cancelled.has(runId) && !controller.signal.aborted) {
        controller.abort(new Error("Run cancelled by user"));
      }
      if (startupSignal.aborted) {
        await pool.close();
        startupSignal.throwIfAborted();
      }
      if (this.#closed) {
        await pool.close();
        throw new Error("Planner controller is closed");
      }
    } catch (error) {
      if (this.#pending.get(runId) === controller) this.#pending.delete(runId);
      throw error;
    }
    const graph = createWorkflowGraph({
      checkpointer: this.#checkpointer,
      nodes: {
        inspect: (state) => ({
          artifacts: {
            inspection: {
              fingerprint: state.snapshot.fingerprint,
              ruleset: state.snapshot.ruleset,
              catalogEntries: state.snapshot.contentCatalog?.length ?? 0,
              graphNodes: state.snapshot.buildGraph?.nodes.length ?? 0,
            },
          },
        }),
        diagnose: (state) => ({
          artifacts: {
            diagnosis: {
              missingGoalMetrics: state.objective?.goals
                .map(({ metric }) => metric)
                .filter((metric) => state.snapshot.metrics[metric] === undefined) ?? [],
            },
          },
        }),
        planSearch: (state) => ({
          artifacts: {
            searchPlan: { domains: 9, proposals: state.snapshot.contentCatalog?.length ?? 0 },
          },
        }),
        searchDomains: async (state, nodeContext) => this.#search(
          runId,
          state,
          nodeContext,
          pool,
          controller.signal,
          notify,
        ),
        mergePareto: () => ({}),
        verify: () => ({ needsRefinement: false, improvementRatio: 0, paretoFrontierChanged: true }),
        refineSearch: () => ({}),
        finalVerify: (state) => {
          const result = state.transactionResult;
          if (result !== undefined && (!result.accepted || !result.applied)) {
            throw new Error(result.error ?? "Build transaction failed verification");
          }
          return {};
        },
      },
    });
    const active: ActiveRun = { graph, snapshot, objective, controller, pool, notify, cancelled: false };
    this.#pools.add(pool);
    this.#active.set(runId, active);
    if (this.#pending.get(runId) === controller) this.#pending.delete(runId);
    return active;
  }

  async #releaseActive(runId: string): Promise<void> {
    const active = this.#active.get(runId);
    if (active === undefined) return;
    this.#active.delete(runId);
    this.#pools.delete(active.pool);
    await active.pool.close();
  }

  async #releaseCancelledActive(runId: string, active: ActiveRun): Promise<void> {
    if (!active.cancelled && !this.#cancelled.has(runId)) return;
    await this.#releaseActive(runId);
    this.#pending.delete(runId);
    this.#cancelled.delete(runId);
  }

  async #activate(
    runId: string,
    snapshot: BuildSnapshot,
    objective: ObjectiveSpec,
    notify: PlannerControllerContext["notify"],
    requestSignal?: AbortSignal,
  ): Promise<ActiveRun> {
    const active = this.#active.get(runId);
    if (active !== undefined) return active;
    const existing = this.#activations.get(runId);
    if (existing !== undefined) {
      const shared = await existing;
      requestSignal?.throwIfAborted();
      return shared;
    }
    const activation = this.#createActive(runId, snapshot, objective, notify, requestSignal);
    this.#activations.set(runId, activation);
    try {
      return await activation;
    } finally {
      if (this.#activations.get(runId) === activation) this.#activations.delete(runId);
    }
  }

  async #withRunOperation<T>(
    runId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.#closed) {
      throw new JsonRpcError(JsonRpcErrorCode.InternalError, "Planner controller is closed");
    }
    if (this.#operations.has(runId)) {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Run operation already in progress: ${runId}`);
    }
    this.#operations.add(runId);
    try {
      return await operation();
    } finally {
      this.#operations.delete(runId);
    }
  }

  async #failRun(runId: string, error: unknown): Promise<void> {
    const persisted = this.#store.getRun(runId);
    if (persisted !== undefined && persisted.status !== "cancelled") {
      this.#store.saveRun({
        ...persisted,
        status: "failed",
        stopReason: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
    }
    await this.#releaseActive(runId);
  }

  async #ensureActive(
    runId: string,
    notify: PlannerControllerContext["notify"],
    requestSignal?: AbortSignal,
  ): Promise<ActiveRun> {
    const run = this.#store.getRun(runId);
    if (run === undefined) throw notFound(`Run not found: ${runId}`);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Run is terminal and cannot be resumed: ${run.status}`);
    }
    const current = this.#active.get(runId);
    if (current !== undefined) return current;
    const snapshot = this.#store.getSnapshot(run.buildFingerprint);
    if (snapshot === undefined) throw notFound(`Build snapshot not found for run: ${runId}`);
    return this.#activate(runId, snapshot, run.objective, notify, requestSignal);
  }

  async #verifyCandidateForApply(
    active: ActiveRun,
    run: OptimizationRun,
    candidate: Candidate,
    signal: AbortSignal,
  ): Promise<void> {
    if (candidate.baseFingerprint !== active.snapshot.fingerprint) {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Candidate base fingerprint no longer matches captured build");
    }
    if (!candidate.hardConstraintsSatisfied) {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Candidate violates hard constraints");
    }
    const scenarios = run.scenarios.filter(({ profile }) => profile === "sustainable");
    if (scenarios.length !== 4) {
      throw new JsonRpcError(JsonRpcErrorCode.InternalError, "Apply verification requires four sustainable scenarios");
    }
    const verificationPool = await this.#workerPoolFactory(active.snapshot, signal);
    try {
      const evaluated = await evaluateCandidateSet(
        run.id,
        active.snapshot,
        [{
          id: candidate.id,
          baseFingerprint: candidate.baseFingerprint,
          actions: candidate.actions,
          estimatedCost: candidate.cost.divine,
          metadata: { source: "currentBuild", phase: "apply-verification" },
        }],
        scenarios,
        candidate.evidence,
        verificationPool,
        signal,
        "apply-verification",
      );
      signal.throwIfAborted();
      const actual = evaluated[0];
      if (actual === undefined) throw new Error("Apply verification worker returned no candidate evaluation");
      assertScenarioMetricsMatch(candidate.scenarioMetrics, actual.metricsByScenario);
      const constraints = evaluateConstraints(
        actual,
        objectiveFromSchema(active.objective).hardConstraints,
        scenarios.map(({ id }) => id),
      );
      if (!constraints.satisfied) {
        throw new JsonRpcError(
          JsonRpcErrorCode.InvalidParams,
          "Candidate failed hard constraints during fresh apply verification",
          constraints.violations,
        );
      }
    } finally {
      await verificationPool.close();
    }
  }

  #trackTask<T>(task: Promise<T>): Promise<T> {
    this.#tasks.add(task);
    void task.then(
      () => this.#tasks.delete(task),
      () => this.#tasks.delete(task),
    );
    return task;
  }

  async #search(
    runId: string,
    state: Readonly<WorkflowState>,
    nodeContext: Readonly<WorkflowNodeContext>,
    pool: EvaluationPool,
    signal: AbortSignal,
    notify: PlannerControllerContext["notify"],
  ) {
    if (state.objective === undefined) throw new Error("Search requires confirmed objective");
    const sustainable = nodeContext.sustainableScenarios;
    const peak = nodeContext.peakScenarios;
    const baselineCost = sustainable.length;
    if (nodeContext.remaining.evaluations < baselineCost) {
      return {
        frontier: [...state.frontier],
        selected: [...state.selected],
        usage: { evaluations: 0, modelCalls: 0 },
        searchStopReason: "evaluation_limit" as const,
        providerFallback: true,
        toolCallFingerprint: canonicalHash({ runId, stopReason: "evaluation_limit" }),
      };
    }
    const scenarioIds = sustainable.map(({ id }) => id);
    const domain = prepareDomainState(state.snapshot, [...sustainable, ...peak]);
    const baseline = baselineCandidate(state.snapshot);
    const baselineEvaluation = await evaluateCandidateSet(
      runId,
      state.snapshot,
      [baseline],
      sustainable,
      domain.evidence,
      pool,
      signal,
      "baseline",
    );
    const initial = baselineEvaluation[0];
    if (initial === undefined) throw new Error("PoB worker returned no baseline evaluation");
    const domainCandidates = catalogCandidates(state.snapshot);
    const searchState: DomainSearchState<BuildAction> = {
      domainCandidates,
      buildXml: state.snapshot.xml,
      scenarioSpecs: sustainable,
      evidence: domain.evidence,
      contentCatalog: state.snapshot.contentCatalog ?? [],
      domainGraph: domain.graph.toJSON(),
      mechanicAdapterIds: domain.appliedAdapterIds,
    };
    const engine = new SearchEngine<DomainSearchState<BuildAction>, BuildAction>({
      runId,
      state: searchState,
      initialCandidates: [initial],
      sustainableScenarios: scenarioIds,
      objective: objectiveFromSchema(state.objective),
      registry: createFullDomainRegistry<DomainSearchState<BuildAction>, BuildAction>(),
      workerPool: pool,
      signal,
      limits: {
        ...DEFAULT_SEARCH_LIMITS,
        wallTimeMs: Math.max(1, nodeContext.remaining.wallTimeMs),
        evaluationLimit: nodeContext.remaining.evaluations - baselineCost,
      },
      store: this.#store,
      cacheContext: {
        engineCommit: state.snapshot.engineVersion,
        ruleset: `${state.snapshot.ruleset}:${state.snapshot.dataVersion}`,
        buildFingerprint: state.snapshot.fingerprint,
        objectiveVersion: state.objective.schemaVersion,
      },
      onProgress: (progress) => {
        persistSearchSnapshot(
          this.#store,
          runId,
          state,
          sustainable.length,
          progress.frontier,
          domain.evidence,
          progress.evaluations,
        );
        sendSearchProgress(runId, progress, notify);
      },
    });
    const result = await engine.run();
    const sustainableFrontier = result.frontier.map((candidate) => publicCandidate(
      candidate,
      "Balanced",
      state.objective!,
      {},
      domain.evidence,
    ));
    persistSearchSnapshot(
      this.#store,
      runId,
      state,
      sustainable.length,
      result.frontier,
      domain.evidence,
      result.evaluations,
      result.stopReason,
      selectedCandidates(result, sustainableFrontier, state.objective),
    );
    const remainingAfterSustainable = nodeContext.remaining.evaluations - baselineCost - result.evaluations;
    const peakCost = result.frontier.length * peak.length;
    const evaluatePeakNow = result.stopReason !== "cancelled" && peakCost <= remainingAfterSustainable;
    const peakByCandidate = !evaluatePeakNow
      ? new Map<string, Readonly<Record<string, MetricSet>>>()
      : await evaluatePeak(
          runId,
          state.snapshot,
          result.frontier,
          peak,
          domain.evidence,
          pool,
          signal,
        );
    const publicFrontier = result.frontier.map((candidate) => publicCandidate(
      candidate,
      "Balanced",
      state.objective!,
      peakByCandidate.get(candidate.id) ?? {},
      domain.evidence,
    ));
    const selected = selectedCandidates(result, publicFrontier, state.objective);
    return {
      frontier: publicFrontier,
      selected,
      usage: {
        evaluations: baselineCost + result.evaluations + (evaluatePeakNow ? peakCost : 0),
        modelCalls: result.modelCalls,
      },
      artifacts: {
        search: { stopReason: result.stopReason, rounds: result.rounds },
        provider: { configured: false, mode: "deterministic_fallback" },
        domainGraph: {
          nodes: domain.graph.toJSON().nodes.length,
          edges: domain.graph.toJSON().edges.length,
          mechanicAdapters: domain.appliedAdapterIds,
          evidence: domain.evidence.length,
        },
      },
      searchStopReason: result.stopReason,
      providerFallback: true,
      toolCallFingerprint: canonicalHash({ runId, frontier: publicFrontier.map(({ id }) => id) }),
    };
  }
}

function baselineCandidate(snapshot: BuildSnapshot): SearchCandidate<BuildAction> {
  return {
    id: `baseline:${canonicalHash(snapshot.fingerprint).slice(0, 16)}`,
    baseFingerprint: snapshot.fingerprint,
    actions: [],
    estimatedCost: 0,
    metadata: { source: "currentBuild" },
  };
}

function catalogCandidates(snapshot: BuildSnapshot): Partial<Record<SearchDomain, SearchCandidate<BuildAction>[]>> {
  const output: Partial<Record<SearchDomain, SearchCandidate<BuildAction>[]>> = {};
  for (const entry of snapshot.contentCatalog ?? []) {
    if (!entry.available) continue;
    const actions = parseCatalogActions(entry.id, entry.data);
    const metadata = SourceMetadataSchema.catch({}).parse(entry.data["metadata"] ?? entry.data);
    actions.forEach((action, index) => {
      const candidate: SearchCandidate<BuildAction> = {
        id: `catalog:${entry.id}:${index + 1}`,
        baseFingerprint: snapshot.fingerprint,
        actions: [action],
        domain: entry.domain,
        estimatedCost: action.costDivine ?? 0,
        metadata: {
          ...metadata,
          ...(metadata.source !== undefined
            ? { source: metadata.source }
            : entry.kind === "currentBuild" && entry.id.startsWith("pob:")
              ? { source: "currentBuild" as const }
              : {}),
          catalogId: entry.id,
        },
      };
      const current = output[entry.domain] ?? [];
      current.push(candidate);
      output[entry.domain] = current;
    });
  }
  return output;
}

function parseCatalogActions(entryId: string, data: Readonly<Record<string, unknown>>): BuildAction[] {
  const raw = [
    ...(Array.isArray(data["actions"]) ? data["actions"] : [data["action"]]),
    ...(Array.isArray(data["actionCandidates"]) ? data["actionCandidates"] : []),
  ].filter((value) => value !== undefined);
  return raw.flatMap((action, index) => {
    const candidate = isRecord(action) && typeof action.kind === "string" && isRecord(action.payload)
      ? {
          id: typeof action.id === "string" ? action.id : `action:${entryId}:${index + 1}`,
          description: typeof action.description === "string"
            ? action.description
            : `Apply ${action.kind} proposal from ${entryId}`,
          kind: action.kind,
          dependsOn: Array.isArray(action.dependsOn) ? action.dependsOn : [],
          preconditions: Array.isArray(action.preconditions) || isRecord(action.preconditions)
            ? action.preconditions
            : [],
          reversible: action.reversible !== false,
          payload: action.payload,
          ...(typeof action.costDivine === "number" ? { costDivine: action.costDivine } : {}),
        }
      : action;
    const parsed = BuildActionSchema.safeParse(candidate);
    return parsed.success ? [parsed.data] : [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareDomainState(
  snapshot: BuildSnapshot,
  scenarios: readonly ScenarioSpec[],
): {
  readonly graph: DomainGraph;
  readonly evidence: readonly ConditionEvidence[];
  readonly appliedAdapterIds: readonly string[];
} {
  const catalog = snapshot.contentCatalog ?? [];
  const baseGraph = snapshot.buildGraph === undefined
    ? DomainGraph.fromCatalog(catalog)
    : new DomainGraph(snapshot.buildGraph);
  for (const entry of catalog) {
    if (!baseGraph.hasNode(entry.id)) {
      baseGraph.addNode({
        id: entry.id,
        domain: entry.domain,
        kind: entry.kind,
        data: { ...entry.data, available: entry.available },
      });
    }
  }
  const applied = createDefaultMechanicAdapterRegistry().apply(baseGraph, {
    ruleset: snapshot.ruleset,
    dataVersion: snapshot.dataVersion,
    catalog,
  });
  const evidence = scenarios
    .filter((scenario) => scenario.profile === "sustainable" || scenario.profile === "peak")
    .flatMap((scenario) => resolveConditionEvidence(
      applied.conditionClaims as readonly ConditionClaimInput[],
      scenario,
    ).evidence);
  return {
    graph: applied.graph,
    evidence,
    appliedAdapterIds: applied.appliedAdapterIds,
  };
}

async function evaluatePeak(
  runId: string,
  snapshot: BuildSnapshot,
  candidates: readonly EvaluatedCandidate<BuildAction>[],
  scenarios: readonly ScenarioSpec[],
  evidence: readonly ConditionEvidence[],
  pool: EvaluationPool,
  signal: AbortSignal,
): Promise<Map<string, Readonly<Record<string, MetricSet>>>> {
  const result = new Map<string, Readonly<Record<string, MetricSet>>>();
  if (scenarios.length === 0) return result;
  const evaluations = await evaluateCandidateSet(
    runId,
    snapshot,
    candidates,
    scenarios,
    evidence,
    pool,
    signal,
    "peak",
  );
  for (const evaluation of evaluations) result.set(evaluation.id, evaluation.metricsByScenario);
  return result;
}

async function evaluateCandidateSet(
  runId: string,
  snapshot: BuildSnapshot,
  candidates: readonly SearchCandidate<BuildAction>[],
  scenarios: readonly ScenarioSpec[],
  evidence: readonly ConditionEvidence[],
  pool: EvaluationPool,
  signal: AbortSignal,
  phase: string,
): Promise<EvaluatedCandidate<BuildAction>[]> {
  const jobs = candidates.map((candidate) => ({
    id: `${runId}:${phase}:${candidate.id}`,
    runId,
    candidateId: candidate.id,
    buildFingerprint: snapshot.fingerprint,
    scenarios: scenarios.map(({ id, profile }) => profile === "peak" ? `${id}:peak` : id),
    payload: { xml: snapshot.xml, actions: candidate.actions, scenarios, evidence },
  }));
  const evaluations = await pool.evaluateBatch(jobs, signal);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  return evaluations.map((evaluation) => {
    const candidate = byId.get(evaluation.candidateId);
    if (candidate === undefined) throw new Error(`Worker returned unknown candidate: ${evaluation.candidateId}`);
    return { ...candidate, metricsByScenario: evaluation.metricsByScenario };
  });
}

function assertScenarioMetricsMatch(
  expectedByScenario: Readonly<Record<string, MetricSet>>,
  actualByScenario: Readonly<Record<string, MetricSet>>,
): void {
  for (const [scenario, expected] of Object.entries(expectedByScenario)) {
    const actual = actualByScenario[scenario];
    if (actual === undefined) {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Apply verification missing scenario: ${scenario}`);
    }
    assertMetricSetMatches(expected, actual, scenario);
  }
}

function assertMetricSetMatches(
  expected: Readonly<MetricSet>,
  actual: Readonly<MetricSet>,
  prefix: string,
): void {
  for (const [metric, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[metric];
    const scale = Math.max(1, Math.abs(expectedValue), Math.abs(actualValue ?? Number.NaN));
    if (actualValue === undefined || !Number.isFinite(actualValue)
      || Math.abs(expectedValue - actualValue) > scale * 1e-6) {
      throw new JsonRpcError(
        JsonRpcErrorCode.InvalidParams,
        `Apply verification metric mismatch: ${prefix}.${metric}`,
        { expected: expectedValue, actual: actualValue },
      );
    }
  }
}

function publicCandidate(
  candidate: EvaluatedCandidate<BuildAction>,
  label: CandidateLabel,
  objective: ObjectiveSpec,
  peakMetrics: Readonly<Record<string, MetricSet>>,
  evidence: readonly ConditionEvidence[],
): Candidate {
  const cost = candidate.estimatedCost ?? candidate.actions.reduce((sum, action) => sum + (action.costDivine ?? 0), 0);
  const primaryMetrics = candidate.metricsByScenario[objective.primaryScenario] ?? {};
  const actionSummary = candidate.actions.length === 0
    ? "Current build baseline; no mutation required."
    : candidate.actions.map(({ description }) => description).join("; ");
  return {
    schemaVersion: SCHEMA_VERSION,
    id: candidate.id,
    label,
    summary: actionSummary,
    baseFingerprint: candidate.baseFingerprint,
    cost: { divine: cost, display: cost === 0 ? "No paid-source cost" : `${cost.toFixed(2)} Divine` },
    metrics: { ...primaryMetrics },
    scenarioMetrics: exactScenarioMetrics(candidate.metricsByScenario),
    peakScenarioMetrics: exactScenarioMetrics(peakMetrics),
    actions: [...candidate.actions],
    evidence: [...evidence],
    hardConstraintsSatisfied: true,
  };
}

function selectedCandidates(
  result: SearchResult<BuildAction>,
  frontier: readonly Candidate[],
  objective: ObjectiveSpec,
): Candidate[] {
  const choices: ReadonlyArray<readonly [CandidateLabel, EvaluatedCandidate<BuildAction> | undefined]> = [
    ["Offence", result.selections.offence],
    ["Balanced", result.selections.balanced],
    ["Defence", result.selections.defence],
  ];
  const fallback = frontier[0];
  return choices.flatMap(([label, selected]) => {
    const source = frontier.find(({ id }) => id === selected?.id) ?? fallback;
    if (source === undefined) return [];
    return [{
      ...source,
      id: `${source.id}:${label.toLowerCase()}`,
      label,
      summary: `${label}: ${source.summary}`,
      metrics: { ...(source.scenarioMetrics[objective.primaryScenario] ?? source.metrics) },
    }];
  });
}

function exactScenarioMetrics(metrics: Readonly<Record<string, MetricSet>>): Record<RankedScenarioId, MetricSet> {
  return {
    mapping: { ...(metrics["mapping"] ?? metrics["mapping:peak"] ?? {}) },
    standardBoss: { ...(metrics["standardBoss"] ?? metrics["standardBoss:peak"] ?? {}) },
    pinnacle: { ...(metrics["pinnacle"] ?? metrics["pinnacle:peak"] ?? {}) },
    uber: { ...(metrics["uber"] ?? metrics["uber:peak"] ?? {}) },
  };
}

function persistSearchSnapshot(
  store: PlannerStore,
  runId: string,
  state: Readonly<WorkflowState>,
  baselineEvaluations: number,
  frontier: readonly EvaluatedCandidate<BuildAction>[],
  evidence: readonly ConditionEvidence[],
  searchEvaluations: number,
  searchStopReason?: SearchStopReason,
  selected?: readonly Candidate[],
): void {
  if (state.objective === undefined) return;
  const persisted = store.getRun(runId);
  if (persisted === undefined || persisted.status === "completed" || persisted.status === "failed") return;
  const publicFrontier = frontier.map((candidate) => publicCandidate(
    candidate,
    "Balanced",
    state.objective!,
    {},
    evidence,
  ));
  store.saveRun({
    ...persisted,
    scenarios: [...state.scenarios],
    frontier: publicFrontier,
    ...(selected === undefined ? {} : { selected: [...selected] }),
    evaluations: Math.max(persisted.evaluations, state.evaluations + baselineEvaluations + searchEvaluations),
    ...(searchStopReason === undefined ? {} : { searchStopReason }),
    updatedAt: new Date().toISOString(),
  });
}

function sendSearchProgress(
  runId: string,
  progress: SearchProgress<BuildAction>,
  notify: PlannerControllerContext["notify"],
): void {
  notify({
    method: "run.progress",
    params: {
      runId,
      phase: progress.domain ?? progress.phase,
      progress: Math.min(0.95, progress.round / 40),
      evaluations: progress.evaluations,
      frontierSize: progress.frontier.length,
      message: `Searching ${progress.domain ?? progress.phase}`,
    },
  });
}

function notFound(message: string): JsonRpcError {
  return new JsonRpcError(JsonRpcErrorCode.InvalidParams, message);
}
