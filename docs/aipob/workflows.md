# Planner Workflows

This page separates the visible user workflow from the internal runtime graph.
All build changes end at the same explicit approval boundary.

## User workflow

### 1. Open and describe

Open an existing PoB build and select **AI Build Planner**. Choose a preset,
describe the desired outcome, set structured survival floors if needed, select
the primary Scenario, choose an optional Budget, and review the default Locks.
The selected main socket group must contain an enabled active skill before
search. Level 1 remains valid when that skill exists.

Free-text constraint notes are drafting context only. Minimum EHP and minimum
worst-case maximum hit are the structured hard constraints currently exposed by
the UI.

### 2. Confirm

Select **Confirm this objective before search**. The Start button remains
disabled until confirmation. Any objective edit clears confirmation.

### 3. Search

Select **Start**. PoB launches the sidecar on demand, performs the protocol
handshake, captures the active Build, exports its current content catalog, and
starts a run against the captured fingerprint.

The controller always has a deterministic schedule. When an OpenAI-compatible
provider is configured and consented, the model is injected into planning,
refinement, explanation, and Planner Chat. Typed, Budget-scoped Trade queries
may also run at the search barrier through PoB's authenticated broker.

### 4. Compare

The run evaluates candidates against four Sustainable Scenarios and may also
calculate four Peak profiles. The sidecar maintains a Pareto frontier and
returns up to three views: Offence, Balanced, and Defence.

The candidate card shows summary, primary-Scenario metrics, cost, and action
count. Peak metrics remain secondary and do not satisfy Sustainable hard
constraints.

### 5. Preview

Select **Preview**. The sidecar loads the persisted verified Candidate and
returns its typed action, cost, metric, Scenario, Peak, and evidence diff.
Preview never invokes a worker or the Transaction module. Fresh worker
re-evaluation occurs before Apply.

### 6. Apply or leave unchanged

Select **Apply** and confirm the dialog. The sidecar freshly verifies the
candidate and hard constraints, then sends a `transaction.apply` notification.
PoB performs the Transaction and returns `transaction.result`.

Closing, cancelling, rejecting, or declining the confirmation leaves the active
Build unchanged.

## Runtime workflow

### Capture

PoB serializes the active Build, captures metrics and version information,
enumerates gameplay field paths, and calculates a fingerprint. The sidecar
rejects a snapshot with no coverage-audit paths and stores the accepted
snapshot under its fingerprint.

### Objective normalization

The sidecar validates schema version, goals, weights, Locks, Budget, hard
constraints, and candidate sources. Scenario weights must sum to 1. When no
Budget is present, external item sources are forced off.

### Scenario construction

The workflow creates:

- one unranked Current diagnostic Scenario;
- Mapping, Standard Boss, Guardian/Pinnacle, and Uber Pinnacle Sustainable
  Scenarios; and
- a Peak counterpart for each ranked Scenario.

Only the four Sustainable Scenarios are required for apply verification.

### Inspect, diagnose, and plan

The handlers record snapshot, ruleset, catalog, graph, and missing-goal
information. These artifacts guide deterministic and model-assisted planning.
The model can only use typed read-only tools; it has no mutation or commit tool.
Every provider request is redacted and blocked until consent matches the current
endpoint, model, categories, policy, and payload.

Provider setup has a separate pre-configuration check. Opening **LLM Setup**
starts the sidecar without starting search. Auto resolves provider dialect and
reasoning behavior; Advanced permits explicit overrides. A one-shot
authorization permits exactly one fixed synthetic required-tool probe and
nothing else. Success creates a short-lived ticket bound to exact settings and
credential fingerprint. Configure consumes it, then enters the existing
first-send consent workflow. No automatic dialect retry creates a second
provider request.

### Search and evaluate

The controller builds the Domain Graph, applies registered mechanic adapters,
resolves Condition Evidence, expands typed catalog proposals, and creates a
zero-action baseline Candidate. If enabled, it asks PoB for bounded Trade
catalog pages; PoB retains OAuth, rate limits, seller identity, and raw Trade
responses. The sidecar receives sanitized typed items only. Trade failure adds
a warning and does not abort local search. Worker processes evaluate batches
against the PoB calculator.

Every proposed skill link passes a native PoB compatibility probe before
evaluation. Accepted evidence is complete, non-truncated, scenario-bound, and
fingerprint-bound. Actor and season adapters project player, minion, spectre,
Animate Guardian, party, Bloodline, Pact, advanced passive, and seasonal
equipment state for `3_29` and `3_29_ruthless`.

Candidates that violate hard constraints, Locks, Budget, graph availability, or
action invariants are removed. Remaining Candidates enter the Pareto frontier.

### Select and pause

The selection layer chooses at most three labelled representatives. The
Workflow Graph emits `run.awaitingApproval` and persists an interrupt. The
active Build remains untouched while paused.

### Fresh verification and transaction

Before sending Apply, the sidecar verifies:

- the Candidate fingerprint still matches the captured Snapshot;
- the Candidate proof fingerprint still matches its native link and Condition
  Evidence inputs;
- all four Sustainable Scenario metrics can be reproduced;
- metric differences remain within the implemented tolerance; and
- hard constraints still pass.

PoB then performs its own preflight in a sandbox, orders the action dependency
graph, checks preconditions and build fingerprint, applies all actions, rebuilds
the Build, rechecks metrics, and verifies all Sustainable Scenarios.

If any step fails, PoB restores the captured XML and verifies the restored
fingerprint. The result reports whether rollback succeeded.

## Cancellation and recovery

- A cancel request aborts pending startup, active workers, and the run.
- Cancelled, completed, and failed runs are terminal.
- A nonterminal persisted run can reconnect through `run.stream` and
  `run.resume`.
- Restart recovery requires the persistent LangGraph checkpoint database.
- An applied transaction awaiting acknowledgement is also recorded in
  `AIPathOfBuilding-transaction-journal.json` under the PoB user path.
- On reconnect, PoB reconciles the transaction result or restores the saved
  rollback Snapshot if the sidecar cannot complete the audit.

## Run limits

The Deep preset currently defines these upper bounds:

| Limit | Default |
| --- | ---: |
| Workflow recursions | 40 |
| Wall time | 30 minutes |
| Candidate × Sustainable Scenario evaluations | 100,000 |
| Model calls | 16 |
| No-improvement convergence rounds | 3 |
| Duplicate tool-call limit | 3 |

The deterministic fallback normally completes one bounded search pass. A
consented provider can use the connected bounded refinement path. Richer
multi-round refinement policy remains roadmap work.

See [Architecture](architecture.md) for module ownership and
[Domain rules](domain-rules.md) for candidate invariants.
