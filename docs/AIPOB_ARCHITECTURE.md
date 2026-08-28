# AIPathOfBuilding Architecture

This document defines the target architecture and release contract for the full-domain AIPathOfBuilding planner. Path of Building remains usable without the sidecar or a model provider.

## Product contract

AIPathOfBuilding optimizes every gameplay-relevant field represented by a Path of Building save, except calculated output, notes, and purely visual state. Coverage includes:

- ruleset, tree version, league, game mode, and content availability;
- level, class, ascendancy, Bloodline, Pacts, bandit choice, and Pantheon;
- active, support, triggered, Vaal, transfigured, awakened, and imbued skills, including levels, quality, sockets, links, reservations, parts, stages, and rotations;
- equipment, weapon sets, jewels, flasks, tinctures, grafts, Foulborn items, Animate Guardian item sets, and loadouts;
- passive topology, ascendancy nodes, masteries, clusters, timeless and Abyss timeless jewels, tattoos, runegrafts, and anoints;
- player, minion, spectre, Animate Guardian, and party actors, including aura and buff provenance;
- enemy state, boss skill presets, map modifiers, charges, ailments, curses, exposure, recent events, resources, and sustained conditions;
- equipped items, the unique catalog, target rares, existing Path of Building Trade, and budget/level progression plans.

The planner deliberately excludes stashes, guild stashes, character inventory, rucksack, Atlas and farming optimization, probabilistic crafting simulation, automated purchase or messaging, game input, account writes, new OAuth scopes, and undocumented external interfaces.

## Runtime shape and seams

```text
Path of Building Planner tab
        | versioned JSON-RPC 2.0 over authenticated loopback NDJSON
        v
TypeScript sidecar
  - Workflow Graph and checkpoints
  - Domain Graph and objective model
  - search, Pareto frontier, cache, and model adapter
        | batched immutable evaluation requests
        v
isolated Path of Building worker processes
        |
        v
full BuildSandbox and authoritative PoB calculator
```

The system uses four principal deep modules:

1. **Planner module.** Its interface captures the active Build, streams an Optimization Run, previews Candidates, requests user approval, and displays a Transaction result. It never performs search logic.
2. **Orchestrator module.** Its interface accepts a confirmed Objective and Build Snapshot, then returns resumable run events and immutable Candidates. Workflow, search, provider variation, caching, and budget enforcement remain inside its implementation.
3. **Evaluator module.** Its interface accepts a Build Snapshot, typed Build Actions, and Scenario specifications, then returns metrics and Condition Evidence. Loading, applying, rebuilding, and all calculator internals remain inside its implementation.
4. **Transaction module.** Its interface accepts one approved Candidate and the expected active fingerprint, then returns an applied, rejected, or restored result. Snapshotting, action ordering, verification, and restoration remain inside its implementation.

The loopback RPC seam binds only to `127.0.0.1`. Its interface includes protocol negotiation, request identifiers, a random per-launch session token, maximum frame size, timeouts, cancellation, structured errors, and backpressure. The main process retains OAuth credentials and the existing Trade rate limiter; neither credentials nor seller identity cross the sidecar seam.

Workers are process-isolated because the calculator has mutable globals and caches. Each worker evaluates one request at a time. The default pool size is `min(4, max(1, floor(availableParallelism / 2)))`, configurable from one through eight workers.

## Versioned public types

All cross-process values carry a schema version and reject unknown incompatible versions.

- `ObjectiveSpec`: confirmed metrics, Hard Constraints, Primary Scenario, Scenario weights, Locks, Budget, candidate sources, and search preset.
- `ObjectiveSpecDraft`: conversational interpretation that cannot start a run until confirmed in the structured Planner form.
- `BuildSnapshot`: full serialized Build, engine/content/ruleset versions, fingerprint, and baseline metrics.
- `ScenarioSpec`: enemy preset, encounter modifiers, evaluation profile, and permitted event assumptions.
- `ConditionEvidence`: condition classification, source chain, uptime, conflicts, and confidence.
- `BuildAction`: a discriminated union containing payload, preconditions, dependencies, cost, and reversibility.
- `Candidate`: immutable identifier, base fingerprint, Build Action graph, per-Scenario metrics, Peak metrics, cost, and evidence.
- `OptimizationRun`: Workflow Graph state, frontier, consumed limits, checkpoint, and stopping reason.
- `TransactionResult`: status, before/after fingerprints, verification metrics, and restoration evidence when applicable.

RPC request methods are `hello`, `build.capture`, `run.start`, `run.stream`, `run.cancel`, `run.resume`, `candidate.preview`, and `transaction.result`. Server notifications are `run.progress`, `run.awaitingApproval`, `transaction.apply`, `run.completed`, and `run.failed`. `run.stream` reconnects a client to persisted run state; LangGraph checkpoints make interrupted workflow state resumable.

## Workflow Graph and model interface

The sidecar uses a LangGraph `StateGraph` with conditional edges, durable SQLite checkpoints, and an interrupt before the Transaction:

```text
CaptureBuild -> DraftObjective -> ConfirmObjective -> BuildScenarios
-> Inspect -> Diagnose -> PlanSearch -> SearchDomains -> MergePareto
-> Verify -> [improvement possible?]
              yes -> RefineSearch -> SearchDomains
              no  -> Explain -> Preview -> HumanInterrupt
                    -> ApplyTransaction | Reject
                    -> FinalVerify -> End
```

The model receives only seven high-leverage, read-only tools:

- `inspect_build`
- `diagnose_build`
- `search_build`
- `refine_search`
- `evaluate_candidate`
- `explain_candidate`
- `plan_progression`

Tool inputs and outputs are schema-validated. The model cannot invoke Lua, emit raw item text as a mutation, apply an individual Build Action, or enter a Transaction. Without a configured provider, or after a provider failure, a deterministic domain schedule continues the run.

The Deep preset stops on the first applicable condition: 40 Workflow Graph recursions, 30 elapsed minutes, 100,000 `Candidate x Sustainable Scenario` evaluations, 16 model requests, user cancellation, or convergence. Convergence means three refinement rounds with no new non-dominated Candidate and less than 0.5% improvement in the Primary Scenario. Three identical tool calls against unchanged state trigger doom-loop termination. Cancellation and limit exhaustion preserve the checkpoint and current frontier.

## Domain Graph

The Domain Graph normalizes nodes from Path of Building content and the current Build. Edges use only these canonical relations:

- `grants`
- `requires`
- `triggers`
- `scales`
- `consumes`
- `conflicts`
- `replaces`
- `usesSlot`
- `availableIn`

Catalog extraction comes from current Path of Building data. Versioned Mechanic Adapters add semantics that cannot be inferred mechanically. A coverage manifest classifies every gameplay-relevant saved field and content family; a new unclassified field fails the release gate instead of being silently ignored.

Candidate generation is domain-specific but hidden behind one search interface:

- skills use compatibility filtering followed by complete link beam search;
- passives use connected path and cluster swaps plus mastery, jewel, tattoo, runegraft, and anoint packages;
- items form per-slot Pareto shortlists followed by cross-slot beam search, retaining build-enabling packages;
- minion and party actors retain explicit provenance and never invent absent party buffs;
- cross-domain search uses coordinate descent over a shared beam frontier and regenerates only affected domains.

The evaluation cache key includes engine commit, ruleset, Build fingerprint, canonical Build Action graph, Scenario, and Objective version.

Trade remains behind the existing Path of Building Trade interface and rate limiter. It returns normalized candidates and never exposes OAuth credentials to the sidecar or model. An Objective without a Budget disables Trade, new equipment, and target-rare generation while still allowing optimization of skills, passives, configurations, and existing item combinations.

## Scenario and condition policy

Every Candidate is evaluated in four Sustainable Profiles:

| Scenario | Path of Building enemy preset | Encounter assumptions |
| --- | --- | --- |
| Mapping | `None` | Current applicable map modifiers; on-kill conditions may be sustainable |
| Standard Boss | `Boss` | Standard boss; no adds assumed |
| Guardian/Pinnacle | `Pinnacle` | Guardian or pinnacle boss; no adds assumed |
| Uber Pinnacle | `Uber` | Uber pinnacle boss; no adds assumed |

Each Scenario also produces a Peak Profile shown separately and excluded from primary ranking. The current manually configured Build is retained as a diagnostic view, not accepted as evidence for a standard Scenario.

A condition enters a Sustainable Profile only when the Build has a legal source and trigger chain, its resource/cooldown/duration model supports at least 90% uptime, and it does not conflict with another selected condition. Lower uptime is `intermittent` or `proven_peak`. Mutually exclusive conditions become separate variants. On-kill conditions may be sustainable for Mapping, but never for boss Scenarios unless the encounter explicitly proves adds.

All four Sustainable Profiles must satisfy every Hard Constraint. The default Primary Scenario is Mapping and weights are 55% for it and 15% for each remaining Scenario. Rankings retain the Pareto Frontier rather than reducing it to one score:

- Offence maximizes damage among valid Candidates.
- Balanced selects the knee Candidate nearest the multi-objective ideal.
- Defence maximizes worst-case maximum hit, effective hit pool, and recovery.

## Human-gated Transaction

Search and preview operate only on isolated Build Snapshots. Applying a Candidate follows this exact sequence:

1. Compare the active fingerprint with the Candidate's base fingerprint; reject stale Candidates.
2. Re-evaluate the complete Candidate in a fresh worker.
3. Capture the exact active Build serialization.
4. Topologically order and apply typed Build Actions.
5. Rebuild and verify the resulting fingerprint, metrics, and Hard Constraints.
6. On any error or failed verification, restore the exact prior serialization, rebuild it, and verify its original fingerprint.
7. Record the outcome; never let the model retry automatically.

Only an explicit Planner action after the Workflow Graph interrupt can start this sequence. Approval applies to one immutable Candidate and one base fingerprint.

## Persistence, privacy, and failure modes

SQLite in the Path of Building user-data directory stores checkpoints, run history, frontiers, cache indexes, and Transaction audits. The production sidecar fails closed if its persistent SQLite checkpointer cannot load; it never advertises restart recovery backed only by memory. While an applied Build is waiting for the sidecar audit ACK, PoB also keeps a local `AIPathOfBuilding-transaction-journal.json` containing the rollback XML; atomic backup rotation protects recovery, and ACK reconciliation deletes it. The evaluation cache uses a 2 GiB LRU default; unpinned runs expire after 30 days. A Build save contains only non-sensitive Objective/Scenario state and its schema version. Windows Credential Manager integration remains a release gate before provider secrets may be enabled.

Before model submission, the privacy Adapter removes OAuth credentials, provider secrets, account and character identifiers, and Trade seller information. Sending the full Build to a provider requires first-use consent.

Every failure closes safely:

| Failure | Required behavior |
| --- | --- |
| Sidecar unavailable or incompatible | Planner reports unavailable; ordinary Path of Building remains functional |
| Worker crash or timeout | Request fails or retries in a fresh worker within the run limit; active Build is untouched |
| Provider missing, malformed, or unavailable | Reject malformed output and continue deterministic search |
| RPC authentication, schema, or frame failure | Drop the connection and record a structured local error |
| Cancellation or limit reached | Stop scheduling work, preserve checkpoint and frontier |
| Active Build changed after preview | Reject the stale Candidate |
| Build Action or final verification failure | Restore and verify the exact prior Build |
| Restoration cannot be verified | Stop all mutation, retain both serializations, and surface a critical recovery error |
| Trade throttled or unavailable | Respect the existing limiter and continue without external candidates |

## Defaults and release gate

- Windows x64 is the first supported release platform; the package carries a Node 24 x64 runtime and matching native dependencies. Development and CI support Node 22.13+ and Node 24.
- The Planner UI is English. Model explanations follow the user's input language.
- Class, ascendancy, and main skill are locked by default and may be explicitly unlocked.
- The default output is Offence, Balanced, and Defence Candidates from one Pareto Frontier.
- Sustainable metrics drive ranking; Peak metrics are supplementary.
- Existing Path of Building account import, OAuth scopes, and Trade behavior remain unchanged.

A release is blocked unless:

- every gameplay-relevant saved field and supported content family is classified;
- all domain generators and Mechanic Adapters have representative golden Builds;
- schema, graph routing, convergence, caching, provider fallback, cancellation, and checkpoint tests pass;
- full Build round-trip, Party state, every Build Action, every Scenario, and Condition Evidence tests pass;
- RPC fragmentation, ordering, authentication, timeout, crash, cancellation, and reconnect tests pass;
- fault injection proves exact restoration at every Transaction step;
- Trade tests use recorded fixtures and never call the live interface in CI;
- a clean Windows x64 host without Node can complete an Optimization Run;
- existing Path of Building tests remain green.
