# ADR 0002: Require a human-gated transaction for every Build change

- **Status:** Accepted
- **Date:** 2026-08-28
- **Scope:** Approval, mutation, verification, and rollback

## Context

Optimization explores speculative and sometimes model-guided recommendations.
A recommendation can be invalid, stale, or only partially applicable. Applying
individual actions directly would leave the active Build in a hard-to-diagnose
intermediate state.

Users must be able to inspect candidates without granting an autonomous system
permission to change their Build.

## Decision

Optimization is read-only until the user explicitly approves one immutable
Candidate for one matching Build Snapshot.

Before requesting mutation, the sidecar freshly verifies the Candidate in all
four Sustainable Scenarios. PoB then snapshots the active Build, checks the base
fingerprint, preflights the ordered action graph, applies all actions as one
Transaction, rebuilds and verifies the result, and restores the exact prior
Snapshot after any failure. A local journal protects an applied result that is
waiting for sidecar acknowledgement.

## Considered options

- **Apply the top Candidate automatically:** rejected because ranking does not
  imply user consent and stale recommendations can still be validly calculated.
- **Expose per-action Apply controls:** rejected because partial Candidates may
  violate dependencies or hard constraints.
- **Let the model call a mutation tool:** rejected because typed read-only tools
  provide no safe way to express user approval or atomic rollback.

## Consequences

- There is no model-visible commit or mutation tool.
- Approval is scoped to one Candidate ID and base fingerprint.
- Preview is non-mutating.
- Stale approval and metric drift fail closed.
- Automatic retry after a failed Transaction is forbidden.
- Rollback failure must be reported as non-recoverable, never hidden as success.

## Current implementation

The approval interrupt, fresh sidecar verification, Lua Transaction, and
transaction journal are connected. See [Planner workflows](../aipob/workflows.md)
and [Domain rules](../aipob/domain-rules.md#transaction-invariants).
