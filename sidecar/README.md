# AIPathOfBuilding sidecar

Local TypeScript graph/search process. PoB/Lua remains the calculation authority.
The process listens only on IPv4 loopback and accepts authenticated, versioned,
newline-delimited JSON-RPC 2.0.

## Development

Requires Node.js 22.13 or newer and pnpm.

```powershell
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` emits the release entry point at `dist/server.cjs`. The JavaScript
bundle deliberately externalizes `better-sqlite3`; a release must place the
installed `better-sqlite3` package and its matching Windows x64 native binding
beside the bundled Node runtime in its normal `node_modules` layout. If the
native module cannot load, the sidecar warns and uses in-memory run storage and
a LangGraph `MemorySaver`; optimization still runs, but restart persistence is
unavailable.

## Startup contract

```powershell
node dist/server.cjs `
  --host 127.0.0.1 `
  --port 0 `
  --session-token <random-secret-at-least-32-characters> `
  --data-dir <absolute-directory> `
  --ready-file <absolute-json-path> `
  --pob-executable <absolute-PathOfBuilding.exe> `
  --worker-script <absolute-AIPoBWorker.lua> `
  --worker-count 4
```

After binding, the server atomically writes the ready file as
`{"protocolVersion":1,"host":"127.0.0.1","port":...,"pid":...}`. The session
token is never persisted there. Delete or replace a stale ready file before
launching a new process.

The deprecated `--worker-command` escape hatch accepts only one JSON argv array,
for example `'["PathOfBuilding.exe","src/AIPoBWorker.lua"]'`. It is passed to
`spawn()` with `shell:false`; raw shell command strings are rejected.

RPC methods: `hello`, `build.capture`, `run.start`, `run.stream`, `run.cancel`,
`run.resume`, `candidate.preview`, and `transaction.result`. Server notifications
are `run.progress`, `run.awaitingApproval`, `transaction.apply`, `run.completed`,
and `run.failed`.

The shipped CLI intentionally starts with `providerConfigured=false` and uses
the deterministic domain schedule. It never reads or writes a plaintext API-key
file or environment variable. A future PoB credential UI must use Windows
Credential Manager before enabling the included OpenAI-compatible adapter.
