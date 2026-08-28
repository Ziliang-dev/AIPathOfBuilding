# Keep Path of Building authoritative behind a hybrid graph architecture

Path of Building's Lua calculator and content model remain the sole authority for Build semantics and metrics. AIPathOfBuilding places a TypeScript Workflow Graph and Domain Graph behind a small local RPC interface, while isolated Path of Building worker processes evaluate Build Snapshots and typed Build Actions. This hybrid shape is harder to package than an all-Lua planner and adds process-failure modes, but it prevents a second calculator from drifting, gives the search and model orchestration a typed ecosystem, and keeps the calculator behind a deep module rather than exposing hundreds of shallow Lua operations to the model.

## Considered options

- Reimplement calculations in TypeScript: rejected because content and semantic drift would create two competing sources of truth.
- Put orchestration and model calls directly in Lua: rejected because it couples fast-changing agent infrastructure to the calculator and weakens process isolation.
- Expose individual calculator operations as model tools: rejected because the interface would mirror implementation complexity and allow invalid intermediate Builds.

## Consequences

The local RPC seam is versioned and authenticated, the sidecar never owns Path of Building account credentials, and worker crashes cannot corrupt the active Build. Packaging must include the sidecar runtime, and cross-process contract tests are a release requirement.
