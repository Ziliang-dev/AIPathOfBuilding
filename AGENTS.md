# AIPathOfBuilding Agent Guide

This file applies to the entire repository. Preserve upstream Path of Building
behavior unless the task explicitly changes it. Do not revert unrelated user
changes.

## Shell environment

- Use WSL2 Ubuntu with Bash by default for all commands, including repository
  searches, Git, Python, Node.js, Docker, Lua tools, tests, and builds.
- Do not add or run PowerShell scripts. Repository commands use the Python CLI
  from WSL; Windows-only packaging runs the same CLI in GitHub Actions.
- Use `cmd.exe` only for WSL lifecycle or configuration, `.wslconfig`,
  `usbipd`, or another required Windows-only bridge.
- Do not use PowerShell or `cmd.exe` when an equivalent WSL command works.
- Keep Linux tool caches and virtual environments inside the WSL filesystem.
  Write final project artifacts to the mounted workspace only.

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

```bash
python3 scripts/aipob.py check-sidecar
python3 scripts/aipob.py build-sidecar
python3 scripts/aipob.py check-manifest
```

For Lua behavior, run the relevant Busted specs, preferably through:

```bash
docker compose up --abort-on-container-exit
```

At minimum, target the matching files under `spec/System/`. A protocol or
Transaction change normally requires both TypeScript and Lua tests.

All repository commands run through `scripts/aipob.py`. Syntax-check changed
Python command modules with `python3 -m py_compile` from WSL and check every
external command exit code.

## Post-update CI artifact sync

- Do not create a scheduled task, heartbeat, polling daemon, or self-hosted
  runner for local artifact synchronization.
- After an agent-authored repository update is committed and pushed, wait for
  every required GitHub Actions check associated with the exact pushed HEAD.
- Repair failures and wait for the replacement checks. Never synchronize an
  artifact from a failed, cancelled, stale, or still-running workflow.
- Download a new Windows portable only when the update can change application
  behavior or shipped package contents. Examples include Lua or sidecar source,
  runtime assets, dependencies, manifest generation, packaging, or installer
  changes.
- Do not download a portable for documentation-only, `AGENTS.md`, `.gitignore`,
  spelling dictionary, test-only, or CI metadata changes that cannot alter the
  shipped package. Report that synchronization was skipped and why.
- For a qualifying update, after the exact HEAD's `AIPoB Sidecar` workflow and
  aggregate release gate pass, run `python3 scripts/aipob.py sync-ci-windows`
  once from WSL.
- After synchronization, confirm `artifacts/ci-latest/ci-sync.json` records the
  current HEAD and report the Actions run ID and launch path. The command
  handles idempotence and latest-only replacement; do not add a second
  downloader.

## Generated and release files

- `sidecar/dist/server.cjs` is generated but tracked because PoB's manifest and
  auto-update path ship it. Never hand-edit it; rebuild from TypeScript.
- Build the deterministic bundle before manifest generation.
- Run `python3 scripts/aipob.py check-manifest` after rebuilding the bundle.
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
