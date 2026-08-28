# AIPathOfBuilding

AIPathOfBuilding plans and evaluates Path of Exile builds across the complete gameplay state understood by Path of Building. This glossary defines the canonical language shared by the planner, its users, and its maintainers.

## Build planning

**Build**:
The complete gameplay-relevant state of one Path of Exile character, including its ruleset, progression, skills, items, passives, actors, and combat configuration.
_Avoid_: Character, setup

**Objective**:
A confirmed optimization intent containing desired metrics, hard constraints, a primary Scenario, Scenario weights, Locks, a Budget, candidate sources, and a search preset.
_Avoid_: Prompt, request, goal text

**Objective Draft**:
An unconfirmed interpretation of conversational input that cannot start optimization until the user accepts its structured form.
_Avoid_: Objective

**Lock**:
A declaration that a selected part of a Build must remain unchanged during optimization.
_Avoid_: Preference, pin

**Budget**:
The maximum acquisition cost allowed for a Candidate and the switch that determines whether external item candidates may be considered.
_Avoid_: Search limit, compute budget

**Build Snapshot**:
An immutable capture of a Build at a known engine, content, and ruleset version, identified by a fingerprint.
_Avoid_: Save, backup

**Build Action**:
A typed, reversible proposal to change one gameplay-relevant part of a Build, together with its preconditions, dependencies, and cost.
_Avoid_: Patch, mutation, command

**Candidate**:
An immutable proposal derived from one Build Snapshot, consisting of an ordered dependency graph of Build Actions plus measured outcomes, costs, and evidence.
_Avoid_: Build, result, recommendation

**Pareto Frontier**:
The Candidates for which no other valid Candidate is at least as good in every objective and strictly better in one.
_Avoid_: Leaderboard, top score

**Progression Plan**:
An ordered sequence of independently valid Candidates that connects the current Build to a target Build through budget or level milestones.
_Avoid_: Upgrade list, roadmap

## Evaluation

**Scenario**:
A named combat context that fixes enemy class, encounter assumptions, and the conditions under which a Build is evaluated.
_Avoid_: Configuration, preset

**Mapping**:
The Scenario for ordinary non-boss enemies, retaining applicable map modifiers from the current Build.
_Avoid_: Normal

**Standard Boss**:
The Scenario for Path of Building's standard boss enemy class.
_Avoid_: Bossing

**Guardian/Pinnacle**:
The Scenario for Path of Building's guardian or pinnacle enemy class.
_Avoid_: Guardian, Pinnacle

**Uber Pinnacle**:
The Scenario for Path of Building's uber pinnacle enemy class.
_Avoid_: Uber

**Sustainable Profile**:
The primary evaluation profile containing only conditions whose continued availability is supported by the Build and the Scenario.
_Avoid_: Realistic, average

**Peak Profile**:
A secondary evaluation profile containing valid but temporary or intermittent conditions; it never determines the primary ranking.
_Avoid_: Burst Scenario, maximum configuration

**Condition Evidence**:
The provenance and availability assessment for one requested combat condition, classified as `proven_sustainable`, `proven_peak`, `intermittent`, `manual`, `impossible`, `conflicting`, or `unknown`.
_Avoid_: Configuration flag, assumption

**Hard Constraint**:
A requirement that every Candidate must satisfy in every required Sustainable Profile.
_Avoid_: Target, weight

**Primary Scenario**:
The Scenario with the greatest ranking weight; Mapping is the default.
_Avoid_: Main configuration

## Graphs and execution

**Domain Graph**:
A graph of Build facts and the `grants`, `requires`, `triggers`, `scales`, `consumes`, `conflicts`, `replaces`, `usesSlot`, and `availableIn` relationships among them.
_Avoid_: Skill tree, dependency list

**Workflow Graph**:
The resumable decision process that captures a Build, confirms an Objective, searches and verifies Candidates, and pauses before any accepted Candidate changes the Build.
_Avoid_: Agent loop, pipeline

**Optimization Run**:
One resumable execution of a Workflow Graph for a confirmed Objective and Build Snapshot, including its frontier, consumed limits, and stopping reason.
_Avoid_: Chat, session

**Transaction**:
The human-authorized, all-or-nothing replacement of the current Build with a verified Candidate, including restoration of the exact prior Build on failure.
_Avoid_: Commit, apply, save

## Full-domain coverage

**Gameplay-Relevant State**:
All Build state that can change availability or calculated outcomes: ruleset; identity and progression; skills and execution; items and loadouts; passives and jewels; player, minion, guardian, spectre, and party actors; and combat conditions.
_Avoid_: DPS inputs

**External Candidate**:
An item proposal obtained through Path of Building's existing Trade access or its unique and target-rare catalogs, subject to the Objective's Budget.
_Avoid_: Account item, stash item

**Excluded Content**:
Stashes, guild stashes, character inventory, rucksack, Atlas planning, farming strategy, probabilistic crafting, automated purchases or messages, game input, account writes, and access requiring new account scopes are outside the planning domain.
_Avoid_: Unsupported Build state
