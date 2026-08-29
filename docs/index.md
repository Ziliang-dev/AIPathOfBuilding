# AIPathOfBuilding Wiki

This directory is the versioned documentation home for AIPathOfBuilding (AIPoB).
It documents the current implementation separately from planned capabilities and
links to upstream sources instead of copying fast-changing Path of Exile data.

## Documentation baseline

| Item | Baseline |
| --- | --- |
| Last verified | 2026-08-29 |
| AIPoB working-tree base | `35eb12b444b135e6a991ba285cc648162a62e1c4` |
| Upstream PoB base | `ed354c2f8c42e148bc904c7508dbe851fb2cf952` |
| Path of Building release data | `v2.67.2` |
| Path of Exile data version | `3.29` |

The status baseline is descriptive, not a compatibility promise. Check
[Status and roadmap](aipob/status-and-roadmap.md) before describing a feature as
available.

## Choose a reading path

### Users

1. [Project overview](aipob/overview.md)
2. [Getting started](aipob/getting-started.md)
3. [Planner workflows](aipob/workflows.md)
4. [Troubleshooting](aipob/troubleshooting.md)

The current branch is an implementation baseline, not a published release.
The getting-started guide separates connected behavior, remaining breadth, and
Windows CI release gates.

### Maintainers

1. [Architecture](aipob/architecture.md)
2. [Core concepts](aipob/core-concepts.md)
3. [Domain rules](aipob/domain-rules.md)
4. [Development guide](aipob/development.md)
5. [Architecture decisions](#architecture-decisions)
6. [Status and roadmap](aipob/status-and-roadmap.md)

### Development agents

Read the repository [AGENTS.md](../AGENTS.md) first. For domain changes, the
minimum context is:

1. [Architecture](aipob/architecture.md)
2. [Domain rules](aipob/domain-rules.md)
3. The relevant file under [Architecture decisions](#architecture-decisions)
4. [Status and roadmap](aipob/status-and-roadmap.md)

## AIPoB documentation

| Page | Purpose |
| --- | --- |
| [Overview](aipob/overview.md) | Product goal, users, boundaries, and relationship to PoB |
| [Getting started](aipob/getting-started.md) | Requirements, development baseline, planner usage, and packaging |
| [Architecture](aipob/architecture.md) | Current processes, modules, data flow, RPC, persistence, and security |
| [Core concepts](aipob/core-concepts.md) | Canonical domain language |
| [Workflows](aipob/workflows.md) | User and runtime flows from capture through verified apply |
| [Domain rules](aipob/domain-rules.md) | Evaluation, scenario, candidate, ranking, and transaction policies |
| [Development](aipob/development.md) | Code map, commands, cross-language changes, and release artifacts |
| [Troubleshooting](aipob/troubleshooting.md) | Failure symptoms, checks, and recovery actions |
| [Status and roadmap](aipob/status-and-roadmap.md) | Connected, partial, missing, and excluded capabilities |
| [Reference sources](reference-sources.md) | Source precedence, versioning policy, and external references |

## Architecture decisions

- [ADR 0001: Keep Path of Building authoritative behind a hybrid graph architecture](adr/0001-aipob-hybrid-graph-architecture.md)
- [ADR 0002: Require a human-gated transaction for every Build change](adr/0002-aipob-human-gated-transactions.md)
- [ADR 0003: Bind brokers, native proof, and provider consent to protocol v2](adr/0003-aipob-protocol-v2-broker-consent-boundary.md)
- [ADR 0004: Authorize provider connection probes without granting data consent](adr/0004-provider-connection-probe.md)
- [ADR 0005: Resolve provider compatibility before saving and hide the packaged sidecar](adr/0005-provider-compatibility-and-hidden-sidecar.md)

## Upstream Path of Building developer references

These documents came from the Path of Building Community repository. They are
useful implementation references, but they do not define AIPoB status.

- [Codebase rundown](rundown.md)
- [Adding modifiers](addingMods.md)
- [Modifier syntax](modSyntax.md)
- [Adding skills](addingSkills.md)
- [Offence calculation notes](calcOffence.md)
- [PoB built-in help](../help.txt)
- [Upstream contribution guide](../CONTRIBUTING.md)

## Documentation policy

- Current behavior must be supported by code or tests in this repository.
- Planned behavior belongs in the roadmap or an ADR, not the current
  architecture page.
- Version-sensitive game facts must name their applicable PoE version.
- Prefer links to official Path of Exile sources and PoE Wiki pages over copied
  values or item lists.
- When behavior changes, update the relevant page and the status matrix in the
  same change.

Future standalone PoB and PoE reference material can be added under
`docs/pob/` and `docs/poe/`. The `docs/aipob/` paths are intended to remain
stable.
