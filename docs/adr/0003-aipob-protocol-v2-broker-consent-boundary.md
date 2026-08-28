# ADR 0003: Bind brokers, native proof, and provider consent to protocol v2

- **Status:** Accepted
- **Date:** 2026-08-29
- **Scope:** Cross-process protocol, external services, proof, credentials, and packaging

## Context

Trade catalog lookup, native link probing, richer Build Actions, and model
provider setup cross the PoB/sidecar boundary. They introduce secrets, external
data, reverse RPC, and evidence that can become stale. Protocol v1 did not name
these contracts and could not safely imply them without changing its meaning.

## Decision

Increment `SCHEMA_VERSION` and `PROTOCOL_VERSION` to 2. Both processes must
reject a mismatched peer.

Protocol v2 uses these boundaries:

- PoB owns Trade authentication, OAuth, rate limits, seller identity, raw Trade
  responses, and typed query construction. The sidecar receives sanitized typed
  catalog items and may emit only validated, fingerprint-bound
  `importAndEquip` actions.
- Every proposed skill link must pass a native PoB probe. Accepted evidence is
  complete, non-truncated, scenario-bound, and proof-fingerprint-bound.
- Actor and season changes use typed actions and adapters for their owning
  ruleset. No raw Lua or unvalidated mutation path is added.
- Only LLM API keys use Windows Credential Manager, under
  `AIPathOfBuilding/LLM/<providerId>`. PoE Trade OAuth remains in PoB.
- The first provider call requires consent bound to the endpoint, model, data
  categories, redaction/privacy policy, and redacted payload. Profile changes
  invalidate consent.
- Portable and NSIS artifacts use one canonical staged payload pinned to Node
  24.20.0 x64 / ABI 137 and verified native dependencies.

## Considered options

- **Extend protocol v1 in place:** rejected because it would silently change
  compatibility and security meaning.
- **Move Trade or PoE credentials into the sidecar:** rejected because PoB is
  the existing authority for Trade identity and rate limiting.
- **Store the LLM key in SQLite or environment files:** rejected because those
  paths expose a reusable secret to project and diagnostic data.
- **Trust generated compatibility claims:** rejected because Candidate proof
  must come from the native PoB engine used for evaluation.
- **Build installer and portable payloads independently:** rejected because
  their contents could drift without a single hash-verifiable staging source.

## Consequences

- Lua schemas, TypeScript schemas, JSON-RPC methods, actions, and tests must stay
  aligned at version 2.
- Trade failure degrades to a warning and local search; it does not weaken
  Candidate validation.
- Provider use remains optional. Missing or revoked consent preserves
  deterministic fallback.
- A Node/native ABI change requires a new verified package, not an auto-update
  of installer-owned components.
- Release readiness requires the Golden corpus, cross-language tests, Windows
  package verification, fault injection, restart recovery, and real process
  E2E gates.

## Current implementation

Protocol v2, reverse Trade RPC, native proof, actor/season actions, LLM-only
WinCred storage, consent, Planner Chat, model injection, canonical packaging,
and release gates are connected in this working tree. Publication, signing, and
a successful release-workflow artifact remain release operations. See
[Architecture](../aipob/architecture.md) and
[Status and roadmap](../aipob/status-and-roadmap.md).
