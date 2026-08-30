# AIPathOfBuilding sidecar

Local TypeScript graph/search process. PoB/Lua remains the calculation authority.
The process listens only on IPv4 loopback and accepts authenticated, versioned,
newline-delimited JSON-RPC 2.0.

See the repository [current architecture](../docs/aipob/architecture.md) and
[capability matrix](../docs/aipob/status-and-roadmap.md) for system-level status.

## Development

Requires Node.js 22.13 or newer and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` emits the release entry point at `dist/server.cjs`. The JavaScript
bundle deliberately externalizes `better-sqlite3`; a release must place the
installed `better-sqlite3` package and its matching Windows x64 native binding
beside the bundled Node runtime in its normal `node_modules` layout. If the
planner run store cannot load SQLite, the sidecar warns and uses non-persistent
in-memory run storage. The production LangGraph checkpoint store has a stricter
policy: if its persistent SQLite saver cannot load, sidecar startup fails. It
does not silently advertise restart-resumable interrupts backed only by memory.

## Startup contract

```bash
node dist/server.cjs \
  --host 127.0.0.1 \
  --port 0 \
  --session-token '<random-secret-at-least-32-characters>' \
  --data-dir '<absolute-directory>' \
  --ready-file '<absolute-json-path>' \
  --pob-executable '<absolute-PathOfBuilding.exe>' \
  --worker-script '<absolute-AIPoBWorker.lua>' \
  --worker-count 4
```

After binding, the server atomically writes the ready file as
`{"protocolVersion":3,"host":"127.0.0.1","port":...,"pid":...}`. The session
token is never persisted there. Delete or replace a stale ready file before
launching a new process.

The deprecated `--worker-command` escape hatch accepts only one JSON argv array,
for example `'["PathOfBuilding.exe","src/AIPoBWorker.lua"]'`. It is passed to
`spawn()` with `shell:false`; raw shell command strings are rejected.

RPC methods also include provider status/configuration, optional model discovery,
one-shot connection testing, consent, and objective drafting. Core run methods
are `hello`, `build.capture`, `run.start`, `run.stream`, `run.cancel`,
`run.resume`, `candidate.preview`, and `transaction.result`. Server notifications
are `run.progress`, `run.awaitingApproval`, `transaction.apply`, `run.completed`,
and `run.failed`.

The shipped CLI starts with `providerConfigured=false` until the PoB setup UI
tests and saves a profile through Windows Credential Manager. It never reads or
writes a plaintext API-key file or environment variable. Without matching
first-send consent, the deterministic domain schedule remains available.
