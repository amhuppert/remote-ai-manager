# Implementation brief

## Objective

Add Cursor as Command Center's third registered agent backend without weakening
the backend seam or overstating Cursor's safety/capability guarantees.

The useful first product outcome is ordinary interactive Cursor conversations:
selection, streaming, durable continuation, cancellation, transcripts,
auth/preflight, model configuration, settings/UI integration, and tests. A
production-scoped task facet follows only behind explicit eligibility gates.
Full parity is vendor/security-gated and is not part of the initial commitment.

## Settled decisions

| Area | Decision |
| --- | --- |
| Transport | Select through an authenticated spike: per-conversation isolated `@cursor/sdk` Node worker versus per-conversation `agent acp` child. An inline SDK loop in the CC server is ineligible. |
| Isolation | One child/worker per active conversation, with `CC_*`, credentials, cwd, and process lifecycle fixed at spawn. Never mutate shared server `process.env`. |
| Print mode | Last-resort research fallback only; not a preferred production transport. |
| Continuity | Persist Cursor's session/agent id only as opaque `AgentSessionRef.ref`; the adapter alone interprets it. |
| Native events | Normalize operational events above the seam while preserving every native event losslessly in transcript envelopes. |
| Structured output | `post_validation`, using the existing shared extraction, schema validation, and bounded repair path. |
| Queueing | Next-turn queueing only until the transport proves stronger semantics. |
| Fork | Synthetic or unsupported; never claim native fork without a documented, verified API. |
| Models | No static curated Cursor catalog. MVP: one proven default plus validated custom IDs. Production: an explicitly scoped asynchronous account/team catalog extension. |
| Speed/params | Do not add `cursorFastMode`. Defer model-specific params or generalize the leaked `codexFastMode` channel through an approved migration. |
| Usage/cost | Report token usage synchronously when available. Report `costUsd` only when billed cost is settled and correlated to the turn; otherwise `null`. Never estimate Cursor cost from tokens. |
| Managed skills | Generalize the existing `.agents/skills` bridge only after a live Cursor discovery test. Declare the honest delivery mode before that work lands. |
| MCP | ACP stdio is the v1 baseline; HTTP/SSE are optional capabilities. Do not claim authoritative MCP until ambient config, disable, filtering, and approval semantics are proven. |
| Filesystem | Declare both conversation and task `fsWriteRestriction: "unsupported"` until the per-platform adversarial suite passes. |
| Instructions | Ordinary conversations may prepend first-turn instructions at Codex-equivalent fidelity. Do not equate this with a privileged system/developer channel. |
| Tasks | Phase 1 registers the conversation facet only. A later task facet is restricted at selection time to explicitly nongoverned task profiles. |
| Collaboration | Out of scope. Collaboration Mode remains the intentional Claude×Codex pair (decision D19). |
| Persistence | No SQLite migration is expected for the backend id/ref columns. Extend canonical schemas, session-ref codec maps/arms, and durable round-trip tests. |

## Non-negotiable early fix

Before adding `"cursor"` to the canonical backend enum, fix both handlers in
`src/lib/commands/route-handlers.ts` that currently coerce every non-Codex
backend to Claude. Parse the query value with the canonical backend schema and
return a client error for an unknown backend. Add tests for valid Claude,
Codex, and unknown values. Once Cursor exists, add its valid case.

This can land independently and prevents a third id from silently receiving
Claude command discovery behavior.

## Delivery levels

### Phase 0 — authenticated decision spike (2–4 days)

Produce fixtures and a written decision table comparing the isolated SDK worker
and ACP child. The result must select one production transport. Required
evidence is detailed in `EXECUTION_PLAN.md`.

### Phase 1 — interactive conversations (~3 weeks cumulative)

- Cursor descriptor/metadata with a conversation facet only.
- Winning per-conversation transport and process cleanup.
- Create/load or create/resume continuity, stale-ref classification, streaming,
  cancellation, transcript envelopes, auth/preflight, model selection, config,
  catalog, UI, and command discovery.
- Conservative declarations: post-validation structured output, synthetic or
  unsupported fork, next-turn queueing, no external turns, no native mid-turn
  ask, no context-window claim unless proven, and filesystem restriction
  unsupported.
- Parameterized conformance, consumer-locality, persistence/codec, API, UI, and
  live restart/cancel verification.

### Phase 2 — production-scoped backend (4–6 weeks cumulative, ±30%)

- Managed skills after live discovery proof.
- Authoritative MCP behavior after merge/filter/disable semantics are proven.
- Images.
- Async account/team model catalog seam.
- Token usage and settlement-aware billed cost.
- A task facet restricted by an explicit, code-enforced eligibility predicate
  to nongoverned profiles.
- Lifecycle, version-churn, auth, and live hardening.

### Parity — independent gates

Only after both gates pass may Cursor become eligible for validators,
ownership-confined roles, or charter-governed tasks:

1. A privileged instruction channel above user priority.
2. Exact filesystem confinement proven on each claimed platform.

If Cursor supplies both capabilities, enabling the remaining declarations is
estimated at another 1–2 weeks. That work is not schedulable before the vendor
and security evidence exists.

## Phase 1 acceptance gates

- Two concurrent Cursor conversations demonstrate distinct `CC_*` identities,
  credentials, cwd, refs, and process trees.
- Create → prompt → process death → new process → load/resume → prompt succeeds
  without duplicate persisted content.
- Stale/deleted/corrupt refs produce normalized recovery or terminal failures,
  according to the declared continuity contract.
- Cancellation works during generation, shell execution, and permission wait;
  bounded graceful cancellation escalates to process-group termination with no
  orphan children.
- Unknown and changed native events are retained losslessly and do not crash the
  runtime.
- Auth failures, missing/old binary or SDK runtime, and enterprise-disabled
  headless operation fail preflight clearly without logging secrets.
- Default model and validated custom IDs work; an invalid/disappeared model has
  an actionable error and never silently changes providers/models.
- Cursor remains absent from Collaboration Mode and from task/validator
  selection in this phase.
- `fsWriteRestriction` remains unsupported unless the exact adversarial suite
  independently passes and the declaration is reviewed.
- Backend conformance, consumer-locality, session-ref round trips, config/API,
  and focused UI tests pass; seam baselines change only for reviewed policy
  survivors.

## Project-process constraints

The bundled `sources/project-context/AGENTS.md` remains controlling. In
particular:

- The Kiro Requirements → Design → Tasks → Implementation approvals are not
  implied by this handoff.
- Read the logging steering before adding logs and use `createLogger` with a
  stable module/event vocabulary.
- Do not use `vi.mock()` for internal modules; put a small injected provider
  port around Cursor transport/process behavior.
- Do not implement backward compatibility or config migration behavior without
  Alex's explicit approval.
- Keep Collaboration Mode's Claude×Codex identity branches; they are product
  policy, not evidence that neutral runtime code may branch on provider.

