# ADR 0006: PoB-authored modifier projection and mechanic gate

Status: Accepted

## Context

Optimization is unsafe when the model sees item text without knowing which
item is active, how PoB parsed the modifier, where a borrowed modifier came
from, or whether the item is structurally legal. Copying PoB modifier tables
into the sidecar would create a second, version-drifting game database.

## Decision

PoB remains authoritative. On capture it emits a bounded, fingerprinted
`ModifierProjection` from live Item objects and loaded PoB data tables. It
contains all modifier sections and flags, generic parsed Mods, provenance,
active/inactive references, and conservative legality findings.

The sidecar builds a deterministic `BuildMechanicReport` and runs a mechanic
gate before diagnosis/search. Critical unknown or invalid evidence blocks;
noncritical unverifiable evidence warns. A blocked report cannot be overridden.
Model tools are read-only views over this report and the projection.

Generated caches such as Glorious Vanity data must be validated before use and
written atomically. A corrupt or truncated cache is rejected and regenerated.

## Consequences

- One source of game truth: current PoB code/data.
- Protocol/schema changes stay explicit and testable.
- New PoB modifier types cross generically without a sidecar schema release.
- Mechanism coverage can grow without granting raw Lua or mutation authority.
