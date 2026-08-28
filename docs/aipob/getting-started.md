# Getting Started

This guide covers the current development baseline. No release-quality end-user
installer is published from this branch yet.

## Requirements

- PowerShell Core 7 (`pwsh`)
- Node.js 22.13 or newer for sidecar development
- pnpm 11.19.0
- Docker or a local LuaJIT/Busted environment for the upstream PoB Lua tests
- An existing Node.js 24 x64 `node.exe` when assembling the portable Windows
  package

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
3. Add goal details. Free-text constraint notes are not enforced until they are
   converted into structured fields.
4. Optionally set minimum EHP and minimum worst-case maximum hit. These are hard
   constraints across all four sustainable scenarios.
5. Choose the primary scenario. It receives the largest default ranking weight.
6. Set a Divine budget only if paid-source candidates should be eligible. The
   current build can still be searched without a budget.
7. Choose locks. Class, ascendancy, and main skill are locked by default.
8. Check **Confirm this objective before search**, then select **Start**.

The sidecar starts lazily on the first search. The current CLI reports
`providerConfigured=false`, so the run uses the deterministic domain schedule.
The model adapter is not connected to the Planner controller.

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

- Authenticated PoB Trade is not connected to the sidecar. Trade requests are
  disabled with a warning.
- Unique and target-rare controls accept typed catalog candidates, but the
  current main-process integration does not supply external proposals.
- Windows Credential Manager retrieval, first-send consent, model-provider
  injection, and conversational objective drafting are not connected.
- Several full-domain adapters and release-gate golden builds are incomplete.

The complete list is in [Status and roadmap](status-and-roadmap.md).

## Portable Windows package

Provide an existing Node.js 24 x64 executable. The packaging script validates
its major version and refuses to overwrite an existing output directory or
archive.

```powershell
$env:AIPOB_NODE_EXE = 'C:\Tools\node-v24-win-x64\node.exe'
./scripts/package-windows.ps1
```

Default output:

```text
artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

The package includes the sidecar bundle, `better-sqlite3` and its matching
native binding, and the supplied Node runtime. A Node major or native ABI change
requires a new installer or portable package; the PoB auto-updater cannot safely
replace those installer-owned components.

For contributor setup and release ordering, see
[Development](development.md). For runtime failures, see
[Troubleshooting](troubleshooting.md).
