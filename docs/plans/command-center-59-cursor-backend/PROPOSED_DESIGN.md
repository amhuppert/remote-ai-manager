# Proposed design

## Shape

```text
Neutral CC conversation callers
            |
            v
AgentBackendDescriptor("cursor")
            |
            v
CursorConversationRuntime
  - continuity adapter
  - event/result projection
  - failure classification
  - runtime config translation
            |
            v
CursorTransport port (testable boundary)
            |
            +--> isolated Node SDK worker, one per conversation
            |
            `--> ACP child, one per conversation

Only the transport selected by the spike becomes production code.
```

All Cursor-native behavior stays under `src/lib/agent-backends/cursor/`.
Neutral consumers continue to depend on the existing descriptor, conversation,
continuity, transcript, MCP, runtime-config, task, and error contracts.

## Transport decision boundary

Use a narrow internal port for the spike and adapter tests. It should expose
only the operations the neutral runtime needs: preflight/capability discovery,
create or load a session, issue a prompt and stream native events, cancel the
active operation, close the transport, and query models/usage only if the
chosen surface supports them.

The port is a test seam, not a new cross-provider framework. Keep it inside the
Cursor adapter. Inject it into production mapping/lifecycle code so tests can
exercise real adapter logic without mocking internal modules.

The spike compares:

- Isolated SDK worker: a Node >=22.13 child owns `@cursor/sdk`, credentials,
  checkpoint access, and one conversation. Use a small typed IPC protocol. The
  CC server never imports/runs the SDK loop inline and never mutates its own
  environment for a conversation.
- ACP child: spawn `agent acp`; communicate over stdio JSON-RPC, preferably via
  the official ACP TypeScript client. Treat stdout as protocol-only and stderr
  as bounded diagnostic output.

Decision order: environment isolation and cleanup; permission behavior;
continuity; MCP authority; models; usage/cost; auth; implementation burden.
Bun compatibility is a packaging check, not the leading architectural factor.

## Process and environment lifecycle

- One transport process belongs to one active Command Center conversation.
- Spawn with the conversation worktree as cwd and pass the same absolute cwd to
  Cursor session creation/load. CC remains the sole worktree owner; do not ask
  Cursor to create nested worktrees.
- Build the environment through the existing child/session environment helpers
  so `CC_*`, `cctl` path, PATH, and credentials are fixed before spawn.
- Never put secrets in argv, logs, transcript raw frames, or error messages.
- On abort: request native cancel, wait a bounded grace period, terminate the
  process group, then verify child cleanup. EOF and unexpected exit are
  classified through the Cursor failure classifier.
- Validate the host-installed `agent`/legacy `cursor-agent` binary carefully;
  never confuse it with the editor's `cursor` launcher. Do not auto-install or
  auto-update Cursor.
- Pin a minimum-tested date+hash version and feature-negotiate capabilities.

## Continuity

Persist `{ backend: "cursor", ref: <opaque id> }`. The owning adapter chooses
`Agent.resume()` or ACP `session/load`; no caller parses the ref or knows which
transport produced it.

The continuity adapter owns:

- new session creation;
- ref membership/shape validation;
- load/resume after runtime eviction or server restart;
- stale/deleted/corrupt ref classification and recovery policy;
- synthetic fork seed creation if Phase 1 declares synthetic fork.

ACP currently advertises `loadSession: true` and no `session/resume`; replay is
therefore through `session/load`, with deduplication verified by fixtures.

## Events, transcript, and results

Map native updates to the existing neutral conversation event vocabulary for
UI/runtime behavior. Independently write a lossless raw envelope for every SDK
event object or ACP line/update.

- Unknown methods/fields are preserved, not discarded or treated as fatal.
- Capture real authenticated fixtures before finalizing projection logic.
- Preserve enough ordering/correlation data to diagnose permissions, tools,
  subagents, usage, cancellation, and terminal failures.
- Keep bounded stderr separate from protocol events.
- `post_validation` structured output reuses the shared schema prompt,
  extraction, validation, and one-turn repair machinery. Do not add a
  Cursor-specific JSON parsing pipeline.

## Capability declaration for Phase 1

Proposed conservative values:

| Capability | Phase 1 value |
| --- | --- |
| queue | `acceptsWhileRunning: false`, `deliveryTiming: "next_turn"` |
| continuation | `precise_session` only after kill/load proof; otherwise do not ship continuation |
| fork | `synthetic` if its contract passes, else `unsupported` |
| structured output | `post_validation` |
| context window metrics | `false` unless stable authenticated evidence exists |
| native mid-turn ask | `false` |
| external turns | `false` |
| capability kinds | empty for Phase 1 |
| conversation filesystem restriction | `unsupported` |
| task facet | absent |
| managed skills | honest current state; do not declare `bundled` before delivery is proven |

Descriptor declarations are executable promises. Conformance tests must prove
the observed behavior matches each value.

## Models and backend-specific options

Cursor's catalog is account/team-specific and changes independently of CC.

- Phase 1 ships a proven default plus a non-empty custom model ID flow.
- Reject model IDs known to belong to another backend; preserve Cursor IDs that
  are unknown to the static CC catalog.
- Do not silently substitute a removed model.
- Phase 2 may add an async Cursor catalog source without making the existing
  synchronous client-safe catalog perform I/O.
- Do not add `cursorFastMode`. Model params/speed belong in a generalized,
  backend-owned options channel. Any migration from `codexFastMode` requires a
  separately approved compatibility design.

## Usage and billed cost

Normalize stable per-turn token usage immediately. Cursor pricing is plan-based,
so token pricing tables are inappropriate.

Only attach `costUsd` when the selected transport exposes a settled billed
charge that can be correlated to the turn without ambiguity. If settlement is
delayed or correlation is uncertain, keep cost null and reconcile through a
later explicitly designed mechanism; do not guess.

## MCP

For the ACP path, stdio MCP is baseline in ACP v1; the `{http, sse}` flags
describe optional transports. For either winning transport:

- translate only from CC's portable MCP input below the seam;
- test whether project/user Cursor config is merged with or overrides inline
  servers;
- prove disable, tool filtering, permission, and between-turn apply semantics;
- never mutate user or project Cursor config as a suppression mechanism;
- declare `strictAuthoritativeConfig: false` and conservative unsupported modes
  until authority is proven.

## Managed skills

Cursor natively discovers `.agents/skills/`. Generalize the content-addressed,
ownership-attested bridge now implemented for Codex rather than creating a
parallel unmanaged copy.

The bridge must retain its safety properties: adapter-owned path only,
collision refusal, atomic reconciliation, ignored/excluded generated link, and
live verification that headless Cursor actually discovers the managed Command
Center skills. Until then, the descriptor must not claim bundled delivery.

## Filesystem and governed-role eligibility

Cursor's sandbox primitives are promising but are not evidence of CC's exact
write-envelope contract. Both conversation and task facets stay unsupported
until a per-platform suite defeats all of these attempts:

- direct edit/write tool outside allowlist;
- shell write outside allowlist;
- absolute and temp-path writes;
- symlink traversal/escape;
- nested processes and inherited descriptors;
- overlapping allow/deny with deny precedence;
- writes through MCP/custom tools where applicable.

Privileged instructions are a separate gate. Root project files and first-user
prompt prepending are not a system/developer channel. Governed tasks and
validators require both gates, not either one.

When the Phase 2 task facet is added, enforce its initial nongoverned eligibility
in the selection/resolution code. Documentation-only restrictions are
insufficient. The predicate should be testable against every task profile and
should fail closed for unknown/governed profiles.

## Closed-world registration work

Adding `"cursor"` to `agentBackendSchema` is deliberately not the first change.
Once the runtime is viable, update the enum, descriptor registry, config
profiles/default materialization, client-safe catalog and capability maps, MCP
registry, session-ref codec maps and round trips, settings UI, backend tones,
command discovery, workflow assignment, and other catalog-driven selectors as
one coherent product slice.

Keep provider identity branches only inside adapters or at explicit product
selection sites. Collaboration Mode's Claude×Codex pair remains unchanged.
Run the seam ratchet and review every changed survivor rather than mechanically
raising baselines.

## Logging

Use the project logging system and read `sources/project-context/logging-steering.md`
before implementation. Suggested stable module families are
`agent-backends.cursor.transport`, `agent-backends.cursor.conversation`,
`agent-backends.cursor.continuity`, and `agent-backends.cursor.preflight`.
Log lifecycle and correlation metadata, negotiated capabilities, normalized
failure class, and cleanup outcomes. Never log prompts, credentials, raw auth
responses, or unbounded stderr/native payloads.

