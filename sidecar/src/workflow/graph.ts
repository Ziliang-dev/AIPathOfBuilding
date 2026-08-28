import {
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { z } from "zod";
import {
  BuildSnapshotSchema,
  ObjectiveSpecDraftSchema,
  OptimizationRunSchema,
  SCHEMA_VERSION,
  TransactionResultSchema,
  normalizeObjectiveSpec,
  type DeepLimits,
  type OptimizationRun,
} from "../schemas.js";
import { resolveDeepLimits } from "./limits.js";
import {
  resolveNodeDependencies,
  wrapNode,
  type WorkflowNodeDependencies,
} from "./nodes.js";
import {
  WorkflowStateAnnotation,
  type ApprovalDecision,
  type WorkflowInput,
  type WorkflowState,
  type WorkflowStateUpdate,
  type TransactionApplyInterrupt,
} from "./state.js";

const ApprovalDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("apply"),
    candidateId: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.object({
    decision: z.literal("reject"),
    candidateId: z.string().min(1).optional(),
    reason: z.string().optional(),
  }),
]);

export interface CreateWorkflowGraphOptions {
  nodes?: Partial<WorkflowNodeDependencies>;
  limits?: Partial<DeepLimits>;
  checkpointer?: BaseCheckpointSaver | false;
  now?: () => number;
  name?: string;
}

export function createWorkflowGraph(options: CreateWorkflowGraphOptions = {}) {
  const dependencies = resolveNodeDependencies(options.nodes);
  const limits = resolveDeepLimits(options.limits);
  const now = options.now ?? Date.now;
  const checkpointer = options.checkpointer === undefined ? new MemorySaver() : options.checkpointer;

  const graph = new StateGraph(WorkflowStateAnnotation)
    .addNode("CaptureBuild", wrapNode("CaptureBuild", dependencies.captureBuild, limits, now))
    .addNode("DraftObjective", wrapNode("DraftObjective", dependencies.draftObjective, limits, now))
    .addNode("ConfirmObjective", wrapNode("ConfirmObjective", dependencies.confirmObjective, limits, now))
    .addNode("BuildScenarios", wrapNode("BuildScenarios", dependencies.buildScenarios, limits, now))
    .addNode("Inspect", wrapNode("Inspect", dependencies.inspect, limits, now))
    .addNode("Diagnose", wrapNode("Diagnose", dependencies.diagnose, limits, now))
    .addNode("PlanSearch", wrapNode("PlanSearch", dependencies.planSearch, limits, now, { expensive: true }))
    .addNode("SearchDomains", wrapNode("SearchDomains", dependencies.searchDomains, limits, now, { expensive: true }))
    .addNode("MergePareto", wrapNode("MergePareto", dependencies.mergePareto, limits, now))
    .addNode("Verify", wrapNode("Verify", dependencies.verify, limits, now, { verify: true }))
    .addNode("RefineSearch", wrapNode("RefineSearch", dependencies.refineSearch, limits, now, {
      expensive: true,
      refine: true,
    }))
    .addNode("Explain", wrapNode("Explain", dependencies.explain, limits, now))
    .addNode("Preview", wrapNode("Preview", dependencies.preview, limits, now, { pause: true }))
    .addNode("HumanApproval", humanApprovalNode)
    .addNode("ApplyTransaction", transactionApplyNode)
    .addNode("Reject", wrapNode("Reject", dependencies.reject, limits, now, { reject: true }))
    .addNode("FinalVerify", wrapNode("FinalVerify", dependencies.finalVerify, limits, now, { final: true }))
    .addEdge(START, "CaptureBuild")
    .addEdge("CaptureBuild", "DraftObjective")
    .addEdge("DraftObjective", "ConfirmObjective")
    .addEdge("ConfirmObjective", "BuildScenarios")
    .addEdge("BuildScenarios", "Inspect")
    .addEdge("Inspect", "Diagnose")
    .addEdge("Diagnose", "PlanSearch")
    .addEdge("PlanSearch", "SearchDomains")
    .addEdge("SearchDomains", "MergePareto")
    .addEdge("MergePareto", "Verify")
    .addConditionalEdges("Verify", routeAfterVerify, ["RefineSearch", "Explain"])
    .addEdge("RefineSearch", "SearchDomains")
    .addEdge("Explain", "Preview")
    .addConditionalEdges("Preview", routeAfterPreview, ["HumanApproval", "FinalVerify"])
    .addConditionalEdges("HumanApproval", routeAfterApproval, ["ApplyTransaction", "Reject"])
    .addEdge("ApplyTransaction", "FinalVerify")
    .addEdge("Reject", "FinalVerify")
    .addEdge("FinalVerify", END);

  return graph.compile({
    checkpointer,
    name: options.name ?? "AIPathOfBuildingOptimizer",
  });
}

export function createWorkflowInput(input: WorkflowInput): WorkflowInput {
  if (input.runId.trim().length === 0) throw new Error("runId must not be empty");
  const snapshot = BuildSnapshotSchema.parse(input.snapshot);
  return {
    runId: input.runId,
    snapshot,
    ...(input.objective === undefined ? {} : { objective: normalizeObjectiveSpec(input.objective) }),
    ...(input.objectiveDraft === undefined
      ? {}
      : { objectiveDraft: ObjectiveSpecDraftSchema.parse(input.objectiveDraft) }),
    ...(input.cancelRequested === undefined ? {} : { cancelRequested: input.cancelRequested }),
  };
}

export function toOptimizationRun(state: WorkflowState): OptimizationRun {
  if (state.objective === undefined) throw new Error("Workflow has no confirmed ObjectiveSpec");
  return OptimizationRunSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    id: state.runId,
    buildFingerprint: state.snapshot.fingerprint,
    status: state.status,
    objective: state.objective,
    scenarios: state.scenarios,
    frontier: state.frontier,
    selected: state.selected,
    evaluations: state.evaluations,
    modelCalls: state.modelCalls,
    refinementRounds: state.refinementRounds,
    startedAt: new Date(state.startedAtMs).toISOString(),
    updatedAt: new Date(state.updatedAtMs).toISOString(),
    ...(state.stopReason === undefined ? {} : { stopReason: state.stopReason }),
    ...(state.searchStopReason === undefined ? {} : { searchStopReason: state.searchStopReason }),
    ...(state.error === undefined ? {} : { error: state.error }),
  });
}

function routeAfterVerify(state: WorkflowState): "RefineSearch" | "Explain" {
  return state.stopReason === undefined && state.needsRefinement
    ? "RefineSearch"
    : "Explain";
}

function routeAfterPreview(state: WorkflowState): "HumanApproval" | "FinalVerify" {
  return state.stopReason === "cancelled" || state.stopReason === "failed"
    ? "FinalVerify"
    : "HumanApproval";
}

function routeAfterApproval(state: WorkflowState): "ApplyTransaction" | "Reject" {
  return state.approval?.decision === "apply" ? "ApplyTransaction" : "Reject";
}

function humanApprovalNode(state: WorkflowState): WorkflowStateUpdate {
  const candidates = state.selected.length > 0 ? state.selected : state.frontier;
  const resumed = interrupt<
    {
      kind: "candidate-approval";
      runId: string;
      preview: Record<string, unknown> | undefined;
      candidates: Array<{ id: string; label: string; summary: string }>;
    },
    ApprovalDecision
  >({
    kind: "candidate-approval",
    runId: state.runId,
    preview: state.preview,
    candidates: candidates.map(({ id, label, summary }) => ({ id, label, summary })),
  });
  const approval = ApprovalDecisionSchema.parse(resumed);
  if (approval.decision === "apply" && !candidates.some(({ id }) => id === approval.candidateId)) {
    throw new Error(`Candidate is not available for approval: ${approval.candidateId}`);
  }
  return {
    approval,
    phase: "HumanApproval",
    status: approval.decision === "apply" ? "paused" : "running",
    trace: "HumanApproval",
  };
}

function transactionApplyNode(state: WorkflowState): WorkflowStateUpdate {
  const candidateId = state.approval?.decision === "apply"
    ? state.approval.candidateId
    : undefined;
  const candidates = state.selected.length > 0 ? state.selected : state.frontier;
  const candidate = candidates.find(({ id }) => id === candidateId);
  if (candidate === undefined) throw new Error(`Approved candidate is unavailable: ${candidateId ?? "<missing>"}`);
  if (candidate.baseFingerprint !== state.snapshot.fingerprint) {
    throw new Error("Approved candidate base fingerprint no longer matches the captured Build");
  }
  const result = TransactionResultSchema.parse(interrupt<TransactionApplyInterrupt, unknown>({
    kind: "transaction-apply",
    runId: state.runId,
    candidateId: candidate.id,
    baseFingerprint: candidate.baseFingerprint,
    actions: candidate.actions,
  }));
  if (result.runId !== state.runId || result.candidateId !== candidate.id) {
    throw new Error("Transaction result does not match the interrupted run and candidate");
  }
  if (!result.accepted || !result.applied) {
    return {
      transactionResult: result,
      phase: "ApplyTransaction",
      status: "failed",
      stopReason: "failed",
      error: result.error ?? "Candidate transaction was not applied",
      trace: "ApplyTransaction",
    };
  }
  return {
    transactionResult: result,
    phase: "ApplyTransaction",
    status: "running",
    trace: "ApplyTransaction",
  };
}
