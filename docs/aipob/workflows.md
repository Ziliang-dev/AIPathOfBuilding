# Planner Workflows

This page separates the visible user workflow from the internal runtime graph.
All build changes end at the same explicit approval boundary.

## User workflow

### 1. Open and describe

Open an existing PoB build and select **AI Build Planner**. Choose a preset,
describe the desired outcome, set structured survival floors if needed, select
the primary Scenario, choose an optional Budget, and review the default Locks.

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

The current integration searches deterministically. External Trade proposals
and model-driven search are not connected.

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

The current handlers record snapshot, ruleset, catalog, graph, and missing-goal
information. These artifacts guide the deterministic search. Conversational
inspection through the implemented read-only model tools is not yet connected
to this controller path.

### Search and evaluate

The controller builds the Domain Graph, applies registered mechanic adapters,
resolves Condition Evidence, expands typed catalog proposals, and creates a
zero-action baseline Candidate. Worker processes evaluate batches against the
PoB calculator.

Candidates that violate hard constraints, Locks, Budget, graph availability, or
action invariants are removed. Remaining Candidates enter the Pareto frontier.

### Select and pause

The selection layer chooses at most three labelled representatives. The
Workflow Graph emits `run.awaitingApproval` and persists an interrupt. The
active Build remains untouched while paused.

### Fresh verification and transaction

Before sending Apply, the sidecar verifies:

- the Candidate fingerprint still matches the captured Snapshot;
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

The connected deterministic controller currently performs one search pass and
sets `needsRefinement=false`. The graph and limits retain the refinement path
for future controller integration.

See [Architecture](architecture.md) for module ownership and
[Domain rules](domain-rules.md) for candidate invariants.
