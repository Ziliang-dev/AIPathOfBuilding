import { z } from "zod";

export const SCHEMA_VERSION = 3 as const;
export const PROTOCOL_VERSION = 4 as const;

export const CapabilitySchema = z.enum([
  "nativeLinkProbe",
  "nativeEvidence",
  "tradeBroker",
  "providerConsent",
  "providerConnectionTest",
  "providerCompatibility",
  "objectiveDraft",
  "mechanicAnalysis",
]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ScenarioIdSchema = z.enum([
  "current",
  "mapping",
  "standardBoss",
  "pinnacle",
  "uber",
]);
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

export const RankedScenarioIdSchema = z.enum([
  "mapping",
  "standardBoss",
  "pinnacle",
  "uber",
]);
export type RankedScenarioId = z.infer<typeof RankedScenarioIdSchema>;

export const ScenarioWeightsSchema = z
  .object({
    mapping: z.number().min(0).max(1),
    standardBoss: z.number().min(0).max(1),
    pinnacle: z.number().min(0).max(1),
    uber: z.number().min(0).max(1),
  })
  .superRefine((weights, context) => {
    const sum = Object.values(weights).reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > 1e-6) {
      context.addIssue({
        code: "custom",
        message: "Scenario weights must sum to 1",
      });
    }
  });

export const GoalSchema = z.object({
  metric: z.string().min(1),
  direction: z.enum(["maximize", "minimize"]),
  weight: z.number().positive().default(1),
});
export type Goal = z.infer<typeof GoalSchema>;

export const HardConstraintSchema = z.object({
  metric: z.string().min(1),
  operator: z.enum([">=", ">", "<=", "<", "=="]),
  value: z.number().finite(),
  scenario: RankedScenarioIdSchema.optional(),
});
export type HardConstraint = z.infer<typeof HardConstraintSchema>;

export const ObjectiveSpecSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  description: z.string().max(8_000).optional(),
  constraintNotes: z.string().max(8_000).optional(),
  primaryScenario: RankedScenarioIdSchema.default("mapping"),
  scenarioWeights: ScenarioWeightsSchema.default({
    mapping: 0.55,
    standardBoss: 0.15,
    pinnacle: 0.15,
    uber: 0.15,
  }),
  locks: z
    .object({
      class: z.boolean().default(true),
      ascendancy: z.boolean().default(true),
      mainSkill: z.boolean().default(true),
      fields: z.array(z.string().min(1)).default([]),
    })
    .default({ class: true, ascendancy: true, mainSkill: true, fields: [] }),
  budgetDivine: z.number().nonnegative().optional(),
  searchPreset: z.literal("deep").default("deep"),
  goals: z.array(GoalSchema).min(1),
  hardConstraints: z.array(HardConstraintSchema).default([]),
  candidateSources: z
    .object({
      currentBuild: z.boolean().default(true),
      uniques: z.boolean().default(false),
      targetRares: z.boolean().default(false),
      trade: z.boolean().default(false),
    })
    .default({
      currentBuild: true,
      uniques: false,
      targetRares: false,
      trade: false,
    }),
  tradeContext: z.object({
    realm: z.enum(["pc", "xbox", "sony"]),
    league: z.string().min(1).max(128),
  }).optional(),
});
export type ObjectiveSpec = z.infer<typeof ObjectiveSpecSchema>;
export const ObjectiveSpecDraftSchema = ObjectiveSpecSchema.partial().extend({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
});
export type ObjectiveSpecDraft = z.infer<typeof ObjectiveSpecDraftSchema>;

/** Parse UI/RPC input and enforce candidate-source safety policy. */
export function normalizeObjectiveSpec(input: unknown): ObjectiveSpec {
  const objective = ObjectiveSpecSchema.parse(input);
  if (objective.budgetDivine !== undefined) return objective;
  return {
    ...objective,
    candidateSources: {
      currentBuild: true,
      uniques: false,
      targetRares: false,
      trade: false,
    },
  };
}

export const MetricSetSchema = z.record(z.string().min(1), z.number().finite());
export type MetricSet = z.infer<typeof MetricSetSchema>;

export const ContentCatalogEntrySchema = z.object({
  id: z.string().min(1),
  domain: z.enum([
    "rules",
    "identity",
    "skills",
    "gear",
    "tree",
    "actor",
    "config",
    "external",
    "progression",
  ]),
  kind: z.string().min(1),
  name: z.string().min(1).optional(),
  available: z.boolean().default(true),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type ContentCatalogEntry = z.infer<typeof ContentCatalogEntrySchema>;

export const ModifierResolutionSchema = z.enum(["exact", "inferred", "unknown"]);
export const ModifierParseStatusSchema = z.enum(["parsed", "partial", "unknown", "disabled"]);
export const ItemLegalityStatusSchema = z.enum(["valid", "invalid", "unverifiable"]);

export const ModifierProvenanceSchema = z.object({
  sourceFamily: z.string().min(1),
  sourceTable: z.string().min(1).optional(),
  sourceModId: z.string().min(1).optional(),
  donorItem: z.string().min(1).optional(),
  resolution: ModifierResolutionSchema,
  evidence: z.array(z.string().min(1)).default([]),
  alternatives: z.array(z.string().min(1)).max(8).optional(),
});

export const ParsedModifierSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  classification: z.enum(["numeric", "boolean", "structured", "unknown"]),
  value: z.unknown().optional(),
  flags: z.number().int(),
  keywordFlags: z.number().int(),
  source: z.string().min(1).optional(),
  tags: z.array(z.unknown()).default([]),
});

export const ModifierLineProjectionSchema = z.object({
  id: z.string().min(1),
  section: z.enum(["buff", "enchant", "scourge", "classRequirement", "implicit", "explicit", "crucible"]),
  ordinal: z.number().int().positive(),
  rawText: z.string(),
  active: z.boolean(),
  disabled: z.boolean(),
  flags: z.array(z.string().min(1)).default([]),
  modTags: z.array(z.string()).default([]),
  modId: z.string().min(1).optional(),
  newModId: z.string().min(1).optional(),
  range: z.union([z.number(), z.array(z.number())]).optional(),
  corruptedRange: z.number().optional(),
  valueScalar: z.number().optional(),
  extra: z.string().optional(),
  parseStatus: ModifierParseStatusSchema,
  provenance: ModifierProvenanceSchema,
  parsedMods: z.array(ParsedModifierSchema).default([]),
});
export type ModifierLineProjection = z.infer<typeof ModifierLineProjectionSchema>;

export const ItemLegalityFindingSchema = z.object({
  status: z.enum(["invalid", "unverifiable"]),
  code: z.string().min(1),
  reason: z.string().min(1),
  lineId: z.string().min(1).optional(),
});

export const ItemLegalitySchema = z.object({
  version: z.number().int().positive(),
  status: ItemLegalityStatusSchema,
  findings: z.array(ItemLegalityFindingSchema).default([]),
});

export const ModifierItemProjectionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  title: z.string().optional(),
  baseName: z.string().optional(),
  type: z.string().optional(),
  rarity: z.string().optional(),
  itemLevel: z.number().optional(),
  quality: z.number().optional(),
  equipped: z.boolean(),
  active: z.boolean(),
  references: z.array(z.object({
    itemSetId: z.string().min(1),
    slot: z.string().min(1),
    active: z.boolean(),
    nodeId: z.union([z.string(), z.number()]).optional(),
  })).default([]),
  state: z.record(z.string(), z.boolean()).default({}),
  legality: ItemLegalitySchema,
  modifierLines: z.array(ModifierLineProjectionSchema).default([]),
});

export const ModifierProjectionSchema = z.object({
  version: z.number().int().positive(),
  inventory: z.object({
    version: z.number().int().positive(),
    sections: z.array(z.string().min(1)),
    lineFlags: z.array(z.string().min(1)),
    sourceFamilies: z.array(z.object({
      name: z.string().min(1),
      modifierCount: z.number().int().nonnegative(),
    })),
  }),
  items: z.array(ModifierItemProjectionSchema),
  modifierCount: z.number().int().nonnegative(),
  activeModifierCount: z.number().int().nonnegative(),
  unresolvedModifierCount: z.number().int().nonnegative(),
  descriptions: z.object({
    entries: z.array(z.object({
      sourceTable: z.string().min(1),
      modId: z.string().min(1),
      type: z.string().optional(),
      group: z.string().optional(),
      affix: z.string().optional(),
      level: z.number().optional(),
      lines: z.array(z.string()).default([]),
      modTags: z.array(z.string()).default([]),
      donorItem: z.string().optional(),
    })).default([]),
    truncated: z.boolean(),
  }),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type ModifierProjection = z.infer<typeof ModifierProjectionSchema>;

export const BuildGraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      domain: z.string().min(1),
      kind: z.string().min(1),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      relation: z.enum([
        "grants",
        "requires",
        "triggers",
        "scales",
        "consumes",
        "conflicts",
        "replaces",
        "usesSlot",
        "availableIn",
      ]),
      data: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
});
export type BuildGraph = z.infer<typeof BuildGraphSchema>;

export const BuildSnapshotSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  xml: z.string().min(1),
  fingerprint: z.string().min(1),
  engineVersion: z.string().min(1),
  dataVersion: z.string().min(1),
  ruleset: z.string().min(1),
  metrics: MetricSetSchema.default({}),
  config: z.record(z.string(), z.unknown()).default({}),
  buildState: z.record(z.string(), z.unknown()).default({}),
  gameplayFieldPaths: z.array(z.string().min(1)).default([]),
  mechanicProjection: ModifierProjectionSchema,
  mechanicProjectionFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  contentCatalog: z.array(ContentCatalogEntrySchema).optional(),
  buildGraph: BuildGraphSchema.optional(),
});
export type BuildSnapshot = z.infer<typeof BuildSnapshotSchema>;

export const MechanicFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["info", "warning", "blocker"]),
  code: z.string().min(1),
  message: z.string().min(1),
  itemId: z.string().min(1).optional(),
  modifierLineId: z.string().min(1).optional(),
  critical: z.boolean().default(false),
  evidence: z.array(z.string().min(1)).default([]),
});
export type MechanicFinding = z.infer<typeof MechanicFindingSchema>;

export const MechanicUnderstandingSchema = z.object({
  mainSkillGroup: z.number().int().positive(),
  mainSkills: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    sourceItemId: z.string().min(1).optional(),
    sourceModifierLineId: z.string().min(1).optional(),
  })).default([]),
  criticalNodeIds: z.array(z.string().min(1)).default([]),
  verifiedChains: z.array(z.array(z.string().min(1))).default([]),
});

export const BuildMechanicReportSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  snapshotFingerprint: z.string().min(1),
  projectionFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  analysisFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  status: z.enum(["complete", "warning", "blocked"]),
  summary: z.string().min(1),
  understanding: MechanicUnderstandingSchema,
  findings: z.array(MechanicFindingSchema),
  graph: BuildGraphSchema,
});
export type BuildMechanicReport = z.infer<typeof BuildMechanicReportSchema>;

export const MechanicDiffSchema = z.object({
  baseProjectionFingerprint: z.string().min(1),
  candidateProjectionFingerprint: z.string().min(1),
  addedModifierLineIds: z.array(z.string()).default([]),
  removedModifierLineIds: z.array(z.string()).default([]),
  changedModifierLineIds: z.array(z.string()).default([]),
  breaksCriticalMechanism: z.boolean(),
  findings: z.array(MechanicFindingSchema).default([]),
});
export type MechanicDiff = z.infer<typeof MechanicDiffSchema>;

export const ScenarioSpecSchema = z.object({
  id: ScenarioIdSchema,
  name: z.string().min(1),
  enemyIsBoss: z.enum(["None", "Boss", "Pinnacle", "Uber"]),
  profile: z.enum(["current", "sustainable", "peak"]),
  mapModifiers: z.array(z.string()).default([]),
  bossSkillPreset: z.string().optional(),
  allowedEvents: z.array(z.enum(["onKill", "onHit", "onCrit", "onBlock", "onUse", "recently"])).default([]),
  assumptions: z.record(z.string(), z.unknown()).default({}),
});
export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;

export const EvidenceStatusSchema = z.enum([
  "proven_sustainable",
  "proven_peak",
  "intermittent",
  "manual",
  "impossible",
  "conflicting",
  "unknown",
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const ConditionEvidenceSchema = z.object({
  condition: z.string().min(1),
  configKey: z.string().min(1).optional(),
  value: z.unknown().optional(),
  scenario: ScenarioIdSchema,
  profile: z.enum(["current", "sustainable", "peak"]),
  status: EvidenceStatusSchema,
  sources: z.array(z.string().min(1)).default([]),
  triggerChain: z.array(z.string().min(1)).default([]),
  uptime: z.number().min(0).max(1).optional(),
  conflictsWith: z.array(z.string().min(1)).default([]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  nativeProbeFingerprint: z.string().min(1).optional(),
  sourceFingerprint: z.string().min(1).optional(),
  coverageStatus: z.enum(["proven", "nonSearchable", "unsupported"]).optional(),
});
export type ConditionEvidence = z.infer<typeof ConditionEvidenceSchema>;

const ActionBaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  preconditions: z.union([
    z.array(z.string().min(1)),
    z.object({ baseFingerprint: z.string().min(1).optional() }).loose(),
  ]).default([]),
  costDivine: z.number().nonnegative().optional(),
  reversible: z.boolean().default(true),
  payload: z.record(z.string(), z.unknown()),
});

export const TradePriceSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().min(1).max(32),
  divineEquivalent: z.number().nonnegative(),
});
export type TradePrice = z.infer<typeof TradePriceSchema>;

const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const TradeStatFilterSchema = z.object({
  id: z.string().min(1).max(256),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  weight: z.number().finite().optional(),
}).superRefine((filter, context) => {
  if (filter.min !== undefined && filter.max !== undefined && filter.min > filter.max) {
    context.addIssue({ code: "custom", message: "Trade stat filter min cannot exceed max" });
  }
});

export const TradeCatalogQuerySchema = z.object({
  runId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  queryHash: Sha256Schema,
  ruleset: z.enum(["3_29", "3_29_ruthless"]),
  realm: z.enum(["pc", "xbox", "sony"]),
  league: z.string().min(1).max(128),
  slot: z.string().min(1).max(64),
  itemSetId: z.number().int().positive().optional(),
  constraints: z.object({
    category: z.string().min(1).max(128),
    baseType: z.string().min(1).max(256).optional(),
    rarity: z.enum(["unique", "rare", "nonunique"]).optional(),
    corrupted: z.boolean().optional(),
    minItemLevel: z.number().int().min(1).max(100).optional(),
    statFilters: z.array(TradeStatFilterSchema).max(64).default([]),
  }),
  limit: z.number().int().min(1).max(10).default(10),
  deadlineAt: z.string().datetime(),
});
export type TradeCatalogQuery = z.infer<typeof TradeCatalogQuerySchema>;

export const TradeCatalogItemSchema = z.object({
  catalogId: z.string().min(1).max(256),
  queryHash: Sha256Schema,
  ruleset: z.enum(["3_29", "3_29_ruthless"]),
  league: z.string().min(1).max(128),
  slot: z.string().min(1).max(64),
  itemSetId: z.number().int().positive().optional(),
  itemRaw: z.string().min(1).max(32 * 1024),
  itemHash: Sha256Schema,
  price: TradePriceSchema,
});
export type TradeCatalogItem = z.infer<typeof TradeCatalogItemSchema>;

export const TradeCatalogResultSchema = z.object({
  runId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  queryHash: Sha256Schema,
  fetchedAt: z.string().datetime(),
  currencySnapshotAt: z.string().datetime(),
  items: z.array(TradeCatalogItemSchema).max(10),
  warnings: z.array(z.string().min(1).max(512)).max(32).default([]),
});
export type TradeCatalogResult = z.infer<typeof TradeCatalogResultSchema>;

export const TradeCatalogCancelSchema = z.object({
  runId: z.string().min(1).max(128),
  requestId: z.string().min(1).max(128),
  reason: z.string().min(1).max(512).optional(),
});
export type TradeCatalogCancel = z.infer<typeof TradeCatalogCancelSchema>;

export const ImportAndEquipPayloadSchema = z.object({
  catalogId: z.string().min(1).max(256),
  slot: z.string().min(1).max(64),
  itemSetId: z.number().int().positive().optional(),
  itemRaw: z.string().min(1).max(32 * 1024),
  itemHash: Sha256Schema,
  source: z.enum(["trade", "unique", "targetRare", "seasonal"]),
  price: TradePriceSchema.optional(),
});

export const SecondaryAscendancyPayloadSchema = z.object({
  secondaryAscendClassId: z.number().int().nonnegative(),
});

export const TreeOverridePayloadSchema = z.object({
  nodeId: z.number().int().positive(),
  name: z.string().min(1).max(256),
  overrideType: z.string().min(1).max(128),
  activeEffectImage: z.string().max(512).optional(),
  icon: z.string().max(512).optional(),
});

export const CatalogPartyBufferPayloadSchema = z.object({
  buffer: z.enum([
    "Aura",
    "Curse",
    "Warcry Skills",
    "Link Skills",
    "PartyMemberStats",
    "EnemyConditions",
    "EnemyMods",
  ]),
  catalogId: z.string().min(1).max(256),
  sourceHash: Sha256Schema,
  text: z.string().max(64_000),
});

export const BuildActionSchema = z.discriminatedUnion("kind", [
  ActionBaseSchema.extend({ kind: z.literal("setRules") }),
  ActionBaseSchema.extend({ kind: z.literal("setIdentity") }),
  ActionBaseSchema.extend({ kind: z.literal("setSkill") }),
  ActionBaseSchema.extend({ kind: z.literal("replaceSkillLinks") }),
  ActionBaseSchema.extend({ kind: z.literal("replaceItem") }),
  ActionBaseSchema.extend({ kind: z.literal("setTree") }),
  ActionBaseSchema.extend({ kind: z.literal("setActor") }),
  ActionBaseSchema.extend({ kind: z.literal("setConfig") }),
  ActionBaseSchema.extend({ kind: z.literal("selectExternal") }),
  ActionBaseSchema.extend({ kind: z.literal("addProgressionStep") }),
  ActionBaseSchema.extend({ kind: z.literal("importAndEquip"), payload: ImportAndEquipPayloadSchema }),
  ActionBaseSchema.extend({
    kind: z.literal("selectSecondaryAscendancy"),
    payload: SecondaryAscendancyPayloadSchema,
  }),
  ActionBaseSchema.extend({ kind: z.literal("setTreeOverride"), payload: TreeOverridePayloadSchema }),
  ActionBaseSchema.extend({ kind: z.literal("setPartyBuffer"), payload: CatalogPartyBufferPayloadSchema }),
]);
export type BuildAction = z.infer<typeof BuildActionSchema>;

export const CandidateLabelSchema = z.enum(["Offence", "Balanced", "Defence"]);
export type CandidateLabel = z.infer<typeof CandidateLabelSchema>;

export const CandidateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  label: CandidateLabelSchema,
  summary: z.string().min(1),
  baseFingerprint: z.string().min(1),
  candidateFingerprint: z.string().min(1).optional(),
  nativeProbeFingerprint: z.string().min(1).optional(),
  evidenceFingerprint: z.string().min(1).optional(),
  cost: z.object({ divine: z.number().nonnegative().default(0), display: z.string().min(1) }),
  metrics: MetricSetSchema,
  scenarioMetrics: z.record(RankedScenarioIdSchema, MetricSetSchema),
  peakScenarioMetrics: z.record(RankedScenarioIdSchema, MetricSetSchema).default({
    mapping: {}, standardBoss: {}, pinnacle: {}, uber: {},
  }),
  actions: z.array(BuildActionSchema),
  evidence: z.array(ConditionEvidenceSchema).default([]),
  hardConstraintsSatisfied: z.boolean(),
  mechanicDiff: MechanicDiffSchema.optional(),
  score: z.number().finite().optional(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const DeepLimitsSchema = z.object({
  recursionLimit: z.number().int().min(1).max(1000).default(40),
  wallTimeMs: z.number().int().positive().default(30 * 60 * 1000),
  evaluationLimit: z.number().int().positive().default(100_000),
  modelCallLimit: z.number().int().nonnegative().default(16),
  convergenceRounds: z.number().int().positive().default(3),
  convergenceThreshold: z.number().min(0).max(1).default(0.005),
  duplicateCallLimit: z.number().int().positive().default(3),
});
export type DeepLimits = z.infer<typeof DeepLimitsSchema>;

export const SearchStopReasonSchema = z.enum([
  "converged",
  "cancelled",
  "time_limit",
  "evaluation_limit",
  "model_call_limit",
  "recursion_limit",
  "doom_loop",
  "exhausted",
]);
export type SearchStopReason = z.infer<typeof SearchStopReasonSchema>;

export const StopReasonSchema = z.enum([
  "completed",
  "cancelled",
  "wall_time",
  "evaluation_limit",
  "model_call_limit",
  "converged",
  "doom_loop",
  "provider_fallback",
  "rejected",
  "failed",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const OptimizationRunSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  buildFingerprint: z.string().min(1),
  status: z.enum(["draft", "running", "paused", "completed", "cancelled", "failed"]),
  objective: ObjectiveSpecSchema,
  scenarios: z.array(ScenarioSpecSchema),
  frontier: z.array(CandidateSchema),
  selected: z.array(CandidateSchema).max(3).default([]),
  evaluations: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(),
  refinementRounds: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  stopReason: StopReasonSchema.optional(),
  searchStopReason: SearchStopReasonSchema.optional(),
  error: z.string().optional(),
});
export type OptimizationRun = z.infer<typeof OptimizationRunSchema>;

export const TransactionResultSchema = z.object({
  runId: z.string().min(1),
  candidateId: z.string().min(1),
  accepted: z.boolean(),
  applied: z.boolean(),
  rolledBack: z.boolean().default(false),
  fingerprint: z.string().min(1).optional(),
  metrics: MetricSetSchema.optional(),
  scenarioMetrics: z.record(RankedScenarioIdSchema, MetricSetSchema).optional(),
  error: z.string().optional(),
}).superRefine((result, context) => {
  if (!result.applied) return;
  if (!result.accepted) {
    context.addIssue({ code: "custom", path: ["accepted"], message: "Applied transaction must be accepted" });
  }
  if (result.rolledBack) {
    context.addIssue({ code: "custom", path: ["rolledBack"], message: "Applied transaction cannot also be rolled back" });
  }
  if (result.fingerprint === undefined) {
    context.addIssue({ code: "custom", path: ["fingerprint"], message: "Applied transaction requires fingerprint" });
  }
  if (result.metrics === undefined) {
    context.addIssue({ code: "custom", path: ["metrics"], message: "Applied transaction requires metrics" });
  }
  if (result.scenarioMetrics === undefined) {
    context.addIssue({ code: "custom", path: ["scenarioMetrics"], message: "Applied transaction requires four scenario metrics" });
  } else {
    for (const scenario of RankedScenarioIdSchema.options) {
      if (result.scenarioMetrics[scenario] === undefined) {
        context.addIssue({
          code: "custom",
          path: ["scenarioMetrics", scenario],
          message: `Applied transaction requires ${scenario} metrics`,
        });
      }
    }
  }
});
export type TransactionResult = z.infer<typeof TransactionResultSchema>;
