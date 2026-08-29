# Status and Roadmap

This page is the authoritative capability statement for the current working
tree. Architecture pages describe connected behavior. Planned breadth stays
here.

Working-tree baseline verified 2026-08-29 atop AIPoB commit
`8b0b5fe015036398a18d8e5651d69faf6aab9d94`, upstream PoB base
`ed354c2f8c42e148bc904c7508dbe851fb2cf952`, PoB release data `v2.67.2`, and
PoE data versions `3.29` / `3.29 Ruthless`. Replace the AIPoB hash with the merge
commit before publishing a release.

## Status meanings

- **Connected:** reachable through the PoB Planner and production sidecar path,
  with typed contracts and tests.
- **Partial:** a safe production seam exists, but candidate or regression breadth
  is intentionally incomplete.
- **CI-gated:** implementation is connected, but the exact Windows toolchain or
  artifact proof must run in CI.
- **Out of scope:** deliberately excluded from the product contract.

## Connected

| Capability | Current evidence and boundary |
| --- | --- |
| Planner objective UI | Goals, Scenario weights, hard constraints, Budget, Locks, candidate sources, exact Trade realm/league, and per-run confirmation are wired in `AIPlannerTab.lua` |
| Protocol v2 | Schema/protocol version 2, authenticated bidirectional loopback JSON-RPC, cancellation, timeouts, notifications, reverse Trade requests, and checkpoint reconnect are aligned across TypeScript and Lua |
| Build capture and coverage | Sanitized XML, fingerprint, versions, metrics, config, gameplay paths, typed catalog, and graph validation cross the boundary; rollback XML remains local to the Transaction path |
| Scenario and Condition Evidence | Current diagnostic plus four Sustainable and four Peak Scenarios, generic resolver rules, native source/uptime probes, conflict handling, and Candidate/Scenario proof fingerprints are connected |
| Native link compatibility | Every proposed link Candidate is probed through PoB's native skill/support matrix; incomplete proof, unsupported gems, disabled/over-capacity links, stale Candidate fingerprints, and Apply-time proof drift fail closed |
| Actor and 3.29 season adapters | Player, minion, spectre, Animate Guardian, party, Bloodline, Pact, timeless/override/tattoo/runegraft, Graft, Tincture, and Foulborn projections are version-gated for `3_29` and `3_29_ruthless` |
| Dynamic Trade/catalog broker | Search issues bounded typed constraints; the PoB process owns query JSON, OAuth, rate limiting, currency conversion, Budget enforcement, and seller data; the sidecar receives sanitized items and creates fingerprint-bound `importAndEquip` actions |
| Trade degradation | Timeout, upstream failure, rate limit, or unavailable broker becomes a warning; deterministic local search continues without mutating the active Build |
| Credential Manager | The OpenAI-compatible API key is stored only under `AIPathOfBuilding/LLM/<providerId>` through the WinCred helper; non-LLM targets are rejected; PoE OAuth is untouched |
| Provider connection test | `providerConnectionTest` negotiates additive preview/test RPC; LLM Setup starts the sidecar, one-shot consent binds a fixed synthetic forced-tool-call probe, unsaved fields remain non-durable, and Configure is gated on an exact successful result |
| Provider consent | First-send preview binds endpoint, model, categories, privacy/redaction policy, and redacted payload hash; consent is persisted, revocable, and checked before provider calls |
| Planner Chat and model injection | Ephemeral Chat produces a strict Objective Draft, unresolved metrics block use, UI review resets confirmation, and the consent-gated adapter is injected into PlanSearch/RefineSearch/Explain with deterministic fallback |
| Search and Transaction | Worker isolation, Locks, Budget, hard constraints, Pareto selection, non-mutating Preview, fresh Apply verification, explicit approval, dependency ordering, native re-proof, rollback, and recovery journal are connected |
| Golden corpus and release harness | Corpus schema v2 covers Standard and Ruthless XML Builds, actor/season projections, five required adapters, required graph nodes, four typed action kinds, baseline/four Sustainable Scenario metrics, field policy, and Candidate fingerprints |
| Canonical Windows packaging | Portable and repository-owned NSIS paths consume one verified staging tree with Node `24.20.0` x64 / ABI `137`, `better-sqlite3`, WinCred helper, PoB runtime, exact sidecar bundle, metadata, checksums, and a package-local exact-branch `win32` manifest; the updater resolves repository-style `src`, runtime, package-root, and staging paths without entering Dev Mode or misplacing files |
| Latest CI portable synchronization | The WSL Python CLI selects the current branch's latest successful Actions run, downloads and fully verifies its canonical portable once, then safely retains only the managed latest copy or one lock-blocked pending replacement |
| Fault and process E2E definitions | Windows jobs cover apply, reject, injected transaction failure, checkpoint restart, silent NSIS install, and a real packaged PoB worker process; no pixel UI automation is used |

## Partial

| Capability | Implemented portion | Remaining breadth |
| --- | --- | --- |
| Unique and target-Rare sources | Objective/UI policy, typed actions, costs, and deterministic adapters | Main-process non-Trade proposal catalog |
| Skill optimization | Native compatibility and evidence barrier for every proposed link change | Broad full-gem complete-link generation and larger beam policy |
| Passive optimization | Nodes, masteries, paths, point budgets, secondary ascendancy, timeless and native overrides | Broader cluster/anoint and cross-domain enabling packages |
| Actor/season breadth | Reviewed 3.29/3.29 Ruthless projections and adapters | Future rulesets and additional mechanic-specific adapters require new version gates and corpus cases |
| Golden Build breadth | Two rulesets, representative actor/season mechanics, action kinds, graph nodes, and Sustainable metric replay | More archetypes, loadouts, trigger/rotation, negative/conflict, and historical regression Builds |
| Workflow refinement | One bounded refinement pass, recursion and convergence limits | Richer multi-round strategy and model/deterministic refinement policies |
| Progression planning | Progression DAG primitives and typed action | End-to-end level/Budget milestones and Planner presentation |
| Operational release | Build-before-manifest, canonical bundle, portable, NSIS, verifier, E2E workflows, and a successful full release-gate run | Code signing, publication, and merged release commit |

## Verification evidence

Local WSL checks completed on 2026-08-29:

- sidecar typecheck, release build, and `23` Vitest files / `179` tests;
- `python3 scripts/aipob.py check-sidecar`;
- `python3 scripts/aipob.py check-manifest`;
- Python bytecode compilation for all command modules;
- `sync-ci-windows` unit tests cover Windows-CLI symlinks, directory-watcher
  promotion, locked-content rollback, and idempotence; successful Actions run
  `33257674043` was downloaded, fully verified, and promoted while the managed
  directory had a live watcher handle;
- YAML parse for all workflows; and
- syntax parse for the changed AIPoB Lua modules and specs; and
- two independent real PoB worker processes produced the same canonical
  Candidate fingerprint for the same Build and typed action.

GitHub Actions supplied Docker/Busted, MSVC, NSIS, Python, and exact Node
`24.20.0` without requiring local installation. Final CI evidence:

- [AIPoB release gate run](https://github.com/Ziliang-dev/AIPathOfBuilding/actions/runs/33257674043): Node `24.20.0`, Golden corpus/Busted, canonical bundle,
  WinCred/MSVC, portable package verification, Apply/Reject/Fail/Restart E2E,
  real packaged PoB-process E2E, NSIS build/silent-install verification, and
  aggregate release gate all passed;
- [upstream Lua/runtime tests](https://github.com/Ziliang-dev/AIPathOfBuilding/actions/runs/33257674039) passed; and
- [spell check](https://github.com/Ziliang-dev/AIPathOfBuilding/actions/runs/33257674040) passed.

`python3 scripts/aipob.py release-gate` and `.github/workflows/aipob.yml` define those gates.
A release must not be published if any gate is skipped or fails.

## Release gates

1. Schema/protocol v2 types, Lua validation, RPC methods, and tests remain
   aligned.
2. Each claimed gameplay field has a coverage policy, candidate behavior or an
   explicit non-searchable policy, Lua application support, and corpus evidence.
3. Native link/evidence probes are complete and fingerprint-bound for every
   evaluated Candidate and ranked Sustainable Scenario.
4. Trade stays main-process authenticated, rate-limited, Budget-bound, typed,
   and privacy-preserving; failure remains degradable.
5. Provider keys use only the LLM WinCred namespace; the fixed connection probe
   is one-shot and non-durable; first-send consent and redaction run before any
   Build/chat provider call; fallback works without a provider.
6. All four Sustainable Scenarios reproduce metrics before and after an
   accepted Transaction, and native proof survives commit re-probe.
7. Cancellation, worker failure, transaction failure, rollback, restart,
   journal reconciliation, and package smoke tests pass.
8. Portable and NSIS artifacts consume the same canonical Node/native/bundle
   staging, and release automation builds the bundle before manifest generation.
9. README, Wiki, ADRs, and the release commit hash match the artifact being
   published.

## Out of scope

- Stash, guild stash, character inventory, or rucksack access
- Atlas tree, mapping-profit, or farming-strategy optimization
- Probabilistic crafting simulation
- Automated purchase, seller contact, or trade-site actions
- Game input, pixel automation, or account writes
- Migrating or exposing PoE OAuth credentials
- New OAuth scopes or undocumented external interfaces
- Treating model output as authoritative PoE calculation

## Expansion path

Future PoE versions require new adapter version ranges and Golden corpus cases.
A standalone reference layer may later add:

```text
docs/pob/  # inherited PoB architecture, calculator, formats, and extension guides
docs/poe/  # versioned mechanic summaries and source maps
```

Follow [Reference sources](../reference-sources.md), avoid volatile copied data,
and keep existing `docs/aipob/` links stable.
