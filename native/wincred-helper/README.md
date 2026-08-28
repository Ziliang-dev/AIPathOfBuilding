# WinCred helper

`wincred-helper.exe` is a self-owned, Windows-only JSON-lines bridge to
Windows Credential Manager. It reads one request per stdin line and writes one
response per stdout line. API keys stay in Credential Manager and are never
passed as command-line arguments.

Supported operations: `get`, `has`, `set`, `delete`. The sidecar invokes the
helper with `stdio` pipes and suppresses stderr. Build from a Visual Studio
Developer PowerShell with `./build.ps1`.
