# ADR 0004: Authorize provider connection probes without granting data consent

- **Status:** Accepted
- **Date:** 2026-08-29
- **Scope:** Provider setup, consent, credentials, and additive protocol-v2 RPC

## Context

Saving an endpoint, model, and API key without testing them delays authentication,
model-name, Chat Completions, and tool-calling failures until Planner Chat or an
optimization. Reusing normal first-send consent for a setup test would imply that
Build or chat data is authorized even though the test needs only fixed synthetic
content. Persisting unsaved fields or raw provider responses would also broaden
the credential and diagnostic attack surface.

## Decision

Keep `PROTOCOL_VERSION=2` and `SCHEMA_VERSION=2`. Negotiate the additive
`providerConnectionTest` capability and expose `provider.test.preview` plus
`provider.test`.

The preview binds provider ID, canonical endpoint, model, privacy/redaction policy
versions, the non-default `connection_probe` category, and the hash of one fixed
synthetic payload. The sidecar stores this authorization only in memory and
consumes it before one matching test attempt.

The test makes one bounded OpenAI-compatible Chat Completions request with a
forced `aipob_connection_probe` tool call. It sends no Build or Planner Chat data.
The result contains only success, latency, requested/response model, tool-call
validation, and optional token usage. Provider errors are redacted; keys and raw
responses are not logged or persisted.

The UI enables Configure only after the exact current endpoint, model, and key
selection passes. Editing a field invalidates the result. A blank key may reuse a
saved WinCred credential only when the canonical endpoint is unchanged. Testing
or configuration failure leaves the saved profile, key, and durable consent
unchanged.

Connection-probe authorization never becomes a consent record and never grants
permission to send Build or chat data. Successful Configure continues into the
existing first-send consent flow.

## Considered options

- **Save first and test later:** rejected because invalid settings would replace
  a usable profile and credential before validation.
- **Use normal provider consent for the probe:** rejected because synthetic setup
  traffic and user data need different authority and lifetime.
- **Return raw provider responses for diagnosis:** rejected because they can
  contain provider-controlled or sensitive content and are unnecessary for a
  compatibility decision.
- **Increase protocol version:** rejected because the new methods are capability-
  negotiated and do not change existing method semantics.

## Consequences

- Providers must support non-streaming Chat Completions and forced function tool
  calling to pass setup.
- A real probe may incur a small provider fee and the UI must disclose that fact.
- Older sidecars remain protocol-v2 peers but cannot expose the negotiated test
  capability; Configure remains unavailable in the new UI until a compatible
  sidecar is connected.
- Tests must prove exact descriptor/payload binding, one-shot consumption,
  non-persistence, key-reuse restrictions, error redaction, and timeout behavior.

## Current implementation

The Lua Planner UI/controller, TypeScript provider service/controller/router,
schemas, tests, documentation, and Windows package path implement this decision.
See [Architecture](../aipob/architecture.md),
[Domain rules](../aipob/domain-rules.md), and
[Status and roadmap](../aipob/status-and-roadmap.md).
