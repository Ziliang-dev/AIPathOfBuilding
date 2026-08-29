# Getting Started

This guide covers the current development baseline. No release-quality end-user
installer is published from this branch yet.

## Requirements

- WSL2 Ubuntu with Bash and Python 3.10+
- Node.js 24.20.0 x64 for the release-compatible development path
- pnpm 11.19.0
- Docker or a local LuaJIT/Busted environment for the upstream PoB Lua tests
- GitHub Actions for the exact Windows packaging toolchain; local MSVC/NSIS is optional

The repository does not download or commit a Node executable. Do not place API
keys, OAuth tokens, SQLite databases, logs, `.env` files, or local credential
exports in source control.

## Prepare and check the sidecar

Run commands from the repository root:

```bash
python3 scripts/aipob.py install-sidecar
python3 scripts/aipob.py check-sidecar
python3 scripts/aipob.py build-sidecar
python3 scripts/aipob.py check-manifest
```

These commands install the locked pnpm dependencies, run TypeScript checks and
Vitest, build `sidecar/dist/server.cjs`, and confirm that the release manifest
contains the sidecar bundle.

For direct sidecar development:

```bash
cd sidecar
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

## Run the latest verified CI portable

The portable artifact avoids local MSVC, NSIS, Windows Node, and native-module
setup. Authenticate GitHub CLI once, then run from WSL at the repository root:

```bash
python3 scripts/aipob.py sync-ci-windows
./artifacts/ci-latest/app/Path\ of\ Building.exe
```

`sync-ci-windows` selects the newest completed, successful `aipob.yml` run for
the current Git branch. It downloads the canonical portable artifact, checks
its hashes and metadata, launches its pinned Node/SQLite sidecar smoke test,
and only then replaces `artifacts/ci-latest`. The marker
`artifacts/ci-latest/ci-sync.json` prevents a repeated download of the same run.

Only the managed latest copy is retained normally. A File Explorer, editor, or
workspace watcher handle on the `ci-latest` directory is handled by a
transactional content exchange with rollback. If Windows has an actual package
file open, the verified update stays in `artifacts/ci-pending`; close its owner
and let the next check promote it. Other artifact directories are never
removed.

## Use the Planner tab

With a build open in PoB:

1. Open **AI Build Planner**.
2. Import a Build or add a socket group with an enabled active main skill. An
   empty Build cannot start search; character level 1 alone is allowed.
3. Choose a goal preset: Balanced, Maximum Offence, Maximum Defence, or Smooth
   Mapping.
4. Add goal details, or use **Planner Chat** to create a draft. Review every
   draft before using it. Free-text constraint notes are not enforced until
   they are converted into structured fields.
5. Optionally set minimum EHP and minimum worst-case maximum hit. These are hard
   constraints across all four sustainable scenarios.
6. Choose the primary scenario. It receives the largest default ranking weight.
7. Set a Divine budget only if paid-source candidates should be eligible. The
   current build can still be searched without a budget.
8. To search authenticated PoE Trade, enable **PoE Trade** and provide an exact
   league name. Trade requires a Budget.
9. Choose locks. Class, ascendancy, and main skill are locked by default.
10. Check **Confirm this objective before search**, then select **Start**.

The Planner displays separate `Run` and `Sidecar` states. The sidecar starts
lazily when LLM setup or the first search needs it. Without a configured,
consented provider, the run uses the deterministic domain schedule.

## Configure Planner Chat

Open **LLM Setup**. The window starts and handshakes the sidecar without starting
an optimization. Enter an OpenAI-compatible endpoint, model name, and API key,
then select **Test Connection**. Review the one-time authorization: it sends one
fixed synthetic forced-tool-call probe, no Build or chat data, and may incur a
very small provider charge. A successful result reports latency, response model,
tool-call validation, and optional token usage; only then is **Configure**
enabled. Editing any field invalidates the result.

The test does not save the profile or key and does not replace normal provider
consent. Failed tests leave both the unsaved protected key and existing saved
configuration unchanged. After a successful **Configure**, the key is stored
only in Windows Credential Manager under `AIPathOfBuilding/LLM/openai`; the
provider profile and consent record do not contain it. A saved key can be reused
with a blank field only while the endpoint is unchanged. Enter the key again
when changing endpoint.

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

```bash
python3 scripts/aipob.py package-windows \
  --node-exe /mnt/c/Tools/node-v24-win-x64/node.exe
```

Default output:

```text
artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

The package includes the full PoB runtime, sidecar bundle, `better-sqlite3` and
its matching native binding, Node runtime, and WinCred helper. A Node or native
ABI change requires a new installer or portable package; the PoB auto-updater
cannot safely replace those installer-owned components.

Packaging leaves the repository `manifest.xml` unchanged and writes only the
staged copy with `platform="win32"` and the selected update branch. Metadata
records that branch and the staged manifest hash. Verification rejects missing
or mismatched attributes; a verified portable must not show the repository
**Dev Mode** warning.

Build and verify the canonical NSIS installer from the portable ZIP:

```bash
python3 scripts/aipob.py package-installer-windows \
  --package artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip \
  --output artifacts/AIPathOfBuilding-AIPoB-Setup.exe
python3 scripts/aipob.py verify-installer-windows \
  --installer artifacts/AIPathOfBuilding-AIPoB-Setup.exe \
  --package artifacts/AIPathOfBuilding-AIPoB-windows-x64.zip
```

For contributor setup and release ordering, see
[Development](development.md). For runtime failures, see
[Troubleshooting](troubleshooting.md).
