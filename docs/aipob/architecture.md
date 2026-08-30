# Current Architecture

This page documents code connected in the current branch. Target capabilities
and release gates belong in [Status and roadmap](status-and-roadmap.md).

## Runtime shape

```text
Path of Building process
  AIPlannerTab.lua
       |
       | capture, run control, provider probe/consent, Trade broker,
       | preview, approval, transaction result
       | bidirectional JSON-RPC 2.0 over authenticated loopback NDJSON
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
slots, requests previews, and opens the final Apply confirmation. It also owns
the visible OpenAI-compatible provider setup, one-shot synthetic connection-test
confirmation, first-send data consent, ephemeral Planner Chat, and exact Trade
realm/league controls. Run and sidecar lifecycle states are independent. Opening
LLM setup starts and handshakes the sidecar without starting an optimization.
Search remains blocked until the selected socket group has an enabled active
main skill.

### Planner controller

[`PlannerController.lua`](../../src/Modules/AIPoB/PlannerController.lua)
launches or reconnects to the sidecar, captures the build, maps RPC
notifications into UI state, verifies the candidate before apply, and reports
the transaction result. It services reverse `trade.catalog.query` and
`trade.catalog.cancel` calls while the existing PoB Trade request queue owns
authentication, rate limiting, currency conversion, and upstream requests.

### Capture and catalog

[`Snapshot.lua`](../../src/Modules/AIPoB/Snapshot.lua) serializes the build,
records gameplay field paths, captures baseline metrics and version metadata,
and calculates the build fingerprint. [`ContentCatalog.lua`](../../src/Modules/AIPoB/ContentCatalog.lua)
exports typed entries already visible to PoB. The current export does not include
an authenticated Trade result set in the snapshot. Trade is queried dynamically
at the search barrier and sanitized before crossing into the sidecar.

### Evaluation and transactions

[`AIPoBWorker.lua`](../../src/AIPoBWorker.lua) accepts immutable jobs and uses
[`BuildSandbox.lua`](../../src/Modules/AIPoB/BuildSandbox.lua) plus the PoB
calculator to produce scenario metrics. The active build is changed only by
[`Transaction.lua`](../../src/Modules/AIPoB/Transaction.lua), which applies an
ordered action graph, verifies results, and restores the original XML on
failure. Worker evaluation first runs [`NativeLinkProbe.lua`](../../src/Modules/AIPoB/NativeLinkProbe.lua)
and [`NativeEvidence.lua`](../../src/Modules/AIPoB/NativeEvidence.lua); incomplete
or truncated native proof rejects the Candidate. Apply re-probes the committed
Build before success.

[`ActorSeason.lua`](../../src/Modules/AIPoB/ActorSeason.lua) projects bounded
player, minion, spectre, Animate Guardian, party, Bloodline, Pact, passive
override, timeless, Graft, Tincture, and Foulborn records. Party text is replaced
by a hash before catalog export. [`ItemImport.lua`](../../src/Modules/AIPoB/ItemImport.lua)
hash-validates raw item text and imports/equips it within the surrounding
Transaction.

[`TransactionJournal.lua`](../../src/Modules/AIPoB/TransactionJournal.lua)
keeps rollback XML while an applied transaction is waiting for the sidecar's
acknowledgement. Successful acknowledgement clears the journal.

## TypeScript sidecar

### Transport boundary

The sidecar listens only on `127.0.0.1`. Each request carries JSON-RPC version
`2.0`, protocol version `3`, and a random per-launch session token of at least 32
characters. The server enforces maximum frame size, request timeout,
authentication, ordered newline-delimited frames, and cancellation.

Request methods:

- `hello`
- `build.capture`
- `build.analyze`
- `run.start`
- `run.stream`
- `run.cancel`
- `run.resume`
- `candidate.preview`
- `transaction.result`
- `provider.status`
- `provider.configure`
- `provider.models.list`
- `provider.test.preview`
- `provider.test`
- `provider.clear`
- `consent.preview`
- `consent.grant`
- `consent.revoke`
- `objective.draft`

Connection-scoped reverse requests from the sidecar to PoB:

- `trade.catalog.query`
- `trade.catalog.cancel`

Server notifications:

- `run.progress`
- `run.mechanicsReady`
- `run.awaitingMechanicReview`
- `run.awaitingApproval`
- `run.completed`
- `run.failed`
- `transaction.apply`

The wire contract is defined by [`protocol.ts`](../../sidecar/src/protocol.ts),
[`schemas.ts`](../../sidecar/src/schemas.ts), and the Lua
[`RpcClient.lua`](../../src/Modules/AIPoB/RpcClient.lua).

### Versioned data contracts

Protocol version `4` and schema version `3` currently cross the process
boundary. Principal validated values are:

- `ObjectiveSpec`: confirmed goals, weights, hard constraints, Locks, Budget,
  search preset, and candidate sources;
- `BuildSnapshot`: immutable XML, fingerprint, versions, metrics, config,
  gameplay paths, catalog, optional graph, plus a PoB-authored
  `ModifierProjection`. The projection enumerates every
  item set, slot, modifier section, line flag, parsed `Mod` type, provenance,
  and conservative item-legality result. Inactive items remain visible but do
  not contribute active mechanic edges;
- `BuildMechanicReport`: deterministic mechanism graph, main-skill source
  chains, structured findings, and a projection-bound analysis fingerprint;
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
one bounded refinement pass when the first pass produces no frontier.

### Domain and search

The domain layer validates canonical graph relations, classifies saved gameplay
fields, generates the scenario set, resolves native condition evidence, and
applies version-gated actor/season adapters for `3_29` and `3_29_ruthless`.
The search layer expands typed catalog actions, evaluates candidate/scenario
pairs through workers, rejects hard-constraint violations, maintains a Pareto
frontier, and selects at most three labelled candidates.

Every proposed link Candidate crosses a native probe barrier. The returned
compatibility matrix, Candidate fingerprint, native-probe fingerprint, and
per-Scenario evidence fingerprint are persisted and rechecked before Apply.
This proves proposed links against PoB's active skill/support rules; broad
full-catalog link generation remains separate roadmap work.

At the search barrier the controller may issue at most eight typed Trade
queries, ten results each and 100 retained results total, with a 30-second
deadline. The sidecar sends semantic constraints only. PoB constructs query
JSON, enforces the user's Divine Budget, removes seller/listing/whisper data,
and returns bounded catalog records. Failure adds a warning and continues local
search.

The CLI injects an OpenAI-compatible adapter only when a non-secret provider
profile, an LLM-only WinCred key, and matching consent are present. The consent
key binds endpoint, model, data categories, privacy policy, redaction policy,
and redacted payload preview. Without it, the deterministic schedule remains
active. Planner Chat returns a strict Objective Draft; the UI requires review
and another Objective confirmation before search.

The `providerCompatibility` capability exposes presets, optional bounded
`/models` discovery, semantic reasoning modes, and explicit advanced overrides.
Auto mode resolves official OpenAI endpoints to Responses and other endpoints
to Chat Completions. Provider-specific encoding maps reasoning and continuation
fields without weakening local tool validation. No-key authentication is
loopback-only.

`providerConnectionTest` exposes a one-shot connection probe.
`provider.test.preview` binds the exact endpoint, model, auth/API/reasoning
selection, resolved request path, policy versions, `connection_probe` category,
and fixed redacted payload hash. After explicit UI confirmation,
`provider.test` makes exactly one bounded request with a required synthetic tool
call and 1024 output tokens. Success issues a short-lived, one-use ticket bound
to the tested settings and credential fingerprint; Configure consumes it. The
probe does not persist the unsaved profile, key, response, consent, or payload,
and does not authorize Build or chat data.

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

The Windows portable starts Node through the packaged GUI-subsystem
`aipob-sidecar-launcher.exe`. The helper passes structured arguments directly to
`CreateProcessW` with `CREATE_NO_WINDOW`; no console/taskbar window is created.
Direct Node launch remains only as an older-package/development fallback.

Provider profiles and consent decisions contain no secret. The API key is held
only by Windows Credential Manager under `AIPathOfBuilding/LLM/<providerId>`.
The native helper accepts JSON lines over stdin/stdout, never command-line
secrets, and rejects every non-LLM credential target. PoE OAuth remains in PoB.
Connection-probe authorization is memory-only and consumed by one matching test
attempt; provider errors use the same redaction boundary and raw responses are
not logged or stored.

## Security and trust boundaries

- Only PoB owns the active build and transaction call.
- The sidecar and model-facing abstractions expose typed high-level actions, not
  raw Lua execution.
- Workers receive immutable snapshots and action batches.
- The RPC listener rejects non-loopback binding and requests without the launch
  token.
- OAuth credentials, seller identity, whispers, listing IDs, URLs, and raw rate
  limit state remain outside the sidecar contract.
- Provider payloads are redacted before the adapter and require descriptor-bound
  consent before each provider becomes callable.
- A connection probe is synthetic, descriptor-bound, one-shot, and never grants
  durable provider consent or permission to send Build/chat data.
- Snapshot XML sent for search is sanitized; rollback XML is requested only by
  the local Transaction path.

## Failure behavior

| Failure | Current behavior |
| --- | --- |
| Sidecar startup or ready-file timeout | Planner reports unavailable; active build remains unchanged |
| RPC authentication or protocol mismatch | Request is rejected with a structured error |
| Worker startup, crash, timeout, or invalid result | Evaluation/run fails; active build remains unchanged |
| Trade unavailable, timed out, or rate-limited | Warning is recorded; deterministic local search continues |
| Provider missing, unconsented, revoked, or unavailable | Deterministic schedule remains active; revocation aborts matching provider calls |
| Connection probe rejected, timed out, or incompatible | Unsaved fields and protected key remain available for retry; saved profile, credential, and durable consent remain unchanged |
| Preview requested | Sidecar returns the persisted Candidate action/metric diff without mutating the active build |
| Apply preflight or action failure | Transaction restores captured XML and reports rollback evidence |
| Lost sidecar acknowledgement after apply | Lua transaction journal retains rollback XML for reconciliation |

## Release and packaging shape

`python3 scripts/aipob.py release-gate` runs sidecar checks/build, manifest validation, the
TypeScript Golden harness, and all AIPoB Lua specs. The version-2 Golden corpus
contains Standard and Ruthless XML Builds plus representative actor/season
projections, required adapters, graph nodes, Candidate actions, baseline
metrics, and four Sustainable Scenario expectations.

Windows artifacts use one canonical staging tree. Portable and repository-owned
NSIS packaging pin Node `24.20.0` x64 / module ABI `137`, the matching
`better-sqlite3` binding, the WinCred helper, the exact sidecar bundle, PoB
runtime files, metadata, and checksums. Packaging transforms only the staged
manifest to include the exact CI head branch and `platform="win32"`; package
metadata records that branch and manifest hash, and verification rejects a
manifest that would trigger the repository-only Dev Mode path. The updater
resolves the script, runtime, work, and package roots separately: program/tree
files remain under `src`, default/sidecar files stay at the package root, and
update staging stays under the work-root `Update` directory. CI verifies silent NSIS installation,
apply/reject/failure paths, checkpoint restart, and a real packaged PoB worker
process without pixel UI automation.

For invariant definitions, continue with [Domain rules](domain-rules.md).
