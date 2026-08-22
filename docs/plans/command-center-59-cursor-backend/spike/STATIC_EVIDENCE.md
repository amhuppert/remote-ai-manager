# Cursor transport static and unauthenticated evidence

Date: 2026-08-14

This record covers package, protocol, repository, and unauthenticated runtime
evidence. Authenticated ACP and SDK results now live in
`AUTHENTICATED_EVIDENCE.md`; the final selection is in
`TRANSPORT_DECISION.md`.

## Environment and version findings

- Repository HEAD still matches the bundle baseline
  `fa6bf4306f52926be195bef101e09598494dac3e`.
- Host: Linux x86_64, Node 22.14.0, Bun 1.2.15, Bubblewrap 0.9.0.
- Current npm versions:
  - `@cursor/sdk` 1.0.28;
  - `@cursor/sdk-linux-x64` 1.0.28;
  - `@agentclientprotocol/sdk` 1.3.0.
- The repository has no Cursor SDK dependency or lockfile entry.
- Cursor Agent CLI `2026.08.11-e8db854` is now installed and authenticated;
  this was provisioned after the unauthenticated package experiments below.
- No explicit `CURSOR_API_KEY`, `CURSOR_AGENT_API_KEY`, or
  `CURSOR_AUTH_TOKEN` existed in the session environment. The later live SDK
  fixture used a caller-supplied key through a private file descriptor without
  changing the parent or worker environment.
- The SDK requires Node `>=22.13`; the current host passes, while Command
  Center's general package engine remains Node `>=20.9`. An SDK worker needs an
  independent Node preflight and deployment artifact.
- SDK 1.0.28 was published on 2026-08-13 and is newer than the plan bundle's
  1.0.27 snapshot. Its public type surface is unchanged from 1.0.27, but 1.0.28
  is not yet covered by the SDK changelog. Pin it exactly for the bake-off.

## Unauthenticated experiments

Published npm tarballs were staged manually under `.cc/temp/`; no dependency,
lockfile, Cursor installation, or user credential store was changed.

### SDK package/runtime contract

Command:

```text
node --test .cc/temp/cursor-sdk-probe/sdk-package-contract.test.mjs
```

Result: six passing cases.

- The default Node entry imports and exposes `Agent.create`, `Agent.resume`,
  model discovery, auth status, and caller-owned JSONL storage.
- Auth status works with an isolated in-memory credential store and reports
  logged out without reading a user login.
- The pinned Linux package contains an executable `cursorsandbox` helper.
- A local agent handle can be created with an explicit in-worktree store,
  `settingSources: []`, `tools: []`, and an explicit empty key.
- An explicit empty key produces a local `ConfigurationError` and explicitly
  refuses fallback to ambient credentials.
- The actual local runtime and sandbox support load successfully before the
  empty key stops the turn. The error does not echo the probe prompt.

The explicit `@cursor/sdk/bundled` entry is not directly runnable by Node
22.14: it resolves a `bun:` module. The Node worker must use the normal SDK
entry and ship its lazy chunks, declared dependencies, and matching platform
package, rather than treating the bundled entry as a standalone Node file.

### SDK child isolation contract

Command:

```text
node --test .cc/temp/cursor-sdk-probe/sdk-worker-isolation.test.mjs
```

Result: one passing case with two simultaneous children.

- Each child had a distinct process id, cwd, CC sentinel hash, agent id hash,
  and caller-owned state directory.
- Neither child changed the parent sentinel.
- The SDK handle could be created and closed independently in each process.

The first run exposed a storage-permission issue: JSONL state inherited the
host umask and created transcript-bearing files as `0664`. Starting the worker
with umask `0077` made new state files private and the test green. Production
must enforce private state at process start and verify existing-state modes;
it cannot inherit an arbitrary server umask.

This proves that the intended process-isolation shape can be constructed. It
does not prove authenticated concurrent turns, native cancellation, descendant
cleanup, or restart continuity.

### ACP framing-library contract

Command:

```text
node --test .cc/temp/cursor-acp-probe/acp-ndjson-contract.test.mjs
```

Result: one passing characterization case.

The stock `@agentclientprotocol/sdk` 1.3.0 `ndJsonStream()` helper:

- trims lines before parsing;
- yields parsed objects rather than the original bytes;
- silently drops malformed and primitive frames from the protocol stream; and
- writes the complete rejected line to `console.error` or `console.warn`.

That helper cannot directly satisfy Command Center's lossless transcript and
bounded secret-safe logging requirements. ACP remains viable with a bounded
raw-line tee below the typed router, but that custom framer is required
production work.

## Static candidate comparison

| Decision priority | Isolated SDK worker | ACP child | Current evidence |
| --- | --- | --- | --- |
| Isolation and cleanup | Authenticated concurrent workers, caller-owned private state, generation cancellation, and two marked shell cancellations pass with no survivors. | The installed CLI passes normal close and generation cancel, but authenticated shell cancellation reproducibly leaves a marked tool process alive outside the ACP process group. | SDK passes and ACP fails the highest-priority cleanup gate. |
| Permissions | Headless local SDK has no programmatic human-approval response API. Auto-review denies rather than escalates. | `session/request_permission` is bidirectional and cancellation-aware. | ACP has the stronger native surface, but CC's neutral conversation contract currently has no permission request/response event and Codex uses approval policy `never`. The Phase 1 policy must be deterministic before this advantage can decide the transport. |
| Continuity | Authenticated `Agent.resume()` reattached from a new process, recalled context without replay, rejected stale and cross-cwd refs, and retained the model. | Cursor `session/load` works but replays full history and accepts the ref under a different cwd. | SDK passes with fewer adapter mitigations. |
| MCP authority | A real inline stdio MCP call passed under `settingSources: []`; strict authority remains unclaimed pending ambient/disable/filter cases. | Host-provided stdio MCP works, but ambient configuration is retained and merged. | SDK supports the Phase 1 call path; neither result authorizes a strict authority claim. |
| Models | The 36-entry account catalog contained explicit `composer-2.5`; an invalid id was rejected without substitution and resume retained the selection. | Explicit spawn model and account catalog work, but shared global model persistence can race. | SDK passes the Phase 1 model gate. |
| Usage and cost | Stable per-turn token fields appeared in stream and result; settled billed lookup returned `feature_unavailable`. | No usage event was observed. | SDK may report tokens; both must report `costUsd: null`. |
| Authentication and deployment | Explicit key precedence can refuse ambient fallback; SDK login uses a separate expiring key store. Requires Node 22.13, SDK dependencies, native assets, and a worker artifact. | Reuses CLI login, API key, or auth token; requires a separately installed, pinned, capability-negotiated executable whose update behavior is controlled. | ACP has likely desktop UX advantage; SDK has clearer credential isolation. |
| Implementation burden | Requires worker IPC, packaging, private persistence, and process supervision. | Requires binary preflight, raw-line framing, JSON-RPC routing, replay quarantine, and process supervision. | ACP has less custom application IPC; SDK exposes more required product capabilities directly. |

## Repository integration findings

- `ConversationBackendRuntime.close()` is synchronous, abort calls it
  best-effort, and runtime registration is removed immediately. Either transport
  needs a design for awaited, verified teardown before it can satisfy the
  no-orphan gate.
- The neutral conversation input carries `autonomous: boolean`, but the event
  vocabulary has no permission request/response event. Cursor Phase 1 also
  declares native mid-turn ask unsupported. ACP's permission advantage is not
  usable without either a provider-neutral contract addition or a deliberate
  auto-allow/auto-deny policy.
- ACP load replay must be quarantined from normal transcript persistence and
  SSE broadcast. SDK resume avoids transport-level replay but its real objects
  must still round-trip through Command Center's JSONL transcript boundary.
- Neither public API claim proves lossless persistence: fixtures must pass
  through the actual transcript writer and reader, including unknown fields,
  `undefined`, binary-like values, malformed ACP lines, and large payload
  bounds.

## Final interpretation

Select the isolated SDK worker for Phase 1 and reject ACP. The authenticated
SDK evidence closes the previously unknown isolation, restart, cancellation,
event-preservation, model, and ordinary MCP paths. ACP remains ineligible
because its marked shell process survives both native cancellation and complete
ACP process-group termination.

This is a transport decision, not a parity claim. Native permission prompts,
strict MCP authority, filesystem enforcement, privileged instructions,
settled cost, task eligibility, and unexercised event classes remain unsupported
or separately gated exactly as required by the charter.

## Official sources

- <https://cursor.com/docs/api/sdk/typescript>
- <https://cursor.com/docs/cli/acp>
- <https://cursor.com/docs/cli/reference/authentication>
- <https://cursor.com/docs/cli/reference/permissions>
- <https://cursor.com/docs/reference/sandbox>
- <https://cursor.com/docs/cli/changelog>
- <https://agentclientprotocol.com/protocol/v1/session-setup>
- <https://agentclientprotocol.com/protocol/v1/schema>
- <https://registry.npmjs.org/@cursor/sdk>
- <https://registry.npmjs.org/@agentclientprotocol/sdk>
