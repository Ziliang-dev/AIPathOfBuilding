# AIPathOfBuilding sidecar

AIPathOfBuilding keeps Path of Building's Lua calculation engine as the source of truth. A local TypeScript sidecar runs the graph/loop workflow and communicates with PoB over an authenticated loopback protocol.

## Current integration status

This branch is an implementation baseline, not yet a release candidate. The deterministic existing-build optimizer, workflow checkpoints, four Sustainable/Peak scenario pairs, Domain Graph validation, transactional Apply, and Windows packaging path are connected.

The authenticated PoB Trade/catalog broker is not connected yet. Trade therefore fails closed. Budgeted Unique and target-Rare switches are wired to accept typed catalog proposals, but the default PoB client currently supplies no external catalog, so those requests also fall back to existing-build search with a warning. The seven-tool read-only model adapter is implemented and tested, but Windows Credential Manager retrieval, first-send consent, controller injection, and Planner Chat drafting are not connected; runtime reports deterministic fallback. Ruleset conversion, full-link compatibility beam search, native condition-source/uptime proof, and several specialized actor/season-mechanic candidate generators still require release-gate adapters and golden builds. Do not describe this branch as full-domain release-complete until those gates pass.

## Requirements

- PowerShell Core 7
- Node.js 22.13 or newer for development
- pnpm 11.19.0
- Node.js 24 x64 `node.exe` supplied locally when building a portable Windows package

The repository never downloads or commits a Node executable. API keys, OAuth tokens, SQLite state, logs, and local `.env` files must not enter source control.

Release owners remain responsible for carrying Node.js redistribution notices and licences with the final installer.

## Development

Run commands from the repository root:

```powershell
./scripts/install-sidecar.ps1
./scripts/check-sidecar.ps1
./scripts/build-sidecar.ps1
./scripts/check-manifest.ps1
```

`check-sidecar.ps1` runs lint when a lint script exists, then strict TypeScript checking and Vitest. `build-sidecar.ps1` requires the self-contained release entry at `sidecar/dist/server.cjs`.

The existing PoB Lua test workflow remains independent. Run its Busted suite using the upstream test container or the repository's established Lua test environment.

## Portable Windows package

Supply an existing Node.js 24 x64 executable. The packaging script validates its major version and does not download it:

```powershell
$env:AIPOB_NODE_EXE = 'C:\Tools\node-v24-win-x64\node.exe'
./scripts/package-windows.ps1
```

The output contains:

```text
sidecar/
  dist/server.cjs
  node_modules/better-sqlite3/
  runtime/node.exe
SHA256SUMS.txt
```

The default output is `artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip`. The script refuses to overwrite an existing directory or archive.

## Manifest and releases

`sidecar/dist/server.cjs` is part of PoB's manifest and auto-update path. A release branch must therefore contain the deterministic bundle before generating its manifest:

```powershell
./scripts/install-sidecar.ps1
./scripts/check-sidecar.ps1
./scripts/build-sidecar.ps1
python update_manifest.py --in-place
```

`update_manifest.py` points at `Ziliang-dev/AIPathOfBuilding` and preserves the `{branch}` placeholder used by PoB updates. The manifest excludes TypeScript sources, tests, `node_modules`, caches, secrets, and the portable Node runtime.

Node.js and the matching `better-sqlite3` native runtime are installer-owned. Auto-update can replace `sidecar/dist/server.cjs`, but cannot change `sidecar/runtime/node.exe` or `sidecar/node_modules`. A Node major or native ABI upgrade requires a new installer or portable package. Existing upstream beta/release automation does not yet build the sidecar before manifest generation; do not publish through it until that release step is integrated.

The Windows CI packaging artifact uses the Node 24 executable provisioned by the GitHub runner. Local release packaging must receive the executable through `-NodeExePath` or `AIPOB_NODE_EXE`.
