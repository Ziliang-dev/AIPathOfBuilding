# AIPathOfBuilding Overview

AIPathOfBuilding adds a build-optimization workflow to the Path of Building
Community fork. Path of Building remains the source of truth for build loading,
game data, and calculated outcomes. A local TypeScript sidecar coordinates
search, checkpoints, candidate selection, and the approval workflow.

The current branch is an implementation baseline. The six completion packages
are connected, while full-catalog candidate breadth, more Golden Builds, and
published Windows artifacts remain incomplete or CI-gated. See
[Status and roadmap](status-and-roadmap.md) for the authoritative capability
list.

## Product goal

Given an open PoB build and a confirmed structured objective, AIPoB should:

1. capture an immutable build snapshot;
2. evaluate it under consistent combat scenarios;
3. propose reversible build actions;
4. verify candidates with the PoB calculator;
5. present a small Pareto-selected set for comparison; and
6. change the active build only after explicit user approval.

The sidecar may guide search, but it cannot replace PoB's calculator or mutate
the build directly.

## Intended users

- Build planners who want verified upgrade candidates rather than unmeasured
  suggestions.
- Advanced players comparing offence, defence, cost, and encounter assumptions.
- PoB contributors extending search coverage for new build domains or league
  mechanics.
- Maintainers testing a local AI-assisted workflow without granting game-account
  write access.

## Current user scenarios

### Improve an existing build

Open a build, choose a goal preset and primary scenario, confirm the objective,
then search the state and catalog already exported by PoB. Compare the Offence,
Balanced, and Defence candidates. Previewing does not change the build.

### Enforce survivability floors

Enter minimum effective hit pool or worst-case maximum-hit requirements. These
become structured hard constraints evaluated across the four sustainable
scenarios. Free-text constraint notes are drafting input only and are not hard
constraints in the current UI.

### Apply a verified candidate

Select Apply and confirm the dialog. The planner verifies the captured build
fingerprint and candidate metrics, applies the action graph as one transaction,
and restores the prior build if an action or final verification fails.

### Understand and draft with a model

Configure an OpenAI-compatible endpoint and grant first-send consent for its
exact model and redacted payload. **Analyze Build** makes the model discover
typed mechanic relations from local PoB facts, then proves critical relations
with isolated PoB counterfactuals. Planner Chat can draft a structured
Objective; the user must review and confirm it. Without provider configuration,
consent, or connectivity, new analysis and Start are blocked.

### Search authenticated Trade

Set a Budget, realm, and exact league, then enable PoE Trade. PoB owns Trade
authentication, rate limiting, seller identity, and raw responses. The sidecar
receives sanitized typed items only. Failure produces a warning and local search
continues.

## Product boundaries

The planning domain is PoB's gameplay-relevant saved build state: rules and
identity, skills, equipment, passive trees, supported actors, and combat
configuration. Connected adapters cover both 3.29 rulesets; full-catalog search
and regression-corpus breadth remain partial.

The project deliberately does not perform:

- automated purchases, seller messages, or trade actions;
- game input or account writes;
- stash, guild stash, inventory, or rucksack management;
- Atlas or farming optimization;
- probabilistic crafting simulation;
- acquisition of new OAuth scopes; or
- calls to undocumented external interfaces.

## Relationship to Path of Building

AIPoB is a fork extension, not a replacement calculator. Upstream PoB provides:

- the build XML format and migration behavior;
- game content and tree data;
- modifier parsing and calculation;
- worker evaluation of scenario-specific metrics;
- existing Trade authentication and rate-limiting code; and
- the application UI and update mechanism.

AIPoB adds the Planner tab, capture and transaction modules, a versioned local
RPC boundary, and the TypeScript graph/search sidecar. Upstream developer
material remains indexed from the [Wiki home](../index.md).

## Design principles

- **PoB-authoritative:** all accepted metrics come from PoB evaluation.
- **Local control:** RPC binds to IPv4 loopback and uses a per-launch token.
- **Human-gated:** no build mutation occurs without explicit Apply approval.
- **Reversible:** candidate actions are typed and transactions restore the
  captured build on failure.
- **Fail closed:** stale proof, invalid mutation, and unavailable credentials
  are rejected; degradable Trade failure is reported and excluded from results.
- **Private by boundary:** PoE Trade secrets stay in PoB; only the LLM API key
  uses the restricted Windows Credential Manager namespace.
- **Versioned:** cross-process schemas and game-dependent claims carry explicit
  versions.

Continue with [Getting started](getting-started.md) or
[Architecture](architecture.md).
