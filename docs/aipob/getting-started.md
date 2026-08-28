# Getting Started

This guide covers the current development baseline. No release-quality end-user
installer is published from this branch yet.

## Requirements

- PowerShell Core 7 (`pwsh`)
- Node.js 24.20.0 x64 for the release-compatible development path
- pnpm 11.19.0
- Docker or a local LuaJIT/Busted environment for the upstream PoB Lua tests
- An existing Node.js 24.20.0 x64 `node.exe` when assembling Windows packages

The repository does not download or commit a Node executable. Do not place API
keys, OAuth tokens, SQLite databases, logs, `.env` files, or local credential
exports in source control.

## Prepare and check the sidecar

Run commands from the repository root:

```powershell
./scripts/install-sidecar.ps1
./scripts/check-sidecar.ps1
./scripts/build-sidecar.ps1
./scripts/check-manifest.ps1
```

These commands install the locked pnpm dependencies, run TypeScript checks and
Vitest, build `sidecar/dist/server.cjs`, and confirm that the release manifest
contains the sidecar bundle.

For direct sidecar development:

```powershell
Set-Location -LiteralPath './sidecar'
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## Use the Planner tab

With a build open in PoB:

1. Open **AI Build Planner**.
2. Choose a goal preset: Balanced, Maximum Offence, Maximum Defence, or Smooth
   Mapping.
3. Add goal details, or use **Planner Chat** to create a draft. Review every
   draft before using it. Free-text constraint notes are not enforced until
   they are converted into structured fields.
4. Optionally set minimum EHP and minimum worst-case maximum hit. These are hard
   constraints across all four sustainable scenarios.
5. Choose the primary scenario. It receives the largest default ranking weight.
6. Set a Divine budget only if paid-source candidates should be eligible. The
   current build can still be searched without a budget.
7. To search authenticated PoE Trade, enable **PoE Trade** and provide an exact
   league name. Trade requires a Budget.
8. Choose locks. Class, ascendancy, and main skill are locked by default.
9. Check **Confirm this objective before search**, then select **Start**.

The sidecar starts lazily on the first search. The current CLI reports
provider status to the Planner. Without a configured, consented provider, the
run uses the deterministic domain schedule.

## Configure Planner Chat

Open provider setup in the Planner, then enter an OpenAI-compatible endpoint,
model name, and API key. The key is stored only in Windows Credential Manager
under `AIPathOfBuilding/LLM/openai`; the provider profile and consent record do
not contain the key.

Before the first provider call, inspect the consent preview. It binds the exact
endpoint, model, data categories, privacy/redaction policy, and redacted payload
hash. Granting consent enables Planner Chat and model-assisted workflow steps.
Changing the provider profile requires new consent. Clearing the provider
removes its LLM credential and consent. It does not modify PoE Trade OAuth data.

Planner Chat returns an Objective Draft or a clarification question. A draft is
ephemeral and never starts a run or changes the Build. Review it, resolve unknown
metrics, then confirm the resulting structured Objective normally.

## Review results

The Planner may select up to three verified candidates:

- **Offence**
- **Balanced**
- **Defence**

Select **Preview** to calculate a non-mutating diff. Select **Apply** only after
reviewing the candidate, cost, metrics, and action count. A confirmation dialog
appears before any build change.

Cancel requests stop active work and preserve persisted state when the SQLite
checkpoint store is available. Completed, failed, and cancelled runs are
terminal and cannot be resumed.

## Current limitations

- Trade queries are bounded, typed, Budget-scoped, and executed by PoB. A Trade
  failure emits a warning and continues local search. It never authorizes
  purchase, seller contact, account writes, or game input.
- Unique and target-Rare controls accept typed catalog candidates, but the
  current main process does not yet supply a non-Trade external proposal
  catalog.
- Native link probing covers proposed links, but full-gem-catalog candidate
  generation remains partial.
- Golden coverage has both 3.29 rulesets and required actor/season projections;
  more archetypes, rotations, conflicts, and negative cases remain useful.
- No signed installer is published from this branch. Portable, NSIS, native
  helper, and real-PoB process checks are release CI gates.

The complete list is in [Status and roadmap](status-and-roadmap.md).

## Portable Windows package

Provide an existing Node.js 24.20.0 x64 executable. The packaging script
validates the exact version, architecture, ABI, SQLite native binding, WinCred
helper, manifest, and hashes. It refuses to overwrite an existing output
directory or archive.

```powershell
$env:AIPOB_NODE_EXE = 'C:\Tools\node-v24-win-x64\node.exe'
./scripts/package-windows.ps1
```

Default output:

```text
artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

The package includes the full PoB runtime, sidecar bundle, `better-sqlite3` and
its matching native binding, Node runtime, and WinCred helper. A Node or native
ABI change requires a new installer or portable package; the PoB auto-updater
cannot safely replace those installer-owned components.

Build and verify the canonical NSIS installer from the portable ZIP:

```powershell
./scripts/package-installer-windows.ps1 `
  -PackagePath artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip `
  -OutputPath artifacts/AIPathOfBuilding-AIPoB-Setup.exe
./scripts/verify-installer-windows.ps1 `
  -InstallerPath artifacts/AIPathOfBuilding-AIPoB-Setup.exe `
  -PackagePath artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

For contributor setup and release ordering, see
[Development](development.md). For runtime failures, see
[Troubleshooting](troubleshooting.md).
