# Troubleshooting

Start with the exact Planner status or sidecar error. Do not delete user data or
transaction journals while diagnosing an unresolved Apply.

## Quick checks

Run from the repository root:

```bash
python3 scripts/aipob.py check-sidecar
python3 scripts/aipob.py build-sidecar
python3 scripts/aipob.py check-manifest
```

Confirm WSL and tool versions:

```bash
python3 --version
node --version
pnpm --version
```

## Common failures

| Symptom or error | Likely cause | Check and recovery |
| --- | --- | --- |
| `sidecar/dist/server.cjs missing; run pnpm --dir sidecar build` | Release bundle absent | Run `python3 scripts/aipob.py build-sidecar`, then restart the Planner run |
| `bundled sidecar Node runtime missing` | Non-development launch has no packaged Node runtime | Use a correctly assembled portable package; dev mode may use `node` from `PATH` |
| `Path of Building worker executable missing from runtime directory` | Runtime package is incomplete or executable name is unexpected | Verify the PoB runtime files; rebuild the package rather than copying an arbitrary executable |
| `AIPoBWorker.lua missing` | Program manifest/package omitted worker script | Verify `src/AIPoBWorker.lua` and regenerate the package/manifest |
| `sidecar ready-file timeout` | Sidecar failed before publishing readiness or no owner connected in time | Run the bundle in a terminal with the documented startup arguments and inspect its first error; verify native SQLite load |
| `sidecar protocol version mismatch` | Lua and bundle came from different schema generations | Rebuild `server.cjs` from the checked-out source and update the manifest |
| `sidecar advertised a non-loopback host` | Invalid or untrusted ready file | Stop the launch and inspect the ready file origin; AIPoB accepts only `127.0.0.1` |
| RPC unauthorized or immediately disconnected | Session token mismatch, stale ready file, or mixed processes | Stop the stale process, let the launcher create a new token and ready file, then retry |
| `Persistent SQLite checkpointer is required but unavailable` | `better-sqlite3` or checkpoint native dependency failed to load | Ensure packaged Node major, architecture, module version, and native ABI match; reinstall locked sidecar dependencies for development |
| `SQLite unavailable; using non-persistent in-memory planner store` | Planner database failed but checkpoint database may still be available | Treat run history/cache as process-local; fix the SQLite load before relying on restart history |
| Search reports a Trade warning | Missing Budget/league, PoB Trade authentication, rate limit, network, or query failure | Check the exact warning and PoB Trade state; local search continues, so do not assume the run included external items |
| `Import a build or add an active main skill before search` | The selected main socket group is absent, disabled, or has no enabled active skill | Import a Build or configure and select an active main skill; level 1 by itself is not an error |
| LLM Setup shows `Sidecar: failed` | Sidecar launch, ready-file, native dependency, or handshake failed | Read the displayed error, fix the exact package/runtime mismatch, then use **Retry Sidecar**; opening setup never starts an optimization |
| Opening LLM Setup shows a Node console/taskbar window | Portable predates the GUI-subsystem sidecar launcher or omitted it | Sync a successful current CI portable containing `sidecar/runtime/aipob-sidecar-launcher.exe`; do not install a local Node runtime |
| **Test Connection** is disabled | Sidecar is not connected, endpoint/model is empty, or neither an entered nor same-endpoint saved key exists | Wait for `Sidecar: connected`; fill the fields and key as required; hover the disabled control for its reason |
| Connection test returns 401/404/429, timeout, or tool-call error | Bad key, endpoint/model mismatch, rate limit, provider timeout, exhausted reasoning budget, or missing tool support | Keep API/Reasoning on Auto first; try Reasoning Fast for a reasoning-heavy model; verify the selected model exposes function tools. Failure does not overwrite saved profile or key |
| Trade item cannot be applied | Stale Build fingerprint, slot mismatch, changed catalog item, or content-hash mismatch | Start a new run from the current Build; never bypass `importAndEquip` source/hash validation |
| Provider status is unconfigured | No OpenAI-compatible profile or LLM credential | Configure endpoint, model, and key in Planner provider setup; do not use `.env` or project files |
| Provider consent is required | First call, changed endpoint/model/policy, or revoked consent | Review the redacted consent preview and grant it only if its exact destination and categories are acceptable |
| Credential helper fails | WinCred helper missing, wrong architecture, or target outside `AIPathOfBuilding/LLM/*` | Use a verified Windows package; never broaden the namespace or move PoE OAuth secrets into the helper |
| Run ends with provider fallback | Provider is absent, unconsented, unavailable, or returned an invalid response | Inspect provider status/error; deterministic search remains available |
| No verified candidate | No typed proposal improves the baseline while satisfying Locks, Budget, native proof, graph rules, and hard constraints | Relax intended constraints, verify catalog/Trade warnings, and inspect worker diagnostics |
| Apply says fingerprint changed | Active Build changed after capture | Start a new run from the current Build; do not bypass fingerprint validation |
| Apply metric mismatch | Candidate could not be reproduced in fresh verification or commit | Keep the active Build unchanged, inspect Scenario inputs and calculator diagnostics, then reproduce with a focused test |
| Transaction reports rollback | An action, rebuild, or final verification failed | Confirm the original fingerprint was restored; inspect reported stage and action ID |
| Transaction journal remains after restart | Apply succeeded locally but sidecar audit was not acknowledged | Allow PlannerController to reconnect and reconcile it; preserve the journal and its backup until recovery finishes |
| Manifest check fails | Tracked bundle or manifest configuration is stale | Rebuild the sidecar, run `python3 scripts/aipob.py check-manifest`, then regenerate `manifest.xml` only as part of the release workflow |
| A verified CI portable shows **Dev Mode** | Its packaged `manifest.xml` lacks the exact update branch or `platform="win32"`, or the payload predates the package verifier | Reject that artifact and sync a newer successful run; do not edit the repository manifest to hide the warning |
| A CI portable reports `Invalid local manifest` | The payload predates package-root manifest resolution, or its root `manifest.xml` is missing | Sync a successful artifact containing `Modules/AIPoB/UpdatePaths.lua`; verify the root manifest instead of copying it into `src` |

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

- Node.js 24.20.0 x64 runtime and ABI 137;
- installed `better-sqlite3` package;
- its Windows x64 native binding; and
- the WinCred helper;
- the GUI-subsystem hidden sidecar launcher; and
- the bundled `server.cjs`.

Replacing only `node.exe` can break SQLite loading. Rebuild and reverify the
canonical portable ZIP and NSIS installer when Node or a native dependency
changes. Compare installer output with the ZIP checksums; do not repair an
incomplete install by copying arbitrary runtime files.

For deeper ownership information, see [Architecture](architecture.md) and
[Development](development.md).
