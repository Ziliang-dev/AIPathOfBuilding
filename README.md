# AIPathOfBuilding

AIPathOfBuilding (AIPoB) adds a local, graph-based build optimizer to the Path
of Building Community fork. Path of Building's Lua engine remains authoritative
for build state, game data, and calculated metrics. A TypeScript sidecar manages
the resumable search workflow and communicates with PoB through authenticated
loopback JSON-RPC.

> [!IMPORTANT]
> This branch is an implementation baseline, not a release candidate. Trade,
> live model-provider configuration, conversational objective drafting, and
> several full-domain adapters are not connected. Check the
> [capability matrix](docs/aipob/status-and-roadmap.md) before relying on a
> feature.

## What works now

- Structured and explicitly confirmed optimization objectives
- Immutable Build capture and fingerprint validation
- Current diagnostic, Mapping, Standard Boss, Guardian/Pinnacle, and Uber
  Pinnacle evaluation contexts
- Sustainable and Peak profiles with typed Condition Evidence
- Deterministic search over typed proposals exported by the current PoB build
- PoB worker-process evaluation, hard constraints, Pareto filtering, and three
  candidate views
- Non-mutating Preview
- Human-approved, transactional Apply with fresh verification, rollback, and a
  recovery journal
- Authenticated loopback RPC, persistent workflow checkpoints, and Windows
  packaging scripts

## Requirements

- PowerShell Core 7
- Node.js 22.13 or newer for development
- pnpm 11.19.0
- Docker or local LuaJIT/Busted for PoB tests
- A locally supplied Node.js 24 x64 executable for portable Windows packaging

The repository never downloads or commits a Node executable. API keys, OAuth
tokens, SQLite data, logs, `.env` files, and local credentials must not enter
source control.

## Development quick start

Run from the repository root:

```powershell
./scripts/install-sidecar.ps1
./scripts/check-sidecar.ps1
./scripts/build-sidecar.ps1
./scripts/check-manifest.ps1
```

Launch the checked-out PoB development runtime, open a Build, and select
**AI Build Planner**. The sidecar starts lazily when a confirmed search begins.
The current CLI uses deterministic fallback; it does not load a plaintext API
key or enable a model provider.

Detailed setup and current UI behavior: [Getting started](docs/aipob/getting-started.md).

## Wiki

[`docs/index.md`](docs/index.md) is the versioned Wiki home.

- Users: [Overview](docs/aipob/overview.md) → [Getting started](docs/aipob/getting-started.md) → [Workflows](docs/aipob/workflows.md)
- Maintainers: [Architecture](docs/aipob/architecture.md) → [Domain rules](docs/aipob/domain-rules.md) → [Development](docs/aipob/development.md)
- Development agents: read [`AGENTS.md`](AGENTS.md), the current architecture,
  domain rules, and relevant ADRs before changing domain behavior

## Portable Windows package

Supply a Node.js 24 x64 executable. The packaging script validates it and
refuses to overwrite existing output:

```powershell
$env:AIPOB_NODE_EXE = 'C:\Tools\node-v24-win-x64\node.exe'
./scripts/package-windows.ps1
```

Default output:

```text
artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

Node and the `better-sqlite3` native module are installer-owned. A Node major or
native ABI change requires a new installer or portable package.

## Current limitations

- Authenticated PoB Trade/catalog brokerage is not connected and fails closed.
- Unique and target-Rare source controls normally receive no external proposals.
- Windows Credential Manager, first-send provider consent, provider injection,
  and Planner Chat are not connected.
- Full ruleset conversion, complete link search, native condition-source proof,
  specialized actors, seasonal mechanics, and golden-build coverage remain
  release gates.
- Existing upstream release automation does not yet guarantee sidecar
  build-before-manifest ordering.

See [Status and roadmap](docs/aipob/status-and-roadmap.md) for precise boundaries.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for upstream PoB contribution practices
and [AIPoB development](docs/aipob/development.md) for the cross-language
workflow, tests, generated bundle, manifest, and packaging rules.

## Upstream Path of Building

This project is based on
[Path of Building Community](https://github.com/PathOfBuildingCommunity/PathOfBuilding),
the offline build planner for Path of Exile. Upstream PoB provides the
calculator, build format, game data, item/skill/tree planners, import/export,
Trade integration, and application runtime. AIPoB does not replace those
systems.

Upstream developer documentation is preserved and indexed from the
[Wiki home](docs/index.md#upstream-path-of-building-developer-references).

## Licence

[MIT](https://opensource.org/licenses/MIT). See [LICENSE.md](LICENSE.md) for PoB
and third-party licensing information; it is part of the documentation.
