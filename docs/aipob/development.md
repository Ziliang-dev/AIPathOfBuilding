# Development Guide

AIPathOfBuilding spans the upstream Lua application and a local TypeScript
sidecar. Changes at the process boundary usually require updates and tests on
both sides.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/Classes/AIPlannerTab.lua` | Objective UI, candidate cards, Preview, Apply confirmation |
| `src/Modules/AIPoB/` | Capture, catalog, Lua RPC, scenarios, actions, sandbox, transaction, journal |
| `src/AIPoBWorker.lua` | Isolated PoB evaluation worker entry |
| `sidecar/src/rpc/` and `sidecar/src/protocol.ts` | Authenticated JSON-RPC transport and wire contract |
| `sidecar/src/workflow/` | LangGraph state, nodes, limits, and checkpoints |
| `sidecar/src/domain/` | Graph, coverage, scenarios, evidence, mechanic adapters |
| `sidecar/src/search/` | Proposal expansion, evaluation, constraints, Pareto selection, cache |
| `sidecar/src/llm/` and `sidecar/src/agent/` | Read-only model adapter and tool loop; not connected to current controller |
| `sidecar/src/storage/` | SQLite and memory planner stores |
| `spec/System/TestAIPoB*_spec.lua` | Lua integration and transaction tests |
| `sidecar/tests/` | TypeScript unit, integration, RPC, workflow, and worker tests |
| `scripts/` | PowerShell install, validation, build, manifest, and packaging entry points |

## Required reading

Before changing domain behavior, read:

- [Architecture](architecture.md)
- [Domain rules](domain-rules.md)
- the relevant [ADR](../index.md#architecture-decisions)
- [Status and roadmap](status-and-roadmap.md)

For inherited PoB internals, start with the upstream
[codebase rundown](../rundown.md), [modifier syntax](../modSyntax.md), and
[skill guide](../addingSkills.md).

## Sidecar workflow

From the repository root:

```powershell
./scripts/install-sidecar.ps1
./scripts/check-sidecar.ps1
./scripts/build-sidecar.ps1
./scripts/check-manifest.ps1
```

`check-sidecar.ps1` runs the configured lint/typecheck and Vitest scripts.
`build-sidecar.ps1` emits the release entry at `sidecar/dist/server.cjs`.
`check-manifest.ps1` generates a temporary manifest and verifies that the bundle
is the only sidecar auto-update file.

Direct commands:

```powershell
Set-Location -LiteralPath './sidecar'
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Lua tests

The upstream test suite uses Busted. Preferred reproducible path:

```powershell
docker compose up --abort-on-container-exit
```

With local LuaJIT and Busted:

```powershell
busted --lua=luajit
```

AIPoB coverage currently lives primarily in:

- `spec/System/TestAIPlannerTab_spec.lua`
- `spec/System/TestAIPoBCore_spec.lua`
- `spec/System/TestAIPoBRpc_spec.lua`

## Cross-language contract changes

When changing RPC methods, schemas, Scenarios, Build Actions, or Transaction
results:

1. Update the TypeScript Zod schema and protocol definitions.
2. Update Lua serialization, normalization, validation, and handlers.
3. Preserve or deliberately increment `SCHEMA_VERSION` and
   `PROTOCOL_VERSION`; never change an existing version's meaning silently.
4. Add TypeScript schema/RPC/controller tests.
5. Add Lua action, RPC, UI, or transaction tests.
6. Rebuild `sidecar/dist/server.cjs`.
7. Run the manifest check.
8. Update [Architecture](architecture.md), [Domain rules](domain-rules.md), and
   [Status and roadmap](status-and-roadmap.md) when behavior or coverage changes.

## Domain changes

A domain change should keep generation and evaluation separate:

- Catalog or mechanic adapters propose typed actions.
- Domain Graph edges explain availability and dependencies.
- Condition claims include explicit sources and trigger chains.
- Workers apply actions to a sandbox and ask PoB for metrics.
- Search filters constraints and ranks results; it does not invent metrics.
- The active build changes only through the Lua Transaction module.

New saved gameplay fields must be classified by the coverage registry. New
classification alone is not full search support; add the relevant adapter,
action application, evaluation tests, and status entry.

## PowerShell scripts

All project scripts target PowerShell Core. Use `-LiteralPath` for filesystem
paths, strict mode for non-trivial scripts, and explicit exit-code checks for
external tools. Syntax-check every changed `.ps1` before execution:

```powershell
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath './scripts/check-sidecar.ps1'), [ref]$tokens, [ref]$errors) | Out-Null
$errors
```

An empty `$errors` collection means parsing succeeded.

## Release artifacts

The deterministic bundle must exist before manifest generation:

```powershell
./scripts/install-sidecar.ps1
./scripts/check-sidecar.ps1
./scripts/build-sidecar.ps1
python update_manifest.py --in-place
```

`sidecar/dist/server.cjs` is tracked because it participates in PoB's manifest
and auto-update path. Do not hand-edit it. Rebuild it from TypeScript source.

Node.js and the native `better-sqlite3` runtime are installer-owned. Auto-update
may replace `server.cjs`; a Node major or native ABI change requires a new
installer or portable package.

For local Windows packaging:

```powershell
$env:AIPOB_NODE_EXE = 'C:\Tools\node-v24-win-x64\node.exe'
./scripts/package-windows.ps1
```

The packaging script refuses to overwrite existing output.

## Upstream synchronization

- Keep AIPoB changes isolated from unrelated upstream files when possible.
- Preserve upstream documentation under `docs/`; index it rather than renaming
  it without need.
- Resolve upstream calculator behavior against upstream tests before changing
  AIPoB adapters.
- After rebasing, update the Wiki baseline and review every capability marked
  Connected.
- Do not describe support for a new league mechanic until code, data, adapter,
  and golden-build coverage agree.

## Documentation maintenance

- Current behavior belongs in `docs/aipob/architecture.md` and domain pages.
- Target behavior belongs in `status-and-roadmap.md` or an ADR.
- One fact should have one authoritative page; other pages link to it.
- Update the baseline date and version only after verification.
- Keep local Markdown links relative so GitHub forks and local agents can follow
  them.
