import { Annotation } from "@langchain/langgraph";
import type {
  BuildSnapshot,
  BuildMechanicReport,
  VerifiedBuildMechanicReport,
  BuildAction,
  Candidate,
  ObjectiveSpec,
  ObjectiveSpecDraft,
  ScenarioSpec,
  SearchStopReason,
  StopReason,
  TransactionResult,
} from "../schemas.js";

export const WORKFLOW_NODE_NAMES = [
  "CaptureBuild",
  "DraftObjective",
  "ConfirmObjective",
  "BuildScenarios",
  "AnalyzeMechanics",
  "InspectMechanics",
  "MechanicGate",
  "Inspect",
  "Diagnose",
  "PlanSearch",
  "SearchDomains",
  "MergePareto",
  "Verify",
  "RefineSearch",
  "Explain",
  "Preview",
  "HumanApproval",
  "ApplyTransaction",
  "Reject",
  "FinalVerify",
] as const;

export type WorkflowNodeName = (typeof WORKFLOW_NODE_NAMES)[number];
export type WorkflowStatus = "draft" | "running" | "paused" | "completed" | "cancelled" | "failed";

export interface ApprovalDecision {
  decision: "apply" | "reject";
  candidateId?: string | undefined;
  reason?: string | undefined;
}

export interface TransactionApplyInterrupt {
  kind: "transaction-apply";
  runId: string;
  candidateId: string;
  baseFingerprint: string;
  actions: BuildAction[];
}

export interface MechanicReviewDecision {
  decision: "cancel";
  reason?: string | undefined;
}

export interface WorkflowUsage {
  evaluations?: number;
  modelCalls?: number;
}

export interface WorkflowNodeUpdate {
  snapshot?: BuildSnapshot;
  objectiveDraft?: ObjectiveSpecDraft;
  objective?: ObjectiveSpec;
  objectiveConfirmed?: boolean;
  scenarios?: ScenarioSpec[];
  mechanicReport?: BuildMechanicReport | VerifiedBuildMechanicReport;
  artifacts?: Record<string, unknown>;
  frontier?: Candidate[];
  selected?: Candidate[];
  explanation?: string;
  preview?: Record<string, unknown>;
  transactionResult?: TransactionResult;
  needsRefinement?: boolean;
  improvementRatio?: number;
  paretoFrontierChanged?: boolean;
  usage?: WorkflowUsage;
  toolCallFingerprint?: string;
  providerFallback?: boolean;
  searchStopReason?: SearchStopReason;
}

function replace<Value>(defaultValue: () => Value) {
  return Annotation<Value>({
    reducer: (_current, update) => update,
    default: defaultValue,
  });
}

export const WorkflowStateAnnotation = Annotation.Root({
  runId: Annotation<string>(),
  snapshot: Annotation<BuildSnapshot>(),
  objectiveDraft: replace<ObjectiveSpecDraft | undefined>(() => undefined),
  objective: replace<ObjectiveSpec | undefined>(() => undefined),
  objectiveConfirmed: replace(() => false),
  scenarios: replace<ScenarioSpec[]>(() => []),
  mechanicReport: replace<BuildMechanicReport | VerifiedBuildMechanicReport | undefined>(() => undefined),
  artifacts: replace<Record<string, unknown>>(() => ({})),
  frontier: replace<Candidate[]>(() => []),
  selected: replace<Candidate[]>(() => []),
  explanation: replace<string | undefined>(() => undefined),
  preview: replace<Record<string, unknown> | undefined>(() => undefined),
  approval: replace<ApprovalDecision | undefined>(() => undefined),
  transactionResult: replace<TransactionResult | undefined>(() => undefined),
  phase: replace<WorkflowNodeName | "idle" | "end">(() => "idle"),
  status: replace<WorkflowStatus>(() => "draft"),
  stopReason: replace<StopReason | undefined>(() => undefined),
  searchStopReason: replace<SearchStopReason | undefined>(() => undefined),
  error: replace<string | undefined>(() => undefined),
  cancelRequested: replace(() => false),
  providerFallback: replace(() => false),
  needsRefinement: replace(() => false),
  latestImprovementRatio: replace(() => 0),
  noImprovementRounds: replace(() => 0),
  evaluations: replace(() => 0),
  modelCalls: replace(() => 0),
  refinementRounds: replace(() => 0),
  lastToolCallFingerprint: replace<string | undefined>(() => undefined),
  duplicateToolCalls: replace(() => 0),
  startedAtMs: replace(() => 0),
  updatedAtMs: replace(() => 0),
  trace: Annotation<WorkflowNodeName[], WorkflowNodeName | WorkflowNodeName[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

export type WorkflowState = typeof WorkflowStateAnnotation.State;
export type WorkflowStateUpdate = typeof WorkflowStateAnnotation.Update;

export interface WorkflowInput {
  runId: string;
  snapshot: BuildSnapshot;
  objective?: ObjectiveSpec;
  objectiveDraft?: ObjectiveSpecDraft;
  cancelRequested?: boolean;
}

export function cancellationUpdate(): Pick<WorkflowStateUpdate, "cancelRequested"> {
  return { cancelRequested: true };
}
