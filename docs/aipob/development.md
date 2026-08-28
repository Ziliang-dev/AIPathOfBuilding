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
| `sidecar/src/llm/`, `sidecar/src/agent/`, and `sidecar/src/provider/` | Read-only model adapter, consent gate, Planner Chat drafting, and controller injection |
| `sidecar/src/trade/` | Sanitized Trade catalog contract and bounded search broker |
| `sidecar/src/credentials/` and `native/wincred-helper/` | LLM-only Windows Credential Manager client and native helper |
| `sidecar/src/domain/nativeProbe.ts` and `sidecar/src/worker/nativeProbeWorkerPool.ts` | Native compatibility/evidence proof barrier |
| `sidecar/src/domain/actor-season.ts` | Actor, passive override, and season projections |
| `sidecar/src/storage/` | SQLite and memory planner stores |
| `spec/System/TestAIPoB*_spec.lua` | Lua integration and transaction tests |
| `sidecar/tests/` | TypeScript unit, integration, RPC, workflow, and worker tests |
| `spec/AIPoBGolden/` | Versioned Standard and Ruthless release corpus |
| `scripts/` and `installer/` | Validation, release gate, canonical Windows package, NSIS, and E2E entry points |

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
- `spec/System/TestAIPoBTradeBroker_spec.lua`
- `spec/System/TestAIPoBNativeProbe_spec.lua`
- `spec/System/TestAIPoBActorSeason_spec.lua`
- `spec/System/TestAIPoBGolden_spec.lua`

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
./scripts/check-manifest.ps1
./scripts/release-gate.ps1
```

`sidecar/dist/server.cjs` is tracked because it participates in PoB's manifest
and auto-update path. Do not hand-edit it. Rebuild it from TypeScript source.

Node.js and the native `better-sqlite3` runtime are installer-owned. Auto-update
may replace `server.cjs`; a Node major or native ABI change requires a new
installer or portable package.

For local Windows packaging, supply exact Node.js 24.20.0 x64 / ABI 137:

```powershell
$env:AIPOB_NODE_EXE = 'C:\Tools\node-v24-win-x64\node.exe'
./scripts/package-windows.ps1
```

The packaging script refuses to overwrite existing output.

The portable ZIP is the canonical staging input for NSIS:

```powershell
./scripts/verify-package-windows.ps1 `
  -PackagePath artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
./scripts/package-installer-windows.ps1 `
  -PackagePath artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip `
  -OutputPath artifacts/AIPathOfBuilding-AIPoB-Setup.exe
./scripts/verify-installer-windows.ps1 `
  -InstallerPath artifacts/AIPathOfBuilding-AIPoB-Setup.exe `
  -PackagePath artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

`e2e-windows.ps1` covers Apply, Reject, injected failure/rollback, restart, and
an optional real packaged-PoB worker path. CI must prove the exact Windows
runtime, native helper, NSIS silent install, and real process-level E2E before
publication. Code signing and publication remain release operations.

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
