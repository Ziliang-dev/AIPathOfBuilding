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

```bash
python3 scripts/aipob.py install-sidecar
python3 scripts/aipob.py check-sidecar
python3 scripts/aipob.py build-sidecar
python3 scripts/aipob.py check-manifest
```

`check-sidecar` runs the configured lint/typecheck and Vitest scripts.
`build-sidecar` emits the release entry at `sidecar/dist/server.cjs`.
`check-manifest` generates a temporary manifest and verifies that the bundle is
the only sidecar auto-update file.

Direct commands:

```bash
cd sidecar
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Lua tests

The upstream test suite uses Busted. Preferred reproducible path:

```bash
docker compose up --abort-on-container-exit
```

With local LuaJIT and Busted:

```bash
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

## Command scripts

Repository commands use Python 3.10+ and run from WSL2 Ubuntu. They check
external command exit codes and use standard-library filesystem APIs. Syntax
check every changed command module before execution:

```bash
python3 -m py_compile \
  scripts/aipob.py \
  scripts/ci_sync.py \
  scripts/windows_package.py \
  scripts/windows_e2e.py
python3 -m unittest discover -s tests -p "test_ci_sync.py"
```

## Release artifacts

The deterministic bundle must exist before manifest generation:

```bash
python3 scripts/aipob.py install-sidecar
python3 scripts/aipob.py check-sidecar
python3 scripts/aipob.py build-sidecar
python3 scripts/aipob.py check-manifest
python3 scripts/aipob.py release-gate
```

`sidecar/dist/server.cjs` is tracked because it participates in PoB's manifest
and auto-update path. Do not hand-edit it. Rebuild it from TypeScript source.

Node.js and the native `better-sqlite3` runtime are installer-owned. Auto-update
may replace `server.cjs`; a Node major or native ABI change requires a new
installer or portable package.

GitHub Actions supplies the exact Node.js 24.20.0 x64 / ABI 137, MSVC, and NSIS
toolchain. A manual WSL packaging run may point at a Windows Node executable:

```bash
python3 scripts/aipob.py package-windows \
  --node-exe /mnt/c/Tools/node-v24-win-x64/node.exe
```

The packaging script refuses to overwrite existing output.

For the current branch's latest successful portable, use the idempotent local
synchronizer instead of manually selecting and downloading an Actions run:

```bash
python3 scripts/aipob.py sync-ci-windows
```

The command queries structured `gh run list` output, downloads the canonical
portable by run ID, converts WSL paths before invoking Windows executables,
performs the full package verifier, and replaces only the managed
`artifacts/ci-latest` directory. A verified update blocked by an open Windows
process is retained at `artifacts/ci-pending` for the next invocation.

The portable ZIP is the canonical staging input for NSIS:

```bash
python3 scripts/aipob.py verify-package-windows \
  --package artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
python3 scripts/aipob.py package-installer-windows \
  --package artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip \
  --output artifacts/AIPathOfBuilding-AIPoB-Setup.exe
python3 scripts/aipob.py verify-installer-windows \
  --installer artifacts/AIPathOfBuilding-AIPoB-Setup.exe \
  --package artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

`python scripts/aipob.py e2e-windows` covers Apply, Reject, injected
failure/rollback, restart, and an optional real packaged-PoB worker path. CI
must prove the exact Windows runtime, native helper, NSIS silent install, and
real process-level E2E before publication. Code signing and publication remain
release operations.

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
