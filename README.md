# AIPathOfBuilding

AIPathOfBuilding (AIPoB) adds a local, graph-based build optimizer to the Path
of Building Community fork. Path of Building's Lua engine remains authoritative
for build state, game data, and calculated metrics. A TypeScript sidecar manages
the resumable search workflow and communicates with PoB through authenticated
loopback JSON-RPC.

> [!IMPORTANT]
> This branch is an implementation baseline, not a published release. The six
> completion packages below are connected; Windows portable/NSIS and real-PoB
> process gates must still pass in CI for a release artifact. Check the
> [capability matrix](docs/aipob/status-and-roadmap.md) before relying on a
> feature.

## Implementation status

This section is a short project summary. The authoritative, release-baselined
matrix is [Status and roadmap](docs/aipob/status-and-roadmap.md).

### Connected

- Structured Objectives with goals, Scenario weights, Budget, Locks, hard
  constraints, candidate-source controls, and explicit confirmation
- Immutable Build capture with XML serialization, gameplay-field coverage,
  engine/content versions, baseline metrics, and fingerprint validation
- Current diagnostic plus Mapping, Standard Boss, Guardian/Pinnacle, and Uber
  Pinnacle Scenarios, each with Sustainable and Peak profiles
- Typed Condition Evidence core with trigger legality, uptime threshold,
  conflicts, and bounded variants
- Deterministic search over typed proposals exported by the current PoB Build
- Isolated PoB worker evaluation, hard-constraint checking, Pareto filtering,
  and Offence, Balanced, and Defence candidate views
- Non-mutating Candidate Preview
- Human-approved Transactional Apply with fresh verification, dependency
  ordering, rollback, and recovery journal
- Authenticated loopback JSON-RPC, cancellation, persistent workflow
  checkpoints, reconnect/resume support, structured failure handling, and
  bidirectional protocol-v2 Trade requests
- PoB-native link compatibility probes plus candidate/scenario-bound Condition
  Evidence, uptime, and proof fingerprints
- Player, minion, spectre, Animate Guardian, party, Bloodline, Pact, advanced
  passive, and seasonal equipment adapters for `3_29` and `3_29_ruthless`
- Dynamic, Budget-bound Trade/catalog queries in the authenticated PoB process;
  seller/account data stays there, while the sidecar receives sanitized typed
  catalog items and emits fingerprint-bound `importAndEquip` actions
- OpenAI-compatible provider configuration with API keys stored only under the
  `AIPathOfBuilding/LLM/*` Windows Credential Manager namespace, explicit
  revocable first-send consent, ephemeral Planner Chat, and workflow model
  injection with deterministic fallback
- Versioned Golden corpus and release gate covering both 3.29 rulesets,
  mechanic adapters, graph nodes, candidate actions, metrics, and all AIPoB Lua
  specs
- Deterministic bundle/manifest ordering; full PoB portable and canonical NSIS
  packaging pinned to Node `24.20.0` x64 / ABI `137`; apply, reject, failure,
  restart, and real-PoB worker E2E jobs

### Partially implemented

| Capability | Implemented | Still missing |
| --- | --- | --- |
| Unique and target-Rare candidates | Objective fields, UI controls, source policy, typed catalog actions, costs, and search adapters | Main-process external proposal catalog |
| Workflow refinement | Conditional graph, bounded refinement pass, recursion limits, and convergence limits | Richer runtime refinement policy and multi-round strategy |
| Skill optimization | Native compatibility matrix and proof barrier for every proposed link Candidate | Broader complete-link candidate generation across the full gem catalog |
| Item and passive optimization | Dynamic Trade items, seasonal equipment, existing item swaps, passive paths, masteries, secondary ascendancy, overrides, and point checks | Cross-slot enabling packages and broader cluster/anoint generation |
| Golden corpus breadth | Standard and Ruthless representative Builds plus actor/season projections, candidates, graph nodes, and four Sustainable Scenarios | More archetypes, loadouts, trigger/rotation, and negative/conflict regression cases |
| Progression planning | Progression DAG primitives and action type | End-to-end level/Budget milestones and Planner presentation |
| Release operation | Canonical portable/NSIS scripts and Windows CI gates | Code signing, publication, and proof from a successful release workflow run |

### Remaining roadmap

- Main-process proposal catalogs for non-Trade Unique and target-Rare sources.
- Broader full-catalog skill-link and passive candidate generation.
- More Golden Builds for trigger/rotation, loadout, negative, and conflict
  cases.
- Complete cross-domain enabling packages and affected-domain regeneration.
- End-to-end progression milestone planning.
- Published, signed Windows artifacts after the configured CI gates pass.

## Requirements

- WSL2 Ubuntu with Bash and Python 3.10+
- Node.js 24.20.0 x64 for the release-compatible development path
- pnpm 11.19.0
- Docker or local LuaJIT/Busted for PoB tests

GitHub Actions supplies Docker/Busted, MSVC, NSIS, Python, and the exact Windows
Node runtime for release gates. Local installation of those packaging tools is
optional.

The repository never downloads or commits a Node executable. API keys, OAuth
tokens, SQLite data, logs, `.env` files, and local credentials must not enter
source control.

## Development quick start

Run from the repository root:

```bash
python3 scripts/aipob.py install-sidecar
python3 scripts/aipob.py check-sidecar
python3 scripts/aipob.py build-sidecar
python3 scripts/aipob.py check-manifest
python3 scripts/aipob.py release-gate
```

Launch the checked-out PoB development runtime, open a Build, and select
**AI Build Planner**. The sidecar starts lazily when a confirmed search begins.
Without a configured and consented provider, the CLI uses deterministic
fallback. Provider keys are never loaded from a project file or `.env`.

Detailed setup and current UI behavior: [Getting started](docs/aipob/getting-started.md).

## Wiki

[`docs/index.md`](docs/index.md) is the versioned Wiki home.

- Users: [Overview](docs/aipob/overview.md) → [Getting started](docs/aipob/getting-started.md) → [Workflows](docs/aipob/workflows.md)
- Maintainers: [Architecture](docs/aipob/architecture.md) → [Domain rules](docs/aipob/domain-rules.md) → [Development](docs/aipob/development.md)
- Development agents: read [`AGENTS.md`](AGENTS.md), the current architecture,
  domain rules, and relevant ADRs before changing domain behavior

## Windows packages

Supply Node.js 24.20.0 x64. The portable packaging script validates the version,
architecture, ABI, native SQLite binding, WinCred helper, manifest, and hashes:

```bash
python3 scripts/aipob.py package-windows \
  --node-exe /mnt/c/Tools/node-v24-win-x64/node.exe
```

Default output:

```text
artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

Node and the `better-sqlite3` native module are installer-owned. A Node major or
native ABI change requires a new installer or portable package.

Build the canonical NSIS installer from that verified ZIP:

```bash
python3 scripts/aipob.py package-installer-windows \
  --package artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip \
  --output artifacts/AIPathOfBuilding-AIPoB-Setup.exe
python3 scripts/aipob.py verify-installer-windows \
  --installer artifacts/AIPathOfBuilding-AIPoB-Setup.exe \
  --package artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

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
