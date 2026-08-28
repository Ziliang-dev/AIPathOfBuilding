# AIPathOfBuilding Agent Guide

This file applies to the entire repository. Preserve upstream Path of Building
behavior unless the task explicitly changes it. Do not revert unrelated user
changes.

## Read before changing code

For any AIPoB domain, search, evaluation, or transaction change, read:

- `docs/aipob/architecture.md`
- `docs/aipob/domain-rules.md`
- `docs/aipob/status-and-roadmap.md`
- relevant files under `docs/adr/`

For inherited PoB behavior, also read the relevant upstream reference under
`docs/` and inspect the current Lua implementation and tests.

## Sources of truth

1. Current code and tests define implemented behavior.
2. Accepted ADRs define architectural constraints.
3. `docs/aipob/status-and-roadmap.md` defines capability status.
4. Upstream PoB code and documentation define inherited PoB behavior.
5. Official Path of Exile sources precede PoE Wiki for released facts.

Do not describe a target capability as current. Put planned work in the status
page or an ADR.

## Cross-process contracts

- PoB remains authoritative for Build state, game data, and metrics.
- Keep JSON-RPC methods, protocol schemas, TypeScript types, and Lua validation
  aligned.
- Preserve existing `SCHEMA_VERSION` and `PROTOCOL_VERSION` meanings. Increment
  versions deliberately when compatibility changes.
- The sidecar and model-facing code may produce only typed, validated Build
  Actions. Never add raw Lua or an unvalidated mutation escape hatch.
- Every active-Build change must remain an explicit, fingerprint-bound,
  human-approved Transaction with rollback.
- Trade authentication, OAuth tokens, seller identity, and rate limiting remain
  in the PoB process.

## Required checks

For sidecar or cross-process changes, run from the repository root:

```powershell
./scripts/check-sidecar.ps1
./scripts/build-sidecar.ps1
./scripts/check-manifest.ps1
```

For Lua behavior, run the relevant Busted specs, preferably through:

```powershell
docker compose up --abort-on-container-exit
```

At minimum, target the matching files under `spec/System/`. A protocol or
Transaction change normally requires both TypeScript and Lua tests.

All project PowerShell scripts target `pwsh`. Start non-trivial scripts with
strict mode and terminating errors, use `-LiteralPath` for filesystem paths,
check external command exit codes, and syntax-check changed `.ps1` files with
`System.Management.Automation.Language.Parser` before execution.

## Generated and release files

- `sidecar/dist/server.cjs` is generated but tracked because PoB's manifest and
  auto-update path ship it. Never hand-edit it; rebuild from TypeScript.
- Build the deterministic bundle before manifest generation.
- Run `scripts/check-manifest.ps1` after rebuilding the bundle.
- Node.js and the `better-sqlite3` native runtime are installer-owned. Do not
  add them to the auto-update manifest.
- Do not hand-edit files marked as generated under `src/Data` or `src/TreeData`;
  update their exporter and regenerate them.

## Sensitive and local data

Never commit API keys, OAuth tokens, credential exports, `.env` files, SQLite
databases, logs, ready files, transaction journals, user Builds, or a local Node
runtime. Keep RPC bound to `127.0.0.1` and retain per-launch authentication.

## Documentation

- `docs/index.md` is the only Wiki index; do not create `wiki.md`.
- Current architecture belongs in `docs/aipob/architecture.md`.
- Missing and target behavior belongs in `docs/aipob/status-and-roadmap.md`.
- Version-sensitive game facts must name their PoE version and link to a source.
- When behavior or coverage changes, update the relevant Wiki page and status
  matrix in the same change.
- Keep old public documentation paths as short compatibility pages instead of
  maintaining duplicate facts.
