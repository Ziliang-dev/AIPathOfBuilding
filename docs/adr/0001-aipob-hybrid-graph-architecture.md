# ADR 0001: Keep Path of Building authoritative behind a hybrid graph architecture

- **Status:** Accepted
- **Date:** 2026-08-28
- **Scope:** Calculator authority, process boundary, and orchestration runtime

## Context

Build optimization needs typed orchestration, resumable search, provider
abstraction, and parallel evaluation. Path of Building already owns the content
model, modifier semantics, Build serialization, and calculator. Reimplementing
those rules would create a second authority that drifts from PoB and each Path
of Exile release.

The PoB calculator also has mutable globals and caches. Search must not expose
those internals directly to a model or let speculative evaluation corrupt the
active UI Build.

## Decision

Path of Building's Lua calculator and content model remain the sole authority
for Build semantics and metrics.

A TypeScript sidecar owns the Workflow Graph, Domain Graph, search, provider
abstraction, persistence, and candidate selection behind a small authenticated
loopback RPC interface. Isolated Path of Building worker processes evaluate
immutable Build Snapshots and typed Build Actions. The active PoB process owns
the final Transaction.

## Considered options

- **Reimplement calculations in TypeScript:** rejected because content and
  semantic drift would create two competing sources of truth.
- **Put orchestration and model calls directly in Lua:** rejected because it
  couples fast-changing agent infrastructure to the calculator and weakens
  process isolation.
- **Expose individual calculator operations as model tools:** rejected because
  the interface would mirror implementation complexity and permit invalid
  intermediate Builds.

## Consequences

- Metrics must be produced or reproduced by PoB workers.
- The RPC seam must remain versioned, authenticated, bounded, and tested on both
  sides.
- Worker crashes cannot directly corrupt the active Build.
- The sidecar never owns PoB account credentials.
- Packaging must include a compatible Node runtime and native SQLite module.
- Cross-process changes cost more because Lua and TypeScript contracts must stay
  aligned.

## Current implementation

See [Current architecture](../aipob/architecture.md) and
[Status and roadmap](../aipob/status-and-roadmap.md). Missing adapters do not
weaken the authority decision; they limit which Candidates may be generated.
