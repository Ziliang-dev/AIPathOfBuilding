# Troubleshooting

Start with the exact Planner status or sidecar error. Do not delete user data or
transaction journals while diagnosing an unresolved Apply.

## Quick checks

Run from the repository root:

```powershell
./scripts/check-sidecar.ps1
./scripts/build-sidecar.ps1
./scripts/check-manifest.ps1
```

Confirm PowerShell and tool versions:

```powershell
$PSVersionTable.PSVersion
node --version
pnpm --version
```

## Common failures

| Symptom or error | Likely cause | Check and recovery |
| --- | --- | --- |
| `sidecar/dist/server.cjs missing; run pnpm --dir sidecar build` | Release bundle absent | Run `./scripts/build-sidecar.ps1`, then restart the Planner run |
| `bundled sidecar Node runtime missing` | Non-development launch has no packaged Node runtime | Use a correctly assembled portable package; dev mode may use `node` from `PATH` |
| `Path of Building worker executable missing from runtime directory` | Runtime package is incomplete or executable name is unexpected | Verify the PoB runtime files; rebuild the package rather than copying an arbitrary executable |
| `AIPoBWorker.lua missing` | Program manifest/package omitted worker script | Verify `src/AIPoBWorker.lua` and regenerate the package/manifest |
| `sidecar ready-file timeout` | Sidecar failed before publishing readiness or no owner connected in time | Run the bundle in a terminal with the documented startup arguments and inspect its first error; verify native SQLite load |
| `sidecar protocol version mismatch` | Lua and bundle came from different schema generations | Rebuild `server.cjs` from the checked-out source and update the manifest |
| `sidecar advertised a non-loopback host` | Invalid or untrusted ready file | Stop the launch and inspect the ready file origin; AIPoB accepts only `127.0.0.1` |
| RPC unauthorized or immediately disconnected | Session token mismatch, stale ready file, or mixed processes | Stop the stale process, let the launcher create a new token and ready file, then retry |
| `Persistent SQLite checkpointer is required but unavailable` | `better-sqlite3` or checkpoint native dependency failed to load | Ensure packaged Node major, architecture, module version, and native ABI match; reinstall locked sidecar dependencies for development |
| `SQLite unavailable; using non-persistent in-memory planner store` | Planner database failed but checkpoint database may still be available | Treat run history/cache as process-local; fix the SQLite load before relying on restart history |
| Search warns that external item search is disabled | Trade/catalog broker is not connected | Disable external source controls or continue with current-build search; this is expected in the current baseline |
| Run ends with provider fallback | Model provider is not injected by current CLI | Expected behavior; deterministic search was used |
| No verified candidate | No typed proposal improves the baseline while satisfying Locks, Budget, graph rules, and hard constraints | Relax intended constraints, verify catalog export, and inspect worker diagnostics; do not assume Trade was searched |
| Apply says fingerprint changed | Active Build changed after capture | Start a new run from the current Build; do not bypass fingerprint validation |
| Apply metric mismatch | Candidate could not be reproduced in fresh verification or commit | Keep the active Build unchanged, inspect Scenario inputs and calculator diagnostics, then reproduce with a focused test |
| Transaction reports rollback | An action, rebuild, or final verification failed | Confirm the original fingerprint was restored; inspect reported stage and action ID |
| Transaction journal remains after restart | Apply succeeded locally but sidecar audit was not acknowledged | Allow PlannerController to reconnect and reconcile it; preserve the journal and its backup until recovery finishes |
| Manifest check fails | Tracked bundle or manifest configuration is stale | Rebuild the sidecar, run `./scripts/check-manifest.ps1`, then regenerate `manifest.xml` only as part of the release workflow |

## Sidecar data and ready files

The launcher uses an `AIPathOfBuilding` directory under PoB's user path unless a
different data directory is supplied. It may contain:

- `aipob.sqlite` for planner snapshots, runs, and cache data;
- `checkpoints.sqlite` for LangGraph checkpoints; and
- per-launch `ready-<token-prefix>.json` files.

The ready file contains protocol version, `127.0.0.1`, port, and PID. It does not
contain the session token.

Do not remove a live ready file merely to suppress an error. Identify its PID
and owning process first. Do not delete SQLite data while a sidecar is running.

## Transaction recovery

`AIPathOfBuilding-transaction-journal.json` is stored directly under the PoB
user path. It contains rollback XML while an applied result awaits sidecar
acknowledgement. `.tmp` and `.bak` siblings may appear during atomic rotation.

If the journal is reported invalid or incomplete:

1. Stop further Apply attempts.
2. Preserve the main, backup, and temporary files.
3. Record the active Build fingerprint and save a separate PoB build copy.
4. Reproduce the parsing failure with `TestAIPoBCore_spec.lua` before editing or
   removing recovery data.

Never treat an unverified manual journal deletion as successful recovery.

## Worker diagnosis

A worker job includes Build XML, typed actions, Scenario specifications, and
Condition Evidence. Failures commonly come from:

- an action target absent from the selected item/skill/tree/config set;
- invalid passive point or mastery state;
- Scenario configuration that the sandbox cannot apply;
- missing metrics requested by the Objective;
- worker startup timeout or invalid NDJSON output; or
- a bundle built against code different from the Lua program files.

Add or reduce to a focused Lua spec when the problem is in action application or
PoB calculation. Add a TypeScript worker/controller test when the problem is job
construction, batching, cancellation, framing, or result validation.

## Packaging and native ABI

The portable package must keep these components compatible:

- Node.js 24 x64 runtime;
- installed `better-sqlite3` package;
- its Windows x64 native binding; and
- the bundled `server.cjs`.

Replacing only `node.exe` can break SQLite loading. Build a new package when the
Node major or native dependency changes.

For deeper ownership information, see [Architecture](architecture.md) and
[Development](development.md).
