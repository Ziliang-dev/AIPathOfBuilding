# Require a human-gated transaction for every Build change

Optimization is autonomous and read-only: the model may inspect, diagnose, search, refine, evaluate, explain, and plan progression, but it cannot change the active Build. A Candidate may enter a Transaction only after explicit user approval; the Transaction checks the base fingerprint, re-evaluates the Candidate in a fresh worker, snapshots the active Build, applies typed Build Actions, verifies the result, and restores the exact snapshot after any failure. This extra friction is chosen over automatic application because build changes are stateful, model-generated recommendations can be wrong, and a partially applied Candidate is harder to diagnose than a rejected one.

## Consequences

There is no model-visible commit or mutation tool. Approval is scoped to one immutable Candidate and one matching Build Snapshot, stale approval fails closed, and automatic retry after a failed Transaction is forbidden.
