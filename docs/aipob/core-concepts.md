# Core Concepts

These names form the canonical language for AIPoB code, tests, UI, and
documentation. Use the defined term when referring to the concept.

## Build planning

### Build

The complete gameplay-relevant state of one Path of Exile character represented
by PoB, including ruleset, progression, skills, items, passives, actors, and
combat configuration.

Avoid using *character* or *setup* when the complete saved state is meant.

### Objective

A confirmed optimization intent containing goals, hard constraints, a primary
Scenario, Scenario weights, Locks, an optional Budget, candidate sources, and a
search preset. A run cannot start until the user confirms the structured
Objective.

### Objective Draft

An unconfirmed or incomplete interpretation that must be normalized and
confirmed before optimization. Planner Chat can produce a Draft through a
configured and consented OpenAI-compatible provider. The user must review and
accept the Draft; it cannot start a run or mutate a Build.

### Lock

A declaration that part of a Build must remain unchanged during search. The
current Planner exposes class, ascendancy, and main-skill Locks and keeps them
enabled by default.

### Budget

The maximum paid-source cost, expressed in Divine orbs by the current UI. A
missing Budget disables Unique, target-Rare, and Trade candidate sources. It is
not a compute limit.

### Build Snapshot

An immutable capture of Build XML, baseline metrics, configuration, gameplay
field paths, content catalog, versions, and fingerprint. Candidates refer to the
fingerprint of their source Snapshot.

### Build Action

A typed, reversible proposal to change one gameplay-relevant part of a Build.
It contains an identifier, description, kind, payload, dependencies,
preconditions, optional cost, and reversibility flag.

### Candidate

An immutable proposal based on one Build Snapshot. It contains an ordered graph
of Build Actions, metrics for all required Scenarios, optional Peak metrics,
cost, Condition Evidence, and hard-constraint status.

A Candidate is not the active Build. Previewing it does not apply it.

### Pareto Frontier

The valid Candidates for which no other Candidate is at least as good for every
Objective metric and strictly better for one. The Planner selects up to three
representatives labelled Offence, Balanced, and Defence.

### Progression Plan

An ordered dependency graph of independently valid upgrade milestones. The
sidecar includes progression primitives, but a complete progression-planning UI
is not connected in the current baseline.

## Evaluation

### Scenario

A named combat context that fixes enemy class, map or encounter assumptions,
allowed events, and evaluation profile.

### Current configuration

A diagnostic Scenario that preserves the user's manual PoB configuration. It is
not ranked and does not prove that its conditions are sustainable.

### Mapping

The ranked Scenario for ordinary non-boss enemies. Applicable current map
modifiers are retained, adds are allowed, and on-kill events may be used.

### Standard Boss

The ranked Scenario using PoB's `Boss` enemy class. Adds and on-kill assumptions
are disabled.

### Guardian / Pinnacle

The ranked Scenario using PoB's `Pinnacle` enemy class. Adds and on-kill
assumptions are disabled.

### Uber Pinnacle

The ranked Scenario using PoB's `Uber` enemy class. Adds and on-kill assumptions
are disabled.

### Sustainable Profile

The primary profile. A condition can be enabled only when a legal source is
available for the Scenario, required resources are sustainable, and known
uptime reaches the configured threshold. The current threshold is 90%.

### Peak Profile

A non-ranking profile for legal temporary conditions. Peak metrics are shown
separately and never replace Sustainable metrics for hard constraints or primary
ranking.

### Condition Evidence

The source and availability assessment for a requested combat condition. The
schema records source identifiers, trigger chain, uptime, conflicts, confidence,
and one of these statuses:

- `proven_sustainable`
- `proven_peak`
- `intermittent`
- `manual`
- `impossible`
- `conflicting`
- `unknown`

Native compatibility and uptime claims are bound to the Build, Candidate,
Scenario, and proof fingerprints. Incomplete or truncated native probe output
cannot become accepted Condition Evidence.

### Hard Constraint

A numeric requirement that every accepted Candidate must satisfy. UI survival
floors apply to every required Sustainable Scenario. Free-text drafting notes
are not Hard Constraints.

### Primary Scenario

The Scenario receiving the greatest default ranking weight. Mapping is the
default. Current UI weights are 0.55 for the primary Scenario and 0.15 for each
other Scenario.

## Graphs and execution

### Domain Graph

A graph of Build facts and their supported relationships:

- `grants`
- `requires`
- `triggers`
- `scales`
- `consumes`
- `conflicts`
- `replaces`
- `usesSlot`
- `availableIn`

### Workflow Graph

The resumable decision process that captures a Build, confirms an Objective,
searches and verifies Candidates, pauses for approval, and records the final
Transaction result.

### Optimization Run

One execution of the Workflow Graph for a confirmed Objective and Build
Snapshot. It records the frontier, selected Candidates, resource usage,
checkpoint state, status, and stopping reason.

### Transaction

The human-authorized, all-or-nothing replacement of the active Build with one
verified Candidate. It verifies the base fingerprint, orders Build Actions,
preflights scenario metrics, applies the actions, verifies committed results,
and restores the prior Build on failure.

### Actor Projection

A typed view of state owned by a player, minion, spectre, Animate Guardian, or
party member. Projections let adapters reason about the correct owner without
sending free-form party text to the sidecar.

### Ruleset Projection

The versioned mechanic view for a PoE ruleset. The connected release corpus
covers `3_29` and `3_29_ruthless`, including Bloodline, Pact, advanced passive,
and seasonal equipment state.

## Scope terms

### Gameplay-Relevant State

Saved Build state that can change availability or calculated outcomes. Notes,
calculated output, and purely visual UI state are not planning inputs.

### External Candidate

An item proposal obtained outside the existing Build, such as a unique catalog,
target rare, or Trade result. Authenticated Trade candidates are connected
through the PoB-owned broker and arrive in the sidecar as sanitized typed items.
Non-Trade Unique and target-Rare external proposal catalogs remain partial.

### Excluded Content

State and operations outside the planning domain: stash and inventory access,
Atlas planning, farming strategy, probabilistic crafting, automated purchase or
messaging, game input, account writes, and new account scopes.

See [Domain rules](domain-rules.md) for enforced behavior and
[Status and roadmap](status-and-roadmap.md) for implementation coverage.
