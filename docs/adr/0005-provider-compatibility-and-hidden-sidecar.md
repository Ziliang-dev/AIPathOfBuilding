# ADR 0005: Resolve provider compatibility before saving and hide the packaged sidecar

- **Status:** Accepted
- **Date:** 2026-08-30
- **Scope:** Provider setup, protocol v3, request encoding, and Windows sidecar launch

## Context

OpenAI-compatible endpoints share a broad HTTP shape, not one complete wire
contract. Providers differ on Chat Completions versus Responses, reasoning
controls, strict tool schemas, continuation fields, authentication, and model
catalog support. A single `reasoning_effort` field cannot make these differences
compatible. The previous 64-token Chat-only connection probe also rejected
reasoning models that spent their small budget before emitting the required tool
call. Packaged PoB launched `node.exe` directly, which exposed a console/taskbar
window when the Planner opened LLM configuration.

## Decision

Increment `PROTOCOL_VERSION` to `3`; keep `SCHEMA_VERSION=2` because Build and
Transaction data contracts do not change. Negotiate `providerCompatibility` and
add `provider.models.list`.

Provider setup exposes presets plus manual endpoint/model entry. Auto mode
resolves official OpenAI endpoints to Responses and all other endpoints to Chat
Completions. Advanced settings may explicitly select either API dialect,
Bearer/no-key authentication, and semantic reasoning `Auto`, `Off`, `Fast`,
`Balanced`, or `Deep`. No-key authentication is accepted only for loopback
endpoints. Model discovery is an optional, bounded OpenAI-compatible `/models`
request; manual entry remains authoritative.

Semantic reasoning is resolved by provider kind and model before testing and
saving. The adapter maps that resolution to Responses `reasoning`, OpenRouter
`reasoning`, DeepSeek `thinking` plus `reasoning_effort`, or generic Chat
`reasoning_effort`. Auto sends no optional reasoning field. Non-OpenAI tool
definitions omit the optional strict marker while local tool-result validation
remains strict.

Connection testing still performs exactly one inference request and never
silently retries another dialect. The fixed probe uses `tool_choice=required`
and a 1024-token output budget. It validates either Chat Completions or Responses
tool-call output. Success creates a ten-minute, one-use test ticket bound to the
canonical endpoint, model, authentication mode, requested/resolved API mode,
reasoning mode, and credential fingerprint. Configure consumes that exact
ticket. Connection-probe authority remains separate from normal data consent.

Reasoning/tool continuation stays inside the ephemeral adapter: Responses
reasoning/function items and DeepSeek `reasoning_content` are returned only to
the same provider on the matching next tool turn. They are not persisted or
exposed through RPC.

The Windows portable includes a small GUI-subsystem native launcher. PoB starts
it with structured arguments; it creates packaged `node.exe` with
`CREATE_NO_WINDOW`, `shell=false` semantics, and inherited secrets disabled.
Older portable layouts without the helper retain direct-Node fallback. CI builds
the helper with MSVC and verifies its PE subsystem, spaced-path launch, ready
file, owner timeout, and absence of visible Node windows.

## Consequences

- Auto mode favors broad interoperability while explicit overrides remain
  available for unusual endpoints.
- No automatic route retry means one click cannot create an undisclosed second
  billable inference request.
- A provider/model without function tools still cannot drive the Planner; the
  test fails before configuration.
- Provider profile version 1 rows migrate to profile version 2 while retaining
  their previous Chat Completions path. Consent is recalculated for the expanded
  descriptor.
- Node, native bindings, WinCred helper, and hidden launcher remain
  installer-owned package components; PoB auto-update ships only the bundle and
  manifest-managed source.

## Superseded details

ADR 0004 remains authoritative for separate one-shot probe consent and secret
handling. This decision supersedes its Chat-only request shape, protocol-v2
compatibility conclusion, and Configure gate definition.
