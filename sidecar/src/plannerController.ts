import { randomUUID } from "node:crypto";
import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import { z } from "zod";
import type {
  BuildAction,
  BuildSnapshot,
  BuildMechanicReport,
  VerifiedBuildMechanicReport,
  Candidate,
  CandidateLabel,
  ConditionEvidence,
  MetricSet,
  ObjectiveSpec,
  OptimizationRun,
  RankedScenarioId,
  ScenarioSpec,
  SearchStopReason,
  TradeCatalogQuery,
  TradeCatalogResult,
} from "./schemas.js";
import {
  DomainGraph,
  createDefaultCoverageRegistry,
  analyzeBuildMechanics,
  createDefaultMechanicAdapterRegistry,
  diffMechanics,
  resolveConditionEvidence,
  type ConditionClaimInput,
} from "./domain/index.js";
import {
  BuildActionSchema,
  ConditionEvidenceSchema,
  MechanicDiffSchema,
  VerifiedBuildMechanicReportSchema,
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
import { ReadonlyToolDispatcher, runReadonlyAgentLoop } from "./agent/index.js";
import type { HighLevelToolName } from "./llm/toolSchemas.js";
import type { ModelAdapter } from "./llm/types.js";
import {
  MECHANIC_TOOL_REGISTRY,
  MechanicProviderError,
  MechanicUnderstandingEngine,
  PoolMechanicExperimentRunner,
  type MechanicProgress,
  type MechanicToolName,
  type PobWorkerMechanicPayload,
} from "./mechanics/index.js";
import {
  ConsentGrantParamsSchema,
  ConsentPreviewParamsSchema,
  ConsentRevokeParamsSchema,
  BuildCaptureParamsSchema,
  BuildAnalyzeParamsSchema,
  CandidatePreviewParamsSchema,
  HelloParamsSchema,
  ObjectiveDraftParamsSchema,
  ProviderClearParamsSchema,
  ProviderConfigureParamsSchema,
  ProviderModelsListParamsSchema,
  ProviderTestParamsSchema,
  ProviderTestPreviewParamsSchema,
  ProviderStatusParamsSchema,
  RunCancelParamsSchema,
  RunResumeParamsSchema,
  RunStartParamsSchema,
  RunStreamParamsSchema,
  TransactionResultParamsSchema,
  MechanicsStartParamsSchema,
  MechanicsStatusParamsSchema,
  MechanicsCancelParamsSchema,
} from "./protocol.js";
import {
  EphemeralPlannerChatService,
  type ConsentDataCategory,
  DEFAULT_CONSENT_DATA_CATEGORIES,
  ProviderModelAdapterFactory,
  ProviderProfileService,
} from "./provider/index.js";
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
  AwaitingProviderError,
} from "./workflow/index.js";

type EvaluationPool = WorkerPool<PobWorkerEvaluatePayload<BuildAction>, WorkerEvaluation>;
type MechanicPool = WorkerPool<PobWorkerMechanicPayload, WorkerEvaluation>;
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
  readonly providerController: AbortController;
  readonly providerId: string;
  readonly tradeAccess: TradeAccess;
  readonly mechanicReport: VerifiedBuildMechanicReport;
  notify: PlannerControllerContext["notify"];
  cancelled: boolean;
}

interface ActiveMechanicAnalysis {
  readonly id: string;
  readonly snapshotFingerprint: string;
  readonly controller: AbortController;
  notify: PlannerControllerContext["notify"];
  status: "running" | "completed" | "failed" | "cancelled";
  progress?: MechanicProgress;
  report?: VerifiedBuildMechanicReport;
  error?: string;
  retryable?: boolean;
}

interface TradeAccess {
  requestTradeCatalog: PlannerControllerContext["requestTradeCatalog"];
  cancelTradeCatalog: PlannerControllerContext["cancelTradeCatalog"];
}

interface PlannerControllerOptions {
  readonly store: PlannerStore;
  readonly checkpointer: BaseCheckpointSaver;
  readonly workerPoolFactory?: WorkerPoolFactory;
  readonly providerService?: ProviderProfileService;
  readonly modelAdapterFactory?: Pick<ProviderModelAdapterFactory, "create">;
  readonly mechanicEngineFactory?: (
    pool: MechanicPool,
    runId: string,
    onProgress?: (progress: MechanicProgress) => void,
  ) => Promise<Pick<MechanicUnderstandingEngine, "understand">> | Pick<MechanicUnderstandingEngine, "understand">;
  readonly providerId?: string;
}

const SourceMetadataSchema = z.object({
  source: z.enum(["currentBuild", "unique", "targetRare", "trade"]).optional(),
  touches: z.array(z.string()).optional(),
});

export class DefaultPlannerController implements PlannerController {
  readonly #store: PlannerStore;
  readonly #checkpointer: BaseCheckpointSaver;
  readonly #workerPoolFactory: WorkerPoolFactory;
  readonly #providerService: ProviderProfileService | undefined;
  readonly #modelAdapterFactory: Pick<ProviderModelAdapterFactory, "create"> | undefined;
  readonly #mechanicEngineFactory: PlannerControllerOptions["mechanicEngineFactory"];
  readonly #providerId: string;
  readonly #pendingConsent = new Map<string, {
    consentKey: string;
    payloadHash: string;
    dataCategories: readonly ConsentDataCategory[];
  }>();
  readonly #pendingProviderTests = new Map<string, {
    baseURL: string;
    model: string;
    authMode: "bearer" | "none";
    apiMode: "auto" | "chat_completions" | "responses";
    reasoningMode: "auto" | "off" | "fast" | "balanced" | "deep";
    consentKey: string;
    payloadHash: string;
  }>();
  readonly #active = new Map<string, ActiveRun>();
  readonly #mechanicAnalyses = new Map<string, ActiveMechanicAnalysis>();
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
    this.#providerService = options.providerService;
    this.#modelAdapterFactory = options.modelAdapterFactory;
    this.#mechanicEngineFactory = options.mechanicEngineFactory;
    this.#providerId = options.providerId ?? "openai";
  }

  async hello(params: RpcParams): Promise<unknown> {
    const hello = HelloParamsSchema.parse(params);
    const providerStatus = this.#providerService === undefined
      ? undefined
      : await this.#providerService.status(this.#providerId);
    return {
      protocolVersion: PROTOCOL_VERSION,
      serverName: "AIPathOfBuilding Sidecar",
      serverVersion: "0.1.0",
      capabilities: {
        workflowGraph: true,
        domainGraph: true,
        deterministicFallback: false,
        humanGatedTransactions: true,
        nativeLinkProbe: true,
        nativeEvidence: true,
        mechanicAnalysis: true,
        tradeBroker: hello.capabilities.includes("tradeBroker"),
        providerConsent: this.#providerService !== undefined,
        providerConnectionTest: this.#providerService !== undefined
          && hello.capabilities.includes("providerConnectionTest"),
        providerCompatibility: this.#providerService !== undefined
          && hello.capabilities.includes("providerCompatibility"),
        objectiveDraft: this.#modelAdapterFactory !== undefined,
        trade: hello.capabilities.includes("tradeBroker"),
        providerConfigured: providerStatus?.configured === true && providerStatus.credentialConfigured,
      },
      client: hello,
    };
  }

  async providerStatus(params: RpcParams): Promise<unknown> {
    const parsed = ProviderStatusParamsSchema.parse(params);
    const providerId = parsed.providerId ?? this.#providerId;
    if (this.#providerService === undefined) {
      return {
        providerId,
        configured: false,
        credentialConfigured: false,
        consent: "required",
        unavailableReason: "Windows Credential Manager helper is unavailable",
      };
    }
    return { providerId, ...(await this.#providerService.status(providerId)) };
  }

  async configureProvider(params: RpcParams): Promise<unknown> {
    if (this.#providerService === undefined) throw providerUnavailable();
    const parsed = ProviderConfigureParamsSchema.parse(params);
    const profile = await this.#providerService.configure({
      providerId: parsed.providerId,
      baseURL: parsed.baseUrl,
      model: parsed.model,
      authMode: parsed.authMode,
      apiMode: parsed.apiMode,
      reasoningMode: parsed.reasoningMode,
      testId: parsed.testId,
      ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
    });
    this.#pendingConsent.delete(parsed.providerId);
    this.#pendingProviderTests.delete(parsed.providerId);
    return { providerId: profile.providerId, ...(await this.#providerService.status(profile.providerId)) };
  }

  async listProviderModels(params: RpcParams, context: PlannerControllerContext): Promise<unknown> {
    if (this.#providerService === undefined) throw providerUnavailable();
    const parsed = ProviderModelsListParamsSchema.parse(params);
    const models = await this.#providerService.listModels({
      providerId: parsed.providerId,
      baseURL: parsed.baseUrl,
      authMode: parsed.authMode,
      ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
    }, context.signal);
    return { models };
  }

  async previewProviderTest(params: RpcParams): Promise<unknown> {
    if (this.#providerService === undefined) throw providerUnavailable();
    const parsed = ProviderTestPreviewParamsSchema.parse(params);
    const preview = this.#providerService.previewConnectionTest({
      providerId: parsed.providerId,
      baseURL: parsed.baseUrl,
      model: parsed.model,
      authMode: parsed.authMode,
      apiMode: parsed.apiMode,
      reasoningMode: parsed.reasoningMode,
    });
    this.#pendingProviderTests.set(parsed.providerId, {
      baseURL: preview.endpoint,
      model: preview.model,
      authMode: parsed.authMode,
      apiMode: parsed.apiMode,
      reasoningMode: parsed.reasoningMode,
      consentKey: preview.consentKey,
      payloadHash: preview.payloadPreview.redactedHash,
    });
    return preview;
  }

  async testProviderConnection(params: RpcParams, context: PlannerControllerContext): Promise<unknown> {
    if (this.#providerService === undefined) throw providerUnavailable();
    const parsed = ProviderTestParamsSchema.parse(params);
    const pending = this.#pendingProviderTests.get(parsed.providerId);
    this.#pendingProviderTests.delete(parsed.providerId);
    if (pending === undefined
      || pending.baseURL !== this.#providerService.previewConnectionTest({
        providerId: parsed.providerId,
        baseURL: parsed.baseUrl,
        model: parsed.model,
        authMode: parsed.authMode,
        apiMode: parsed.apiMode,
        reasoningMode: parsed.reasoningMode,
      }).endpoint
      || pending.model !== parsed.model
      || pending.authMode !== parsed.authMode
      || pending.apiMode !== parsed.apiMode
      || pending.reasoningMode !== parsed.reasoningMode
      || pending.consentKey !== parsed.consentKey
      || pending.payloadHash !== parsed.payloadHash) {
      throw new JsonRpcError(JsonRpcErrorCode.Conflict, "Connection test authorization is missing or stale");
    }
    return this.#providerService.testConnection({
      providerId: parsed.providerId,
      baseURL: parsed.baseUrl,
      model: parsed.model,
      authMode: parsed.authMode,
      apiMode: parsed.apiMode,
      reasoningMode: parsed.reasoningMode,
      ...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
      consentKey: parsed.consentKey,
      payloadHash: parsed.payloadHash,
    }, context.signal);
  }

  async clearProvider(params: RpcParams): Promise<unknown> {
    if (this.#providerService === undefined) throw providerUnavailable();
    const { providerId } = ProviderClearParamsSchema.parse(params);
    const profile = await this.#providerService.profiles.get(providerId);
    if (profile !== undefined) await this.#providerService.credentials.delete(profile.credentialTarget);
    await this.#providerService.profiles.delete(providerId);
    await this.#providerService.revokeConsent(providerId);
    this.#pendingConsent.delete(providerId);
    this.#pendingProviderTests.delete(providerId);
    this.#providerService.clearSuccessfulTests(providerId);
    return { providerId, configured: false, credentialConfigured: false, consent: "revoked" };
  }

  async previewConsent(params: RpcParams): Promise<unknown> {
    if (this.#providerService === undefined) throw providerUnavailable();
    const parsed = ConsentPreviewParamsSchema.parse(params);
    const snapshot = parsed.snapshotFingerprint === undefined
      ? undefined
      : this.#store.getSnapshot(parsed.snapshotFingerprint);
    if (parsed.snapshotFingerprint !== undefined && snapshot === undefined) {
      throw notFound(`Build snapshot not found: ${parsed.snapshotFingerprint}`);
    }
    const preview = await this.#providerService.preview(parsed.providerId, {
      dataCategories: parsed.dataCategories,
      snapshot,
    }, parsed.dataCategories);
    this.#pendingConsent.set(parsed.providerId, {
      consentKey: preview.consentKey,
      payloadHash: preview.payloadPreview.redactedHash,
      dataCategories: preview.dataCategories,
    });
    return preview;
  }

  async grantConsent(params: RpcParams): Promise<unknown> {
    if (this.#providerService === undefined) throw providerUnavailable();
    const parsed = ConsentGrantParamsSchema.parse(params);
    const pending = this.#pendingConsent.get(parsed.providerId);
    if (pending === undefined || pending.consentKey !== parsed.consentKey || pending.payloadHash !== parsed.payloadHash) {
      throw new JsonRpcError(JsonRpcErrorCode.Conflict, "Consent preview is missing or stale");
    }
    const record = await this.#providerService.grantConsent(
      parsed.providerId,
      parsed.consentKey,
      pending.dataCategories,
    );
    this.#pendingConsent.delete(parsed.providerId);
    return record;
  }

  async revokeConsent(params: RpcParams): Promise<unknown> {
    if (this.#providerService === undefined) throw providerUnavailable();
    const { providerId } = ConsentRevokeParamsSchema.parse(params);
    await this.#providerService.revokeConsent(providerId);
    for (const active of this.#active.values()) {
      if (active.providerId === providerId) active.providerController.abort(new Error("Provider consent revoked"));
    }
    this.#pendingConsent.delete(providerId);
    this.#pendingProviderTests.delete(providerId);
    this.#providerService.clearSuccessfulTests(providerId);
    return { providerId, consent: "revoked" };
  }

  async draftObjective(params: RpcParams, context: PlannerControllerContext): Promise<unknown> {
    if (this.#modelAdapterFactory === undefined) throw providerUnavailable();
    const parsed = ObjectiveDraftParamsSchema.parse(params);
    const snapshot = parsed.snapshotFingerprint === undefined
      ? undefined
      : this.#store.getSnapshot(parsed.snapshotFingerprint);
    if (parsed.snapshotFingerprint !== undefined && snapshot === undefined) {
      throw notFound(`Build snapshot not found: ${parsed.snapshotFingerprint}`);
    }
    const adapter = await this.#modelAdapterFactory.create(parsed.providerId);
    const chat = new EphemeralPlannerChatService(adapter);
    const result = await chat.draftObjective({
      messages: [{ role: "user", content: parsed.message }],
      context: { currentObjective: parsed.currentObjective, snapshot },
    }, context.signal);
    if (result.kind !== "draft") return result;
    const knownMetrics = new Set(Object.keys(snapshot?.metrics ?? {}));
    const unresolved = [
      ...(result.draft.goals ?? []).filter(({ metric }) => knownMetrics.size > 0 && !knownMetrics.has(metric))
        .map(({ metric }) => ({ kind: "goal", metric })),
      ...(result.draft.hardConstraints ?? []).filter(({ metric }) => knownMetrics.size > 0 && !knownMetrics.has(metric))
        .map(({ metric }) => ({ kind: "hardConstraint", metric })),
    ];
    return {
      ...result,
      unresolved,
      warnings: knownMetrics.size === 0
        ? ["Snapshot metric catalog unavailable; draft metrics require manual confirmation"]
        : unresolved.length > 0
          ? ["Unknown metrics were left unresolved and cannot become confirmed constraints"]
          : [],
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

  analyzeBuild(params: RpcParams): BuildMechanicReport {
    const { snapshotFingerprint } = BuildAnalyzeParamsSchema.parse(params);
    const snapshot = this.#store.getSnapshot(snapshotFingerprint);
    if (snapshot === undefined) throw notFound(`Build snapshot not found: ${snapshotFingerprint}`);
    return analyzeBuildMechanics(snapshot);
  }

  startMechanicAnalysis(params: RpcParams, context: PlannerControllerContext): unknown {
    if (this.#closed) throw new JsonRpcError(JsonRpcErrorCode.InternalError, "Planner controller is closed");
    const parsed = MechanicsStartParamsSchema.parse(params);
    const snapshot = this.#store.getSnapshot(parsed.snapshotFingerprint);
    if (snapshot === undefined) throw notFound(`Build snapshot not found: ${parsed.snapshotFingerprint}`);
    if (this.#modelAdapterFactory === undefined || this.#providerService === undefined) throw providerUnavailable();
    const analysisId = randomUUID();
    const active: ActiveMechanicAnalysis = {
      id: analysisId,
      snapshotFingerprint: snapshot.fingerprint,
      controller: new AbortController(),
      notify: context.notify,
      status: "running",
    };
    this.#mechanicAnalyses.set(analysisId, active);
    this.#trackTask(this.#runMechanicAnalysis(active, snapshot, parsed.force));
    return { analysisId, snapshotFingerprint: snapshot.fingerprint, status: "running" };
  }

  mechanicAnalysisStatus(params: RpcParams, context: PlannerControllerContext): unknown {
    const { analysisId } = MechanicsStatusParamsSchema.parse(params);
    const active = this.#mechanicAnalyses.get(analysisId);
    if (active === undefined) throw notFound(`Mechanic analysis not found: ${analysisId}`);
    active.notify = context.notify;
    return {
      analysisId,
      snapshotFingerprint: active.snapshotFingerprint,
      status: active.status,
      ...(active.progress === undefined ? {} : { progress: active.progress }),
      ...(active.report === undefined ? {} : { report: active.report }),
      ...(active.error === undefined ? {} : { error: active.error, retryable: active.retryable ?? false }),
    };
  }

  cancelMechanicAnalysis(params: RpcParams): unknown {
    const { analysisId } = MechanicsCancelParamsSchema.parse(params);
    const active = this.#mechanicAnalyses.get(analysisId);
    if (active === undefined) throw notFound(`Mechanic analysis not found: ${analysisId}`);
    if (active.status === "completed" || active.status === "failed" || active.status === "cancelled") {
      return { analysisId, status: active.status };
    }
    active.status = "cancelled";
    active.controller.abort(new Error("Mechanic analysis cancelled by user"));
    return { analysisId, status: "cancelled" };
  }

  async #runMechanicAnalysis(
    active: ActiveMechanicAnalysis,
    snapshot: BuildSnapshot,
    force: boolean,
  ): Promise<void> {
    let pool: EvaluationPool | undefined;
    try {
      pool = await this.#workerPoolFactory(snapshot, active.controller.signal);
      this.#pools.add(pool);
      const engine = await this.#createMechanicEngine(
        pool as unknown as MechanicPool,
        `mechanics:${active.id}`,
        (next) => {
          active.progress = next;
          active.notify({
            method: "mechanics.progress",
            params: {
              analysisId: active.id,
              snapshotFingerprint: snapshot.fingerprint,
              ...next,
            },
          });
        },
      );
      const report = await engine.understand(snapshot, {
        contexts: ["weaponSet1", "weaponSet2"],
        force,
      }, active.controller.signal);
      if (active.status === "cancelled") return;
      active.status = "completed";
      active.report = report;
      active.notify({
        method: "mechanics.completed",
        params: { analysisId: active.id, snapshotFingerprint: snapshot.fingerprint, report },
      });
    } catch (error) {
      if (active.status === "cancelled" || active.controller.signal.aborted) return;
      active.status = "failed";
      const message = error instanceof Error ? error.message : String(error);
      active.error = message;
      active.retryable = error instanceof MechanicProviderError && error.retryable;
      active.notify({
        method: "mechanics.failed",
        params: {
          analysisId: active.id,
          snapshotFingerprint: snapshot.fingerprint,
          error: message,
          retryable: active.retryable,
        },
      });
    } finally {
      if (pool !== undefined) {
        this.#pools.delete(pool);
        await pool.close();
      }
    }
  }

  async #createMechanicEngine(
    pool: MechanicPool,
    runId: string,
    onProgress?: (progress: MechanicProgress) => void,
  ): Promise<MechanicUnderstandingEngine> {
    if (this.#mechanicEngineFactory !== undefined) {
      return await this.#mechanicEngineFactory(pool, runId, onProgress) as MechanicUnderstandingEngine;
    }
    if (this.#modelAdapterFactory === undefined || this.#providerService === undefined) throw providerUnavailable();
    const status = await this.#providerService.status(this.#providerId);
    if (!status.configured || !status.credentialConfigured || status.profile === undefined) throw providerUnavailable();
    if (status.consent !== "granted") {
      throw new JsonRpcError(JsonRpcErrorCode.Conflict, "Provider consent is required for mechanic facts and experiment results");
    }
    const adapter = await this.#modelAdapterFactory.create<MechanicToolName>(this.#providerId, {
      toolRegistry: MECHANIC_TOOL_REGISTRY,
      dataCategories: DEFAULT_CONSENT_DATA_CATEGORIES,
    });
    return new MechanicUnderstandingEngine({
      provider: adapter,
      providerDescriptor: {
        providerId: status.profile.providerId,
        endpoint: status.profile.baseURL,
        model: status.profile.model,
        apiMode: status.profile.resolvedApiMode,
        reasoningMode: status.profile.reasoningMode,
      },
      worker: new PoolMechanicExperimentRunner(pool, runId),
      store: this.#store,
      checkpointer: this.#checkpointer,
      ...(onProgress === undefined ? {} : { onProgress }),
    });
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
    const tradeEnabled = budgetEnabled
      && normalized.candidateSources.trade
      && normalized.tradeContext !== undefined
      && context.requestTradeCatalog !== undefined;
    const externalDisabled = (normalized.candidateSources.trade && !tradeEnabled)
      || (normalized.candidateSources.uniques && !uniqueEnabled)
      || (normalized.candidateSources.targetRares && !targetRareEnabled);
    const objective: ObjectiveSpec = {
      ...normalized,
      candidateSources: {
        currentBuild: true,
        uniques: uniqueEnabled,
        targetRares: targetRareEnabled,
        trade: tradeEnabled,
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
      ...(parsed.mechanicAnalysisFingerprint === undefined
        ? {}
        : { mechanicAnalysisFingerprint: parsed.mechanicAnalysisFingerprint }),
      startedAt: now,
      updatedAt: now,
    });
    this.#pending.set(runId, new AbortController());
    this.#operations.add(runId);
    const task = this.#start(runId, snapshot, objective, context, parsed.mechanicAnalysisFingerprint);
    this.#trackTask(task);
    return {
      runId,
      status: "running",
      ...(externalDisabled ? {
        warnings: ["External item search disabled: requested external sources unavailable; continuing with connected deterministic catalogs"],
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
      awaitingProvider: run.awaitingProvider,
      mechanicAnalysisFingerprint: run.mechanicAnalysisFingerprint,
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
    if (persisted.awaitingProvider !== undefined) {
      if (!("decision" in resume) || !["retryProvider", "cancelProvider"].includes(resume.decision)) {
        throw new JsonRpcError(JsonRpcErrorCode.Conflict, "Run is awaiting Provider; only retryProvider or cancelProvider is allowed");
      }
      if (resume.decision === "cancelProvider") {
        const cancelled: OptimizationRun = {
          ...persisted,
          status: "cancelled",
          stopReason: "cancelled",
          error: resume.reason ?? "Cancelled while awaiting Provider",
          awaitingProvider: undefined,
          updatedAt: new Date().toISOString(),
        };
        this.#store.saveRun(cancelled);
        await this.#releaseActive(resume.runId);
        return { runId: resume.runId, status: "cancelled" };
      }
    } else if ("decision" in resume && ["retryProvider", "cancelProvider"].includes(resume.decision)) {
      throw new JsonRpcError(JsonRpcErrorCode.Conflict, "Run is not awaiting Provider");
    }
    return this.#withRunOperation(resume.runId, async () => {
    const active = await this.#ensureActive(resume.runId, context.notify, context.signal, tradeAccessFrom(context));
    const operationSignal = AbortSignal.any([active.controller.signal, context.signal]);
    operationSignal.throwIfAborted();
    active.notify = context.notify;
    if ("mode" in resume || ("decision" in resume && resume.decision === "retryProvider")) {
      let output: WorkflowState;
      try {
        output = await active.graph.invoke(
          null as never,
          workflowConfig(resume.runId, undefined, undefined, operationSignal),
        ) as WorkflowState;
      } catch (error) {
        if (error instanceof AwaitingProviderError) {
          await this.#awaitProvider(resume.runId, error, context.notify);
          return { runId: resume.runId, status: "awaitingProvider", phase: error.phase, retryable: error.retryable };
        }
        if (!operationSignal.aborted) await this.#failRun(resume.runId, error);
        throw error;
      }
      operationSignal.throwIfAborted();
      const run = toOptimizationRun(output);
      const verifiedMechanics = asVerifiedMechanicReport(output.mechanicReport);
      if (verifiedMechanics?.status === "blocked") {
        const paused: OptimizationRun = { ...run, status: "paused", updatedAt: new Date().toISOString() };
        this.#store.saveRun(paused);
        context.notify({ method: "run.mechanicsReady", params: { runId: run.id, report: verifiedMechanics } });
        context.notify({ method: "run.awaitingMechanicReview", params: { runId: run.id, report: verifiedMechanics } });
        return { runId: run.id, status: "paused", candidates: run.selected, mechanicReport: verifiedMechanics };
      }
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

    if (resume.decision === "cancel") {
      await this.#releaseActive(run.id);
      return { runId: run.id, status: run.status };
    }
    if (resume.decision === "reject") {
      context.notify({ method: "run.completed", params: { runId: run.id, candidates: run.selected } });
      await this.#releaseActive(run.id);
      return { runId: run.id, status: run.status };
    }
    if (resume.decision !== "apply") {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Unsupported resume decision: ${resume.decision}`);
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
    const active = await this.#ensureActive(result.runId, context.notify, context.signal, tradeAccessFrom(context));
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
    for (const analysis of this.#mechanicAnalyses.values()) {
      if (analysis.status !== "running") continue;
      analysis.status = "cancelled";
      analysis.controller.abort(new Error("Planner controller closed"));
    }
    await Promise.allSettled([...this.#tasks]);
    this.#pending.clear();
    this.#cancelled.clear();
    this.#operations.clear();
    await Promise.all([...this.#pools].map((pool) => pool.close()));
    this.#pools.clear();
    this.#active.clear();
    this.#mechanicAnalyses.clear();
  }

  async #start(
    runId: string,
    snapshot: BuildSnapshot,
    objective: ObjectiveSpec,
    context: PlannerControllerContext,
    expectedMechanicFingerprint?: string,
  ): Promise<void> {
    const notify = context.notify;
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
      const active = await this.#activate(
        runId,
        snapshot,
        objective,
        notify,
        undefined,
        tradeAccessFrom(context),
        expectedMechanicFingerprint,
      );
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
      const verifiedMechanics = asVerifiedMechanicReport(state.mechanicReport);
      if (verifiedMechanics !== undefined) {
        notify({ method: "run.mechanicsReady", params: { runId, report: verifiedMechanics } });
        if (verifiedMechanics.status === "blocked") {
          const paused: OptimizationRun = { ...run, status: "paused", updatedAt: new Date().toISOString() };
          this.#store.saveRun(paused);
          notify({ method: "run.awaitingMechanicReview", params: { runId, report: verifiedMechanics } });
          return;
        }
      }
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
      if (error instanceof AwaitingProviderError) {
        await this.#awaitProvider(runId, error, notify);
        this.#pending.delete(runId);
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
    tradeAccess?: TradeAccess,
    expectedMechanicFingerprint?: string,
  ): Promise<ActiveRun> {
    const tradeBridge: TradeAccess = {
      requestTradeCatalog: tradeAccess?.requestTradeCatalog,
      cancelTradeCatalog: tradeAccess?.cancelTradeCatalog,
    };
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
    const providerController = new AbortController();
    let mechanicReport: VerifiedBuildMechanicReport;
    let modelAdapter: ModelAdapter<HighLevelToolName>;
    try {
      const mechanicEngine = await this.#createMechanicEngine(
        pool as unknown as MechanicPool,
        `run:${runId}:mechanics`,
        (progress) => notify({
          method: "run.progress",
          params: {
            runId,
            phase: `Mechanics:${progress.phase}`,
            progress: Math.min(0.2, progress.progress * 0.2),
            evaluations: 0,
            frontierSize: 0,
            message: `${progress.message}; entities=${progress.inspectedCount}/${progress.entityCount}; modelCalls=${progress.modelCalls}; experiments=${progress.experimentCount}`,
          },
        }),
      );
      mechanicReport = await mechanicEngine.understand(
        snapshot,
        { contexts: ["weaponSet1", "weaponSet2"] },
        startupSignal,
      );
      if (mechanicReport.status !== "verified") {
        throw new JsonRpcError(
          JsonRpcErrorCode.Conflict,
          "Verified mechanic report is blocked; optimization cannot start",
          mechanicReport.blockers,
        );
      }
      if (expectedMechanicFingerprint !== undefined
        && mechanicReport.analysisFingerprint !== expectedMechanicFingerprint) {
        throw new JsonRpcError(
          JsonRpcErrorCode.Conflict,
          "Requested mechanic report fingerprint is stale or does not match the active Build",
        );
      }
      notify({ method: "run.mechanicsReady", params: { runId, report: mechanicReport } });
      if (this.#modelAdapterFactory === undefined) throw providerUnavailable();
      modelAdapter = await this.#modelAdapterFactory.create<HighLevelToolName>(this.#providerId);
    } catch (error) {
      await pool.close();
      if (this.#pending.get(runId) === controller) this.#pending.delete(runId);
      throw error;
    }
    const graph = createWorkflowGraph({
      checkpointer: this.#checkpointer,
      nodes: {
        analyzeMechanics: () => ({ mechanicReport }),
        inspectMechanics: () => ({ mechanicReport }),
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
        planSearch: async (state) => {
          const guidance = await this.#modelGuidance(
            state,
            "PlanSearch",
            modelAdapter,
            AbortSignal.any([controller.signal, providerController.signal]),
          );
          return {
            ...guidance,
            artifacts: {
              ...guidance.artifacts,
              searchPlan: { domains: 9, proposals: state.snapshot.contentCatalog?.length ?? 0 },
            },
          };
        },
        searchDomains: async (state, nodeContext) => this.#search(
          runId,
          state,
          nodeContext,
          pool,
          controller.signal,
          notify,
          tradeBridge,
        ),
        mergePareto: () => ({}),
        verify: (state) => ({
          needsRefinement: state.frontier.length === 0 && state.refinementRounds < 1,
          improvementRatio: 0,
          paretoFrontierChanged: state.frontier.length > 0,
        }),
        refineSearch: async (state) => this.#modelGuidance(
          state,
          "RefineSearch",
          modelAdapter,
          AbortSignal.any([controller.signal, providerController.signal]),
        ),
        explain: async (state) => this.#modelGuidance(
          state,
          "Explain",
          modelAdapter,
          AbortSignal.any([controller.signal, providerController.signal]),
        ),
        finalVerify: (state) => {
          const result = state.transactionResult;
          if (result !== undefined && (!result.accepted || !result.applied)) {
            throw new Error(result.error ?? "Build transaction failed verification");
          }
          return {};
        },
      },
    });
    const active: ActiveRun = {
      graph,
      snapshot,
      objective,
      controller,
      pool,
      providerController,
      providerId: this.#providerId,
      tradeAccess: tradeBridge,
      mechanicReport,
      notify,
      cancelled: false,
    };
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
    tradeAccess?: TradeAccess,
    expectedMechanicFingerprint?: string,
  ): Promise<ActiveRun> {
    const active = this.#active.get(runId);
    if (active !== undefined) {
      active.tradeAccess.requestTradeCatalog = tradeAccess?.requestTradeCatalog ?? active.tradeAccess.requestTradeCatalog;
      active.tradeAccess.cancelTradeCatalog = tradeAccess?.cancelTradeCatalog ?? active.tradeAccess.cancelTradeCatalog;
      return active;
    }
    const existing = this.#activations.get(runId);
    if (existing !== undefined) {
      const shared = await existing;
      requestSignal?.throwIfAborted();
      return shared;
    }
    const activation = this.#createActive(
      runId,
      snapshot,
      objective,
      notify,
      requestSignal,
      tradeAccess,
      expectedMechanicFingerprint,
    );
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

  async #awaitProvider(
    runId: string,
    error: AwaitingProviderError,
    notify: PlannerControllerContext["notify"],
  ): Promise<void> {
    const persisted = this.#store.getRun(runId);
    if (persisted !== undefined) {
      this.#store.saveRun({
        ...persisted,
        status: "paused",
        awaitingProvider: { phase: error.phase as "PlanSearch" | "RefineSearch" | "Explain", error: error.message, retryable: error.retryable },
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
    }
    notify({
      method: "run.awaitingProvider",
      params: {
        runId,
        phase: error.phase as "PlanSearch" | "RefineSearch" | "Explain",
        error: error.message,
        retryable: error.retryable,
      },
    });
    // Retry must rebuild the adapter so a repaired Provider profile/credential is used.
    await this.#releaseActive(runId);
  }

  async #ensureActive(
    runId: string,
    notify: PlannerControllerContext["notify"],
    requestSignal?: AbortSignal,
    tradeAccess?: TradeAccess,
  ): Promise<ActiveRun> {
    const run = this.#store.getRun(runId);
    if (run === undefined) throw notFound(`Run not found: ${runId}`);
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, `Run is terminal and cannot be resumed: ${run.status}`);
    }
    const current = this.#active.get(runId);
    if (current !== undefined) {
      current.tradeAccess.requestTradeCatalog = tradeAccess?.requestTradeCatalog ?? current.tradeAccess.requestTradeCatalog;
      current.tradeAccess.cancelTradeCatalog = tradeAccess?.cancelTradeCatalog ?? current.tradeAccess.cancelTradeCatalog;
      return current;
    }
    const snapshot = this.#store.getSnapshot(run.buildFingerprint);
    if (snapshot === undefined) throw notFound(`Build snapshot not found for run: ${runId}`);
    return this.#activate(
      runId,
      snapshot,
      run.objective,
      notify,
      requestSignal,
      tradeAccess,
      run.mechanicAnalysisFingerprint,
    );
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
      if (candidate.candidateFingerprint !== undefined
        && actual.metadata?.["candidateFingerprint"] !== candidate.candidateFingerprint) {
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Candidate fingerprint changed during fresh apply verification");
      }
      if (candidate.nativeProbeFingerprint !== undefined
        && actual.metadata?.["nativeProbeFingerprint"] !== candidate.nativeProbeFingerprint) {
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Native link proof changed during fresh apply verification");
      }
      if (candidate.evidenceFingerprint !== undefined
        && actual.metadata?.["evidenceFingerprint"] !== candidate.evidenceFingerprint) {
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "Native evidence proof changed during fresh apply verification");
      }
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

  async #modelGuidance(
    state: Readonly<WorkflowState>,
    phase: "PlanSearch" | "RefineSearch" | "Explain",
    adapter: ModelAdapter<HighLevelToolName>,
    signal: AbortSignal,
  ) {
    if (state.objective === undefined) throw new Error("Confirmed objective is unavailable");
    const mechanics = VerifiedBuildMechanicReportSchema.parse(state.mechanicReport);
    const dispatcher = new ReadonlyToolDispatcher({
      inspect_build: (_args, context) => ({
        fingerprint: context.snapshot.fingerprint,
        ruleset: context.snapshot.ruleset,
        metrics: context.snapshot.metrics,
        catalogEntries: context.snapshot.contentCatalog?.length ?? 0,
        graph: context.snapshot.buildGraph,
        mechanics,
      }),
      trace_mechanic: (args) => {
        const nodes = mechanics.graph.nodes.filter(({ id }) => id === args.nodeId);
        const edges = mechanics.graph.edges.filter(({ sourceId, targetId }) => sourceId === args.nodeId || targetId === args.nodeId);
        return { nodes, edges };
      },
      list_findings: (args) => {
        const findings = mechanics.findings;
        return args.severity === undefined ? findings : findings.filter(({ severity }) => severity === args.severity);
      },
      describe_modifier: (args, context) => {
        for (const item of context.snapshot.mechanicProjection.items) {
          const modifier = item.modifierLines.find(({ id }) => id === args.modifierId);
          if (modifier !== undefined) return { item: { id: item.id, name: item.name, active: item.active }, modifier };
        }
        return { error: "modifier_not_found" };
      },
      diagnose_build: (_args, context) => ({
        goals: context.objective.goals,
        hardConstraints: context.objective.hardConstraints,
        missingGoalMetrics: context.objective.goals
          .map(({ metric }) => metric)
          .filter((metric) => context.snapshot.metrics[metric] === undefined),
      }),
      search_build: (args, context) => ({
        requestedDomains: args.domains,
        candidates: context.candidates?.map(({ id, label, scenarioMetrics }) => ({ id, label, scenarioMetrics })) ?? [],
        note: "Deterministic search is controller-owned; this tool returns verified search state only",
      }),
      refine_search: (args, context) => ({
        focus: args.focus,
        candidates: context.candidates?.map(({ id, summary }) => ({ id, summary })) ?? [],
      }),
      evaluate_candidate: (args, context) => context.candidates?.find(({ id }) => id === args.candidateId)
        ?? { error: "candidate_not_found" },
      explain_candidate: (args, context) => {
        const candidate = context.candidates?.find(({ id }) => id === args.candidateId);
        return candidate === undefined
          ? { error: "candidate_not_found" }
          : { id: candidate.id, summary: candidate.summary, metrics: candidate.scenarioMetrics, evidence: candidate.evidence };
      },
      plan_progression: (args, context) => ({
        candidateId: args.candidateId,
        milestones: args.milestones,
        budget: args.budget,
        candidate: context.candidates?.find(({ id }) => id === args.candidateId),
        note: "Read-only milestone draft; no BuildAction is emitted",
      }),
    });
    try {
      const result = await runReadonlyAgentLoop({
        adapter,
        dispatcher,
        messages: [{
          role: "user",
          content: `${phase}: provide read-only guidance for the confirmed objective. Use verified tools for build facts and numbers.`,
        }],
        context: {
          snapshot: state.snapshot,
          objective: state.objective,
          scenarios: state.scenarios,
          candidates: state.selected.length > 0 ? state.selected : state.frontier,
          signal,
        },
        limits: { recursionLimit: 8, modelCallLimit: 4, wallTimeMs: 60_000 },
        signal,
      });
      if (result.fallback !== undefined) {
        throw new AwaitingProviderError(phase, result.fallback.detail, result.fallback.retryable);
      }
      return {
        artifacts: {
          model: {
            phase,
            configured: true,
            mode: "provider",
            content: result.content,
            stopReason: result.stopReason,
            toolCalls: result.toolCalls,
          },
        },
        usage: { evaluations: 0, modelCalls: result.modelCalls },
        providerFallback: false,
        toolCallFingerprint: canonicalHash({
          phase,
          toolResults: result.toolResults.map(({ name, ok }) => ({ name, ok })),
          content: result.content,
        }),
      };
    } catch (error) {
      if (error instanceof AwaitingProviderError) throw error;
      throw new AwaitingProviderError(
        phase,
        error instanceof Error ? error.message : "Provider failed",
        true,
      );
    }
  }

  async #search(
    runId: string,
    state: Readonly<WorkflowState>,
    nodeContext: Readonly<WorkflowNodeContext>,
    pool: EvaluationPool,
    signal: AbortSignal,
    notify: PlannerControllerContext["notify"],
    tradeAccess?: TradeAccess,
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
        providerFallback: false,
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
    const trade = await fetchTradeCandidates(
      runId,
      state.snapshot,
      state.objective,
      tradeAccess,
      signal,
      notify,
    );
    if (trade.candidates.length > 0) {
      domainCandidates.gear = [...(domainCandidates.gear ?? []), ...trade.candidates];
    }
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
      // Candidate-native proofs are per calculator run. Reusing a metrics-only
      // cache entry would bypass the required probe/evidence barrier.
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
        provider: { configured: true, mode: "llm_guided_controller_search" },
        domainGraph: {
          nodes: domain.graph.toJSON().nodes.length,
          edges: domain.graph.toJSON().edges.length,
          mechanicAdapters: domain.appliedAdapterIds,
          evidence: domain.evidence.length,
        },
        trade: {
          enabled: state.objective.candidateSources.trade,
          candidates: trade.candidates.length,
          warnings: trade.warnings,
        },
      },
      searchStopReason: result.stopReason,
      providerFallback: false,
      toolCallFingerprint: canonicalHash({ runId, frontier: publicFrontier.map(({ id }) => id) }),
    };
  }
}

const TRADE_SLOT_CATEGORIES = [
  ["Helmet", "armour.helmet"],
  ["Body Armour", "armour.chest"],
  ["Gloves", "armour.gloves"],
  ["Boots", "armour.boots"],
  ["Amulet", "accessory.amulet"],
  ["Ring 1", "accessory.ring"],
  ["Ring 2", "accessory.ring"],
  ["Belt", "accessory.belt"],
] as const;

function tradeAccessFrom(context: PlannerControllerContext): TradeAccess {
  return {
    requestTradeCatalog: context.requestTradeCatalog,
    cancelTradeCatalog: context.cancelTradeCatalog,
  };
}

async function fetchTradeCandidates(
  runId: string,
  snapshot: BuildSnapshot,
  objective: ObjectiveSpec,
  access: TradeAccess | undefined,
  signal: AbortSignal,
  notify: PlannerControllerContext["notify"],
): Promise<{ candidates: SearchCandidate<BuildAction>[]; warnings: string[] }> {
  if (!objective.candidateSources.trade) return { candidates: [], warnings: [] };
  if (objective.budgetDivine === undefined || objective.tradeContext === undefined
    || access?.requestTradeCatalog === undefined) {
    return { candidates: [], warnings: ["Trade broker unavailable; deterministic local search continued"] };
  }
  if (snapshot.ruleset !== "3_29" && snapshot.ruleset !== "3_29_ruthless") {
    return { candidates: [], warnings: [`Trade ruleset unsupported: ${snapshot.ruleset}`] };
  }
  const ruleset = snapshot.ruleset;
  const tradeContext = objective.tradeContext;
  const pending = new Set<string>();
  const warnings: string[] = [];
  const cancelPending = (): void => {
    for (const requestId of pending) {
      access.cancelTradeCatalog?.({ runId, requestId, reason: "Planner search cancelled" });
    }
  };
  signal.addEventListener("abort", cancelPending, { once: true });
  try {
    const settled = await Promise.all(TRADE_SLOT_CATEGORIES.map(async ([slot, category]) => {
      signal.throwIfAborted();
      const requestId = `trade:${runId}:${canonicalHash({ slot, category }).slice(0, 16)}`;
      const query: TradeCatalogQuery = {
        runId,
        requestId,
        queryHash: `sha256:${canonicalHash({
          ruleset,
          realm: tradeContext.realm,
          league: tradeContext.league,
          slot,
          category,
          rarity: "rare",
          budgetDivine: objective.budgetDivine,
        })}`,
        ruleset,
        realm: tradeContext.realm,
        league: tradeContext.league,
        slot,
        constraints: { category, rarity: "rare", statFilters: [] },
        limit: 10,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      };
      pending.add(requestId);
      try {
        return await access.requestTradeCatalog!(query);
      } finally {
        pending.delete(requestId);
      }
    }).map((promise) => promise.then(
      (result): { result: TradeCatalogResult } => ({ result }),
      (error): { error: unknown } => ({ error }),
    )));
    const items = settled.flatMap((entry) => {
      if ("result" in entry) {
        warnings.push(...entry.result.warnings);
        return entry.result.items;
      }
      warnings.push(entry.error instanceof Error ? entry.error.message : "Trade query failed");
      return [];
    }).sort((left, right) => left.price.divineEquivalent - right.price.divineEquivalent
      || left.itemHash.localeCompare(right.itemHash))
      .slice(0, 100);
    if (warnings.length > 0) {
      notify({
        method: "run.progress",
        params: {
          runId,
          phase: "TradeCatalog",
          progress: 0,
          evaluations: 0,
          frontierSize: 0,
          message: `Trade degraded (${warnings.length} warning${warnings.length === 1 ? "" : "s"}); continuing search`,
        },
      });
    }
    return {
      warnings: [...new Set(warnings)].slice(0, 32),
      candidates: items.map((item, index) => ({
        id: `trade:${item.catalogId}:${index + 1}`,
        baseFingerprint: snapshot.fingerprint,
        domain: "gear" as const,
        estimatedCost: item.price.divineEquivalent,
        metadata: { source: "trade" as const, catalogId: item.catalogId, queryHash: item.queryHash },
        actions: [{
          id: `action:trade:${canonicalHash({ itemHash: item.itemHash, slot: item.slot }).slice(0, 24)}`,
          kind: "importAndEquip" as const,
          description: `Import and equip catalog item for ${item.slot}`,
          dependsOn: [],
          preconditions: { baseFingerprint: snapshot.fingerprint },
          reversible: true,
          costDivine: item.price.divineEquivalent,
          payload: {
            catalogId: item.catalogId,
            slot: item.slot,
            ...(item.itemSetId === undefined ? {} : { itemSetId: item.itemSetId }),
            itemRaw: item.itemRaw,
            itemHash: item.itemHash,
            source: "trade" as const,
            price: item.price,
          },
        }],
      })),
    };
  } finally {
    signal.removeEventListener("abort", cancelPending);
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
  return evaluations.flatMap((evaluation) => {
    const candidate = byId.get(evaluation.candidateId);
    if (candidate === undefined) throw new Error(`Worker returned unknown candidate: ${evaluation.candidateId}`);
    const mechanicDiff = evaluation.candidateProjection === undefined
      ? undefined
      : diffMechanics(
          analyzeBuildMechanics(snapshot),
          snapshot.mechanicProjection,
          evaluation.candidateProjection,
        );
    if (mechanicDiff?.breaksCriticalMechanism === true) return [];
    return [{
      ...candidate,
      metricsByScenario: evaluation.metricsByScenario,
      metadata: {
        ...candidate.metadata,
        ...(evaluation.candidateFingerprint === undefined ? {} : {
          candidateFingerprint: evaluation.candidateFingerprint,
        }),
        ...(evaluation.nativeProbeFingerprint === undefined ? {} : {
          nativeProbeFingerprint: evaluation.nativeProbeFingerprint,
        }),
        ...(evaluation.evidenceFingerprint === undefined ? {} : {
          evidenceFingerprint: evaluation.evidenceFingerprint,
        }),
        ...(evaluation.resolvedEvidence === undefined ? {} : {
          resolvedEvidence: evaluation.resolvedEvidence,
        }),
        ...(evaluation.candidateProjection === undefined || mechanicDiff === undefined ? {} : {
          candidateProjection: evaluation.candidateProjection,
          mechanicDiff,
        }),
      },
    }];
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
  const metadata = candidate.metadata ?? {};
  const nativeEvidence = Array.isArray(metadata["resolvedEvidence"])
    ? metadata["resolvedEvidence"].flatMap((entry) => {
      const parsed = ConditionEvidenceSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    })
    : undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: candidate.id,
    label,
    summary: actionSummary,
    baseFingerprint: candidate.baseFingerprint,
    ...(typeof metadata["candidateFingerprint"] === "string"
      ? { candidateFingerprint: metadata["candidateFingerprint"] }
      : {}),
    ...(typeof metadata["nativeProbeFingerprint"] === "string"
      ? { nativeProbeFingerprint: metadata["nativeProbeFingerprint"] }
      : {}),
    ...(typeof metadata["evidenceFingerprint"] === "string"
      ? { evidenceFingerprint: metadata["evidenceFingerprint"] }
      : {}),
    cost: { divine: cost, display: cost === 0 ? "No paid-source cost" : `${cost.toFixed(2)} Divine` },
    metrics: { ...primaryMetrics },
    scenarioMetrics: exactScenarioMetrics(candidate.metricsByScenario),
    peakScenarioMetrics: exactScenarioMetrics(peakMetrics),
    actions: [...candidate.actions],
    evidence: nativeEvidence ?? [...evidence],
    hardConstraintsSatisfied: true,
    ...(metadata["mechanicDiff"] === undefined
      ? {}
      : { mechanicDiff: MechanicDiffSchema.parse(metadata["mechanicDiff"]) }),
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

function providerUnavailable(): JsonRpcError {
  return new JsonRpcError(
    JsonRpcErrorCode.InternalError,
    "Provider configuration is unavailable; install the Windows Credential Manager helper",
  );
}

function asVerifiedMechanicReport(value: unknown): VerifiedBuildMechanicReport | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !("factBundleFingerprint" in value)) return undefined;
  return value as VerifiedBuildMechanicReport;
}
