# ADR 0007: LLM-led, PoB-verified mechanic understanding

Status: Accepted

## Context

ADR 0006 established a PoB-authored modifier projection and a deterministic
mechanic gate. That projection is authoritative evidence, but a fixed set of
sidecar rules cannot establish complete understanding of an arbitrary Build.
Calling the deterministic `BuildMechanicReport` an understanding result hid
coverage gaps in skills, loadouts, rotations, conditions, actors, seasonal
mechanics, and the second weapon set.

The model is useful for discovering semantic relationships, but it cannot be
trusted as a calculator or mutation author. Mechanic conclusions therefore need
both complete local facts and PoB-executed proof.

## Decision

Add the deep module `MechanicUnderstandingEngine`. Its public operation accepts
one immutable `BuildSnapshot`, both weapon contexts, an abort signal, and
injected Provider, Worker, Store, checkpoint, and limit dependencies. Internal
prompts, tools, experiments, and repair state do not cross this interface.

The engine runs this LangGraph subgraph:

```text
ExtractFacts -> DiscoverClaims -> ValidateCoverage
-> CompileCriticalExperiments -> RunExperiments -> VerifyClaims
-> CritiqueCoverage -> [RepairClaims -> ValidateCoverage | FinalizeReport]
```

The model must page and inspect local PoB facts, then return typed claims through
forced tool calls. A second pass with the same configured model critiques
coverage and proof. Claims are restricted to `grants`, `requires`, `triggers`,
`scales`, `consumes`, and `conflicts`. Local rules recalculate criticality and
reject unknown entities, evidence, contexts, relations, contradictions, and
missing required coverage.

Every semantic claim needs one proven `MechanicProof`:

- `native_exact` for noncritical structure with exact PoB provenance;
- `counterfactual` for critical, ambiguous, partial, unknown, or rotational
  relations.

Counterfactual mutations are compiled locally from a fixed diagnostic
intervention whitelist. They exist only inside isolated workers, cannot be
converted into a public `BuildAction`, never create a Candidate or Transaction,
and never touch the active Build. A zero-delta critical experiment is
indeterminate and blocks the report. A changed source contribution with no
changed final output is proven but marked redundant.

`VerifiedBuildMechanicReport` is the only authoritative understanding artifact.
Its status is `verified` or `blocked`; a blocked report cannot be overridden.
Every semantic graph edge carries its Claim, Proof IDs, context, and effect
state. Auditing a stored report revalidates those links, so removing a required
Proof changes the result to blocked.

The old deterministic `analyzeBuildMechanics()` remains only as a local
projection/fact diagnostic and Candidate-diff helper. It is not accepted as
proof that a Build has been understood.

Protocol version becomes `5`; schema version becomes `4`. The protocol adds
`mechanics.start/status/cancel`, progress/completion/failure notifications, an
optional `mechanicAnalysisFingerprint` on `run.start`, and the
`run.awaitingProvider` state. Old cache namespaces remain untouched, but old
runs are not resumed through the new schema.

New analysis and optimization require a configured, consented, reachable LLM.
There is no deterministic fallback. An exact cached report may avoid repeating
mechanic analysis, but Start still calls the live model in PlanSearch,
RefineSearch, and Explain. Provider failure during optimization checkpoints to
`awaitingProvider`; only Retry or Cancel may continue.

Cache identity binds the Build, projection, fact bundle, PoB engine/data/ruleset,
both weapon contexts, Scenario matrix, understanding/prompt/tool versions, and
Provider endpoint/model/API/reasoning settings. It never includes the key.

Consent adds `mechanic_facts` and `mechanic_experiment_results`; the schema
upgrade requires consent again. Provider profiles and Credential Manager keys
are neither migrated nor deleted.

Limits are fail-closed: at most 16 model calls, three repair rounds, 1024
critical experiments, and three identical tool calls. There is no total wall
clock SLA; individual Provider calls keep their timeout and the user may cancel.

## Consequences

- PoB remains the only authority for Build state, game data, observations, and
  metric deltas.
- The LLM discovers and reviews semantics but cannot author an active-Build
  mutation.
- Both weapon sets and all enabled/Full DPS skills are mandatory active scope;
  inactive saved sets are inventory only.
- Missing or truncated required fact scopes, unproven claims, exhausted limits,
  unavailable Provider, or failed experiments produce a blocked report.
- ADR 0006 is superseded only where it treated the deterministic
  `BuildMechanicReport` as complete mechanic understanding. Its PoB Projection,
  versioning, fail-closed authority, generated-cache, and Transaction decisions
  remain in force.
