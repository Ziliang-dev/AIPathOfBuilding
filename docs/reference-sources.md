# Reference Sources

This page defines where documentation facts come from and how to handle facts
that change with Path of Building or Path of Exile releases.

## Source precedence

Use the first applicable source:

1. **AIPoB code and tests in this repository.** These define current behavior.
2. **Accepted AIPoB ADRs.** These define architectural constraints and intent.
3. **Upstream Path of Building code, tests, and repository documentation.**
   These define PoB behavior inherited by the fork.
4. **Official Path of Exile announcements, patch notes, and developer data.**
   These define released game behavior.
5. **PoE Wiki.** Use it for curated explanations and terminology when an
   official source does not explain the mechanic fully.

If sources disagree, describe the disagreement and follow the implementation
used by the checked-out code. Do not silently combine rules from different game
versions.

## Primary local references

| Subject | Source |
| --- | --- |
| Planner UI and objective construction | [`src/Classes/AIPlannerTab.lua`](../src/Classes/AIPlannerTab.lua) |
| Lua-side capture, RPC, preview, and apply | [`src/Modules/AIPoB/`](../src/Modules/AIPoB/) |
| Cross-process schemas | [`sidecar/src/schemas.ts`](../sidecar/src/schemas.ts) and [`sidecar/src/protocol.ts`](../sidecar/src/protocol.ts) |
| Workflow graph | [`sidecar/src/workflow/`](../sidecar/src/workflow/) |
| Search and candidate selection | [`sidecar/src/search/`](../sidecar/src/search/) |
| Domain graph, coverage, scenarios, and evidence | [`sidecar/src/domain/`](../sidecar/src/domain/) |
| Current integration limitations | [Status and roadmap](aipob/status-and-roadmap.md) |
| Upstream PoB internals | [Codebase rundown](rundown.md) and other upstream pages in this directory |

## External references

- [Path of Building Community repository](https://github.com/PathOfBuildingCommunity/PathOfBuilding)
- [Path of Building Community releases](https://github.com/PathOfBuildingCommunity/PathOfBuilding/releases)
- [Path of Exile official site](https://www.pathofexile.com/)
- [Path of Exile official forum and patch notes](https://www.pathofexile.com/forum)
- [PoE Wiki](https://www.poewiki.net/)
- [PoE Wiki game mechanics index](https://www.poewiki.net/wiki/Game_mechanics)

The [old Openarl GitHub Wiki](https://github.com/Openarl/PathOfBuilding/wiki) is
historical material, not a current source for this fork.

## Versioning rules

- Record the relevant PoE version for tree data, skills, items, league
  mechanics, and numeric examples.
- Record the PoB release or commit when documenting a parser or calculator
  behavior that may change upstream.
- Prefer qualitative rules over copied numeric values. Link to the source that
  owns the value.
- Never use the current league name as a permanent architectural concept.
- Treat generated files under `src/Data` and `src/TreeData` as versioned
  implementation data, not hand-maintained prose.

## Updating the baseline

When the fork rebases or updates game data:

1. Update the baseline table in [the Wiki index](index.md).
2. Review the capability matrix in
   [Status and roadmap](aipob/status-and-roadmap.md).
3. Recheck version-sensitive examples and links.
4. Update documentation only after the corresponding code or data is present.
