# Cursor Phase 1 transport decision

Date: 2026-08-14

Status: evidence-complete; ready for Alex's review before Phase 1 specification
and implementation.

## Decision

Use one isolated `@cursor/sdk` Node worker per active Cursor conversation.
Reject `agent acp` as the production transport. Do not retain ACP as a fallback
or second production path.

This is a go for Phase 1 interactive-conversation specification work, not a go
for implementation before the repository's Requirements → Design → Tasks
reviews. It does not authorize a task facet or parity claims.

## Deciding evidence

The decision is lexicographic. ACP fails the first category, so later ACP
advantages cannot override it.

| Priority | Isolated SDK worker | ACP child | Decision effect |
| --- | --- | --- | --- |
| Isolation and cleanup | Pass: two concurrent authenticated workers remained isolated; generation cancel passed; two marked indefinite shell processes were dead after native cancel and before worker cleanup. | Fail: the same marked process shape survived native cancellation, EOF, grace, and complete ACP process-group termination in both trials. | Select SDK; reject ACP. |
| Permissions | Pass for the chosen non-interactive bypass policy with sandbox and auto-review disabled. | Native request/response exists and one-turn bypass worked. | No differentiator because Phase 1 has no native mid-turn approval UI. |
| Continuity | Pass: a new process resumed caller-owned state without replay, retained the model, and rejected stale and cross-cwd refs. | Partial: load recalls context but replays transcript content, accepts cross-cwd refs, and uses global Cursor state. | SDK requires fewer correctness mitigations. |
| MCP | Ordinary inline stdio MCP passed under `settingSources: []`; strict authority remains unproven. | Inline MCP works but ambient MCP remains merged. | SDK supports the Phase 1 path; declare authority unsupported. |
| Models | The authenticated 36-item catalog contained `composer-2.5`; explicit selection and resume passed; invalid id failed without substitution. | Explicit spawn selection works; shared global config can race. | SDK passes the required configuration behavior. |
| Usage and cost | Per-turn token fields were present; settled billed lookup returned `feature_unavailable`. | No usage event observed. | SDK may report tokens; `costUsd` must be `null`. |
| Deployment | Requires an explicit API key, Node >=22.13, the exact SDK package, lazy chunks, dependencies, and matching platform package. | Reuses CLI login but requires a pinned external binary. | SDK burden is acceptable and must be preflighted. |

Detailed observations are in `AUTHENTICATED_EVIDENCE.md`. The final SDK evidence
file had SHA-256
`fffa4595fc8cfdbcd8db680eb203896433a49a2e0f8cc3705a7ff53a70e4df96`.

## Production shape

- Spawn one Node worker for one active conversation. Fix cwd, credentials,
  `CC_*` identity, model, tools, permission policy, and lifecycle at spawn.
- Pass the API key through a private IPC channel, never argv, shared server
  environment, logs, transcript frames, or persisted state.
- Set umask `0077` before SDK initialization and use a caller-owned store under
  Command Center state.
- Preserve the opaque continuation as `{ backend: "cursor", ref }`; bind it to
  the Command Center-owned cwd and reapply model, tools, inline MCP, settings
  sources, and permission policy on resume.
- Write each complete public SDK event into the native transcript envelope
  before normalization. Unknown objects must survive unchanged.
- On abort, call native run cancellation, await bounded disposal, terminate the
  worker process group if needed, and verify cleanup. Treat a cancellation
  response as incomplete until teardown finishes.
- Pin and preflight `@cursor/sdk` plus the matching platform package. The Node
  deployment artifact must satisfy the SDK's Node >=22.13 requirement
  independently of Command Center's broader Node >=20.9 engine range.

## Phase 1 capability declarations

| Capability | Declaration |
| --- | --- |
| Conversation facet | Supported after implementation and acceptance tests. |
| Streaming text/thinking/tool/status events | Supported for observed SDK event classes; preserve unknown native events losslessly. |
| Durable continuation | Supported through adapter-owned opaque SDK refs and caller-owned state. |
| Cancellation | Supported with native cancel plus awaited, verified worker teardown. |
| Model configuration | Default `composer-2.5`; validate custom ids against the live catalog and fail invalid/removed ids without substitution. |
| Token usage | Report stable per-turn SDK fields when present. |
| Cost | `costUsd: null`; settled billed correlation is unavailable. |
| Permission policy | Non-interactive bypass; native mid-turn ask unsupported. |
| MCP | Inline stdio call path supported; authoritative MCP behavior unsupported. |
| Filesystem restriction | `unsupported`. |
| Native fork | Unsupported unless a separate contract passes. |
| Context-window metrics | Unsupported. |
| Managed skills delivery | Unsupported pending live discovery proof. |
| Task facet and governed roles | Not registered in Phase 1. |

## Remaining gates

The Phase 1 implementation must still prove the actual Command Center adapter,
transcript, supervisor, and packaging paths. Acceptance includes unknown and
malformed event handling, file read/edit/write and terminal-error events,
cancel during long MCP execution, corrupt/deleted/already-active refs,
credential failure taxonomy, and production startup/teardown races.

Strict MCP authority needs the separate ambient merge, duplicate-name,
disable/filter, permission, environment, and resume-reapplication matrix.
Filesystem and network confinement, privileged instructions, managed skills,
native fork, task eligibility, and parity remain independent gates.

The existing API-key source was ignored and untracked but had mode `0664` during
the spike. Restrict it to `0600` or remove it after testing; production must use
the Command Center secret-delivery mechanism rather than a worktree file.
