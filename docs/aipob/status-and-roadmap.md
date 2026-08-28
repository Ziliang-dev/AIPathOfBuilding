# Status and Roadmap

This page is the authoritative capability statement for the current branch.
Architecture pages describe only connected behavior; this page records partial
and target work.

Baseline verified 2026-08-28 against AIPoB commit
`e2fe9d736c114a740004c1951a8686dffaa6dda4`, upstream PoB base
`ed354c2f8c42e148bc904c7508dbe851fb2cf952`, PoB release data `v2.67.2`, and PoE
data version `3.29`.

## Status meanings

- **Connected:** reachable through the current PoB Planner and production
  sidecar path, with tests.
- **Partial:** implementation or types exist, but coverage or runtime wiring is
  incomplete.
- **Not connected:** planned interface may exist, but current runtime cannot use
  it.
- **Out of scope:** deliberately excluded from the product contract.

## Connected

| Capability | Current evidence and boundary |
| --- | --- |
| Planner objective UI | Presets, goal text, two structured survival floors, primary Scenario, Budget, source toggles, default Locks, and explicit confirmation are wired in `AIPlannerTab.lua` |
| Authenticated local RPC | Versioned JSON-RPC 2.0 over loopback NDJSON, per-launch token, frame limits, timeouts, cancellation, notifications, and ready-file launch are connected |
| Build capture | XML, fingerprint, versions, baseline metrics, config, gameplay paths, and the exported current-build catalog cross the validated snapshot boundary; the schema accepts an optional prebuilt graph, but current Lua does not supply one |
| Coverage audit | Capture rejects missing/unclassified required gameplay field paths instead of silently accepting unknown coverage |
| Standard Scenario set | Current diagnostic plus four Sustainable and four Peak Scenarios are generated; Apply requires the four Sustainable Scenarios |
| Domain Graph validation | Canonical relations, node/edge validation, catalog import, and default mechanic adapter application are connected |
| Condition Evidence core | Typed sources, trigger legality, 90% Sustainable threshold, Peak/intermittent/manual/impossible/conflict states, and variants are implemented |
| Deterministic current-build search | Current exported content proposals and a zero-action baseline are evaluated without a model provider |
| Worker isolation | PoB worker processes evaluate immutable action/scenario batches independently of the active UI Build |
| Constraints and Pareto selection | Budget, Locks, hard constraints, dominance filtering, and up to three labelled selections are connected |
| Non-mutating Preview | Persisted Candidate actions, costs, metrics, Peak metrics, and evidence are returned without invoking the active-build Transaction; fresh evaluation occurs before Apply |
| Human-gated Transaction | Explicit Apply confirmation, fresh sidecar verification, Lua preflight, dependency ordering, commit verification, rollback, and transaction journal are connected |
| Checkpoint resume | Nonterminal workflows use persistent SQLite LangGraph checkpoints and can reconnect through stream/resume methods |
| Sidecar validation and build | Strict TypeScript, Vitest, bundle generation, PowerShell syntax checks, and manifest verification are scripted and run in CI |
| Windows portable packaging | Packaging validates supplied Node 24 x64, assembles native SQLite dependencies, hashes output, and refuses overwrite |

## Partial

| Capability | Implemented portion | Missing before complete |
| --- | --- | --- |
| Unique and target-Rare candidates | Objective schema, UI controls, source policy, typed catalog actions, costs, and search adapters exist | Main PoB process does not provide an authenticated external proposal catalog, so the controls normally fall back with a warning |
| Model-guided search | OpenAI-compatible adapter, redaction, seven read-only high-level tools, tool schemas, loop limits, and tests exist | Credential retrieval, first-send consent, provider configuration, controller injection, and user-visible model state are absent |
| Objective drafting | Objective Draft schema and free-text fields exist | Planner Chat and conversion of free-text notes into confirmed structured constraints are absent |
| Workflow refinement | Conditional refinement graph, recursion/convergence limits, and nodes exist | Connected controller verification currently sets `needsRefinement=false`, so runtime performs one search pass |
| Domain coverage | Saved fields are classified and nine domain families have adapter seams | Classification is broader than candidate-generation depth; ruleset conversion, actors, seasonal mechanics, and some cross-domain packages need specialized adapters |
| Condition proof | Generic source, trigger, resource, uptime, and conflict resolver is connected | Complete native source extraction and uptime proof for every PoE mechanic is not available |
| Skill optimization | Existing group/support catalog proposals and typed link replacement exist | Full compatibility filtering and complete-link beam search are not release complete |
| Item optimization | Existing item actions, per-source costs, Unique/target-Rare types, and item action application exist | External catalog broker, cross-slot enabling packages, and broad target-Rare generation are incomplete |
| Passive optimization | Existing node/mastery actions, path validity, point budgets, and catalog proposals exist | Complete connected path/cluster/timeless/tattoo/runegraft/anoint generation and golden coverage are incomplete |
| Progression planning | Progression DAG primitives and action type exist | End-to-end level/budget milestone generation and Planner presentation are not connected |
| Persistence | Run/snapshot/cache store uses SQLite with memory fallback; workflow checkpoints require SQLite | Retention, audit presentation, cache sizing, and user controls are not release complete |
| Release automation | Sidecar build and Windows artifact workflow exist | Upstream beta/release workflows do not yet guarantee sidecar build-before-manifest or installer ownership of Node/native ABI |

### Implemented model surface, not runtime-connected

The partial model layer exposes only seven schema-validated, read-only
high-level tools:

- `inspect_build`
- `diagnose_build`
- `search_build`
- `refine_search`
- `evaluate_candidate`
- `explain_candidate`
- `plan_progression`

The adapter includes provider fallback, request/tool-call limits, and redaction
tests. This does not make the Planner model-enabled: the production CLI reports
`providerConfigured=false`, and credentials, consent, provider injection, and
chat drafting remain absent.

## Not connected

| Capability | Required work |
| --- | --- |
| Authenticated PoB Trade broker | Keep OAuth and rate limiter in the main process, normalize typed results, enforce Budget, and expose no seller identity or credential across RPC |
| Windows Credential Manager | Add credential storage/retrieval UI and tests; never accept plaintext project files or environment-variable keys as the release path |
| First-send provider consent | Show exactly what Build data leaves the machine, persist a revocable decision, and run redaction before every request |
| Planner Chat | Draft objectives and constraint fields without allowing chat text to become an unvalidated Build Action |
| Provider injection | Connect configured model adapter to controller search while retaining deterministic fallback and tool-call limits |
| Full-domain release gate | Coverage manifest, specialized adapters, version compatibility, and representative golden builds must pass for every claimed domain |
| Complete cross-domain search | Build-enabling action packages, affected-domain regeneration, and compatibility-preserving shared beam search need production integration |

## Out of scope

- Stash, guild stash, character inventory, or rucksack access
- Atlas tree, mapping-profit, or farming-strategy optimization
- Probabilistic crafting simulation
- Automated purchase, seller contact, or trade-site actions
- Game input, automation, or account writes
- New OAuth scopes or undocumented external interfaces
- Treating model output as authoritative PoE calculation

## Release gates

Do not call this branch full-domain or release-complete until all applicable
gates pass:

1. Every claimed saved gameplay field has classification, candidate-generation
   behavior or an explicit non-searchable policy, Lua application support, and
   tests.
2. Representative golden builds cover player, minion, party, loadout,
   trigger/rotation, and current seasonal mechanics.
3. Trade remains main-process authenticated, rate-limited, Budget-bound, and
   privacy-preserving.
4. Provider configuration uses Windows Credential Manager and explicit
   first-send consent; fallback remains functional without a provider.
5. All four Sustainable Scenarios reproduce metrics before and after every
   accepted Transaction.
6. Crash, timeout, cancellation, reconnect, journal reconciliation, and rollback
   tests pass with production packaging.
7. Windows installer and portable artifacts own a compatible Node/native ABI,
   and release automation builds the bundle before manifest generation.
8. Documentation baseline, current architecture, source links, and capability
   matrix match the release commit.

## Expansion path

This Wiki is AIPoB-first. A future standalone encyclopedia can add:

```text
docs/pob/  # inherited PoB architecture, calculator, formats, and extension guides
docs/poe/  # versioned mechanic summaries and source maps
```

Those sections should follow [Reference sources](../reference-sources.md), avoid
duplicating volatile data, and leave existing `docs/aipob/` links stable.
