# Current Architecture

This page documents code connected in the current branch. Target capabilities
and release gates belong in [Status and roadmap](status-and-roadmap.md).

## Runtime shape

```text
Path of Building process
  AIPlannerTab.lua
       |
       | capture, run control, preview, approval, transaction result
       | JSON-RPC 2.0 over authenticated loopback NDJSON
       v
TypeScript sidecar
  RPC -> controller -> workflow -> domain/search -> store
                           |
                           | immutable evaluation jobs
                           v
                 isolated PoB worker processes
                           |
                           v
                 BuildSandbox + PoB calculator
```

PoB owns build state and calculation. The sidecar owns run orchestration and
candidate search. Worker processes keep evaluation mutations away from the
active UI build.

## PoB process

### Planner UI

[`AIPlannerTab.lua`](../../src/Classes/AIPlannerTab.lua) builds the structured
objective, requires explicit confirmation, displays progress and three candidate
slots, requests previews, and opens the final Apply confirmation.

### Planner controller

[`PlannerController.lua`](../../src/Modules/AIPoB/PlannerController.lua)
launches or reconnects to the sidecar, captures the build, maps RPC
notifications into UI state, verifies the candidate before apply, and reports
the transaction result.

### Capture and catalog

[`Snapshot.lua`](../../src/Modules/AIPoB/Snapshot.lua) serializes the build,
records gameplay field paths, captures baseline metrics and version metadata,
and calculates the build fingerprint. [`ContentCatalog.lua`](../../src/Modules/AIPoB/ContentCatalog.lua)
exports typed entries already visible to PoB. The current export does not include
an authenticated external Trade result set.

### Evaluation and transactions

[`AIPoBWorker.lua`](../../src/AIPoBWorker.lua) accepts immutable jobs and uses
[`BuildSandbox.lua`](../../src/Modules/AIPoB/BuildSandbox.lua) plus the PoB
calculator to produce scenario metrics. The active build is changed only by
[`Transaction.lua`](../../src/Modules/AIPoB/Transaction.lua), which applies an
ordered action graph, verifies results, and restores the original XML on
failure.

[`TransactionJournal.lua`](../../src/Modules/AIPoB/TransactionJournal.lua)
keeps rollback XML while an applied transaction is waiting for the sidecar's
acknowledgement. Successful acknowledgement clears the journal.

## TypeScript sidecar

### Transport boundary

The sidecar listens only on `127.0.0.1`. Each request carries JSON-RPC version
`2.0`, protocol version `1`, and a random per-launch session token of at least 32
characters. The server enforces maximum frame size, request timeout,
authentication, ordered newline-delimited frames, and cancellation.

Request methods:

- `hello`
- `build.capture`
- `run.start`
- `run.stream`
- `run.cancel`
- `run.resume`
- `candidate.preview`
- `transaction.result`

Server notifications:

- `run.progress`
- `run.awaitingApproval`
- `run.completed`
- `run.failed`
- `transaction.apply`

The wire contract is defined by [`protocol.ts`](../../sidecar/src/protocol.ts),
[`schemas.ts`](../../sidecar/src/schemas.ts), and the Lua
[`RpcClient.lua`](../../src/Modules/AIPoB/RpcClient.lua).

### Versioned data contracts

Protocol version `1` and schema version `1` currently cross the process
boundary. Principal validated values are:

- `ObjectiveSpec`: confirmed goals, weights, hard constraints, Locks, Budget,
  search preset, and candidate sources;
- `BuildSnapshot`: immutable XML, fingerprint, versions, metrics, config,
  gameplay paths, catalog, and optional graph;
- `ScenarioSpec`: enemy class, profile, modifiers, events, and assumptions;
- `ConditionEvidence`: source chain, uptime, conflict, confidence, and status;
- `BuildAction`: typed payload, dependencies, preconditions, cost, and
  reversibility;
- `Candidate`: base fingerprint, actions, cost, Scenario metrics, Peak metrics,
  evidence, and constraint result;
- `OptimizationRun`: status, Objective, Scenarios, frontier, selections, usage,
  and stop reason; and
- `TransactionResult`: approval, apply/rollback state, fingerprints, metrics,
  and error.

Definitions and invariants are in [Core concepts](core-concepts.md) and
[Domain rules](domain-rules.md).

### Workflow controller

[`plannerController.ts`](../../sidecar/src/plannerController.ts) validates
snapshots and objectives, owns active runs and worker pools, persists run state,
starts or resumes the LangGraph workflow, streams notifications, and freshly
verifies a selected candidate before sending `transaction.apply`.

The compiled graph currently contains:

```text
CaptureBuild -> DraftObjective -> ConfirmObjective -> BuildScenarios
-> Inspect -> Diagnose -> PlanSearch -> SearchDomains -> MergePareto
-> Verify -> [RefineSearch -> SearchDomains | Explain]
-> Preview -> HumanApproval
-> [ApplyTransaction | Reject] -> FinalVerify -> End
```

The current controller supplies deterministic handlers for inspection,
diagnosis, domain search, selection, and apply verification. The graph contains
refinement nodes, but the connected verification handler currently sets
`needsRefinement=false` after the search pass.

### Domain and search

The domain layer validates canonical graph relations, classifies saved gameplay
fields, generates the scenario set, and resolves available condition evidence.
The search layer expands typed catalog actions, evaluates candidate/scenario
pairs through workers, rejects hard-constraint violations, maintains a Pareto
frontier, and selects at most three labelled candidates.

The current CLI does not inject the model adapter. Search therefore uses the
deterministic schedule and reports provider fallback in the final stop reason.

### Persistence

Two SQLite responsibilities have different failure policies:

- The planner run/snapshot/cache store uses `aipob.sqlite`. If that store cannot
  load, the sidecar warns and uses a non-persistent in-memory store.
- The LangGraph checkpoint store uses `checkpoints.sqlite`. Persistent
  checkpoint creation is required by the production CLI; if it cannot load,
  sidecar startup fails.

This distinction prevents an interrupt from appearing restart-resumable when
only memory state exists. Run-store fallback alone does not make checkpoints
non-persistent.

The ready file publishes protocol version, loopback host, selected port, and
PID. It never contains the session token. The sidecar removes only a ready file
whose PID still belongs to its process.

## Security and trust boundaries

- Only PoB owns the active build and transaction call.
- The sidecar and model-facing abstractions expose typed high-level actions, not
  raw Lua execution.
- Workers receive immutable snapshots and action batches.
- The RPC listener rejects non-loopback binding and requests without the launch
  token.
- External Trade and provider credentials are not connected in the current
  runtime.
- OAuth credentials and seller identity remain outside the sidecar contract.

## Failure behavior

| Failure | Current behavior |
| --- | --- |
| Sidecar startup or ready-file timeout | Planner reports unavailable; active build remains unchanged |
| RPC authentication or protocol mismatch | Request is rejected with a structured error |
| Worker startup, crash, timeout, or invalid result | Evaluation/run fails; active build remains unchanged |
| External source requested | Source is disabled and run returns a warning |
| Provider unavailable | Deterministic schedule remains active |
| Preview requested | Sidecar returns the persisted Candidate action/metric diff without mutating the active build |
| Apply preflight or action failure | Transaction restores captured XML and reports rollback evidence |
| Lost sidecar acknowledgement after apply | Lua transaction journal retains rollback XML for reconciliation |

For invariant definitions, continue with [Domain rules](domain-rules.md).
