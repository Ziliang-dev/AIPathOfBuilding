# Domain Rules

These rules define what AIPoB may rank, preview, and apply in the current
architecture. They do not attempt to restate the complete Path of Exile ruleset.
PoB calculation remains authoritative.

## Authority and reproducibility

1. A metric is accepted only when produced by the checked-out PoB engine and
   content data.
2. A Candidate is evaluated from immutable Build XML plus typed Build Actions
   and an explicit Scenario.
3. A Candidate always names its base Build fingerprint.
4. Candidate metrics originate in worker evaluation. Preview renders the
   persisted verified Candidate; Apply uses fresh worker evaluation rather than
   trusting model claims or cached prose.
5. Game-mechanic explanations may link to PoE Wiki, but a calculation dispute
   is resolved against PoB code and tests for the documented version.

## Objective rules

- An Objective must contain at least one goal.
- Goal direction is `maximize` or `minimize`; goal weight must be positive.
- Scenario weights are between zero and one and must sum to one.
- Hard constraints use numeric comparison against a named metric.
- Class, ascendancy, main skill, and arbitrary field Locks prevent Candidates
  that touch those fields.
- A missing Budget forces Unique, target-Rare, and Trade sources off.
- A present Budget does not make a source available; its broker and typed
  proposals must also exist.
- Trade additionally requires an exact realm/league context and a connected
  reverse broker. Unavailable Trade degrades to a warning and local search.

## Scenario matrix

| Scenario | PoB enemy class | Adds | On-kill | Mapping modifiers |
| --- | --- | --- | --- | --- |
| Mapping | `None` | Allowed | Allowed | Retained when represented by current config inputs |
| Standard Boss | `Boss` | Not assumed | Disallowed | Cleared |
| Guardian / Pinnacle | `Pinnacle` | Not assumed | Disallowed | Cleared |
| Uber Pinnacle | `Uber` | Not assumed | Disallowed | Cleared |

Each row has a Sustainable and Peak profile. A separate Current diagnostic
Scenario preserves the user's manual configuration but is never ranked proof.

## Condition Evidence

A condition source must be structurally valid and its trigger must be allowed by
the Scenario. Sources requiring adds or kills are unavailable when the Scenario
forbids them.

For Sustainable eligibility, a source must:

- not be marked peak-only;
- have sustainable resources;
- have known uptime; and
- reach at least the Scenario threshold, currently 90%.

A legal temporary source can be `proven_peak` in a Peak profile. Below-threshold
sources are `intermittent`; manual assertions are `manual`; absent or unknown
chains are `unknown` or `impossible`.

Mutually exclusive eligible conditions are resolved deterministically by
preference, uptime, confidence, then condition name. Rejected alternatives are
marked `conflicting`. The resolver can create bounded alternate variants for
conflict exploration.

Candidate proof combines registered mechanic adapters with post-action native
PoB extraction. Each ranked Scenario requires its own complete, non-truncated
native result. Candidate, native-probe, evidence, and source fingerprints bind
the facts to one calculator run. Missing proof does not fall back to manual
truth.

## Domain Graph rules

The only accepted edge relations are:

`grants`, `requires`, `triggers`, `scales`, `consumes`, `conflicts`, `replaces`,
`usesSlot`, and `availableIn`.

Graph validation rejects duplicate node identifiers, missing edge endpoints,
self-relations where forbidden, invalid relations, and structurally invalid
data. Mechanic adapters may add versioned nodes, edges, condition claims, and
candidate semantics.

The coverage registry classifies gameplay field paths exported by PoB. A
snapshot with an unclassified required field fails capture instead of silently
claiming full coverage. Classification does not guarantee that search has a
candidate generator for every field.

## Candidate generation rules

- The zero-action current Build is always available as a baseline.
- Catalog entries must be marked available and contain schema-valid typed
  actions.
- A Candidate may contain multiple actions only when dependencies form an
  acyclic graph.
- Candidate cost is the declared estimate or the sum of action costs.
- A Candidate must respect Objective Locks, Budget, graph availability, and
  passive-point constraints before evaluation.
- External source metadata cannot bypass the controller's source policy.
- Raw model text, raw Lua, and unvalidated item text are not Build Actions.
- A proposed `replaceSkillLinks` action must fit native socket capacity and each
  enabled support gem must appear in PoB's accepted-support matrix for an active
  skill in that group.
- Metrics-only cache entries cannot bypass the native proof barrier.

The current deterministic adapters infer proposals from content exported by PoB
and dynamic Trade records. Native compatibility is authoritative for proposed
links. Broader full-catalog link generation and cross-domain packages remain
roadmap work.

## Trade/catalog rules

- The sidecar may send only schema-validated semantic constraints: ruleset,
  realm, exact league, slot, category, rarity, corruption, item level, bounded
  stat ranges, result limit, and deadline.
- Raw Trade query JSON is built only in the PoB process.
- PoB owns OAuth, request queue, rate limiting, currency conversion, seller
  identity, listing IDs, whispers, URLs, and upstream error details.
- Only fixed-price items within the confirmed Divine Budget cross the boundary.
- Catalog items are bounded, hash-validated, seller-free, and tied to the query
  hash and ruleset.
- `importAndEquip` rechecks item text SHA-256, exact slot/item set, source, price,
  PoB parsing, and slot compatibility inside the human-approved Transaction.
- A broker error never authorizes a mutation and does not turn unverified items
  into local Candidates.

## Provider and consent rules

- Only OpenAI-compatible profiles are supported by the connected provider path.
- API keys may exist only in Windows Credential Manager under
  `AIPathOfBuilding/LLM/<providerId>`. Project files, `.env`, command arguments,
  logs, status payloads, and SQLite profiles must not contain keys.
- The credential helper refuses every target outside the LLM namespace. It does
  not read, migrate, or delete PoE OAuth credentials.
- Before the first provider call, consent must bind the exact endpoint, model,
  data categories, privacy policy, redaction policy, and redacted payload
  preview. Profile or policy changes require new consent.
- `connection_probe` is a non-default category used only by a fixed, minimal,
  forced-tool-call request. Its preview binds the exact endpoint, model, policy
  versions, and payload hash. Authorization is memory-only, consumed once, and
  never grants durable consent or permission to send Build/chat data.
- A connection test may use an unsaved key without persisting it. An existing
  WinCred key may be reused only when the canonical endpoint is unchanged; a new
  endpoint requires a newly entered key. Failure must not change the saved
  profile, credential, or durable consent.
- Connection-test results expose only success, latency, requested/response
  model, forced-tool-call validation, and optional token usage. Keys and raw
  provider responses must not enter RPC results, logs, SQLite, or status files.
- Revocation prevents new provider calls and aborts matching active provider
  work. Deterministic fallback remains valid.
- Planner Chat text is ephemeral. Its output must pass the strict Objective Draft
  schema; unresolved metrics block use; applying a draft resets human
  confirmation. Chat never produces a Build Action.

## Evaluation and ranking rules

- Hard constraints must pass in every applicable Sustainable Scenario.
- Ranking uses the Objective's Scenario weights and metric directions.
- Peak metrics are informational and excluded from Sustainable constraint
  satisfaction.
- Only non-dominated Candidates remain on the Pareto frontier.
- Selection is stable and returns at most Offence, Balanced, and Defence views.
- A Candidate selected under one label still retains its verified action graph
  and Scenario metrics.

## Build Action rules

Every action requires a non-empty ID, description, kind, payload, and
reversibility declaration. Dependencies must reference actions in the same
Candidate. Duplicate IDs, missing dependencies, or dependency cycles fail
ordering.

Lua normalizes public action kinds into supported build, configuration, skill,
item, tree, party, and loadout operations. Each operation validates the target
against the active PoB structures. Unsupported precondition expressions fail
closed; a base-fingerprint precondition is supported.

Protocol-v2 public actions include `importAndEquip`,
`selectSecondaryAscendancy`, `setTreeOverride`, and `setPartyBuffer`. Imported
item and party-buffer content must match its SHA-256 source hash. Secondary
ascendancy and override actions use PoB-native tree structures and restore the
captured undo state on failure.

Passive-tree actions recheck point budgets, mastery availability, node
connectivity, and ascendancy limits. Item, skill, party, and loadout actions
similarly require the target set, slot, actor, or control to exist.

## Transaction invariants

An Apply Transaction must satisfy all of these conditions:

1. User explicitly approved the selected Candidate.
2. Candidate fingerprint matches the active captured Build.
3. Candidate action graph is valid and acyclic.
4. Preflight sandbox reproduces expected metrics.
5. Exactly one Sustainable Scenario for each ranked Scenario is provided.
6. Fresh verification still satisfies all hard constraints.
7. Commit metrics match preflight metrics within implemented numeric tolerance.
8. Commit-time native link/evidence proof matches the preflight proof.
9. Any failure restores and verifies the original Build fingerprint.

If rollback itself cannot be verified, the result is non-recoverable and the UI
must report the failure instead of claiming success.

## External knowledge policy

Do not copy league-specific item tables or volatile numeric mechanics into this
page. Use [Reference sources](../reference-sources.md) and add the relevant PoE
version when a game rule is necessary to explain an adapter.
