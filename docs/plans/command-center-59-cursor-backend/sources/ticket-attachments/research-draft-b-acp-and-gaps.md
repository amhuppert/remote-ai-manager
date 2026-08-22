# Cursor CLI as a Third Command Center Backend

Alex, this is feasible, and Cursor's current CLI has a substantially better integration surface than a headless-output wrapper would suggest. My recommendation is to integrate Cursor through its native Agent Client Protocol server (`agent acp`), initially as an ordinary conversation backend, and only advertise workflow capabilities after proving its security and instruction-delivery contracts.

The level-of-effort verdict is:

- **Medium effort for a useful interactive third backend:** about **8–15 engineering days after a short spike**, or roughly **3 weeks total** for one senior engineer.
- **Medium-high effort for a production conversation-and-task backend:** about **20–35 engineering days total**, or **4–7 weeks**.
- **High effort for full Claude/Codex parity:** about **6–10+ weeks**, with two parity items potentially blocked by the current Cursor surface rather than merely requiring more code.

The important distinction is scope. A user being able to choose Cursor, stream a turn, cancel it, and resume it is tractable. Calling Cursor a drop-in peer for graph validators, ownership-confined workflow lanes, all capability cascades, and Collaboration Mode is not.

## Recommended budget

The estimates below are cumulative unless marked otherwise. They assume one senior engineer familiar with Command Center, and include unit/conformance coverage, structured logging, failure handling, UI/config work, and live verification.

| Delivery level | Included | Estimate | Confidence |
| --- | --- | ---: | --- |
| Authenticated feasibility spike | ACP handshake, model/session behavior, cancellation, MCP, permissions, write-envelope attacks | 2–4 days | Medium |
| Interactive conversation MVP | Spike plus selectable backend, new/load sessions, streaming, tool rows, cancellation, auth/preflight, model selection, transcript/failure projection, config/UI, focused tests | 8–15 days after spike | Medium |
| Production third backend | Conversation MVP plus generic task facet, images, managed skills, MCP, structured-output fallback, dynamic account models, lifecycle hardening, conformance/live tests | 20–35 days total | Medium-low until spike |
| Full feature parity | Exact filesystem confinement, privileged governance instructions, confined graph roles, complete capability management, and any Cursor-aware Collaboration redesign | 6–10+ weeks total | Low until spike; potentially blocked |

I would plan **4–7 engineer-weeks** if “third backend” means a credible production option for normal conversations and generic one-shot tasks. I would not commit to workflow-validator or full-parity dates until the spike resolves the two go/no-go issues described below. The estimate should be treated as roughly ±30% before authenticated testing.

## What the Cursor CLI provides today

As of 2026-08-12, the official installer serves build `2026.08.11-e8db854`. Cursor documents macOS, Linux, WSL, and native Windows support. The install exposes `agent` and a legacy `cursor-agent` alias; this is separate from the Cursor editor launcher commonly named `cursor`.

There are two programmatic surfaces.

### 1. ACP: the right production surface

`agent acp` runs a persistent server over stdio using newline-delimited JSON-RPC 2.0. Cursor documents the lifecycle as:

1. `initialize`
2. authenticate or use existing login/API-key credentials
3. `session/new` or `session/load`
4. `session/prompt`
5. receive streamed `session/update` notifications
6. answer `session/request_permission`
7. optionally send `session/cancel`

It also exposes Cursor-specific blocking methods such as `cursor/ask_question` and `cursor/create_plan`, plus notifications for todos, subagents, tasks, and image generation. Client-supplied MCP servers are part of session setup. The protocol has an official TypeScript client package, [`@agentclientprotocol/sdk`](https://agentclientprotocol.com/libraries/typescript), so Command Center need not invent request correlation and schema types from scratch.

An unauthenticated initialization probe of the current official binary negotiated ACP v1 and advertised:

```json
{
  "loadSession": true,
  "mcpCapabilities": { "http": true, "sse": true },
  "promptCapabilities": {
    "audio": false,
    "embeddedContext": false,
    "image": true
  },
  "sessionCapabilities": { "list": {} }
}
```

That is promising, but it is also a reason to feature-negotiate rather than infer. This build did **not** advertise ACP `session/resume`, `session/close`, or `additionalDirectories`. Continuation should therefore use `session/load`, which replays history, until a later capability explicitly says otherwise. Cursor currently negotiates protocol v1 even if the client requests draft v2.

### 2. Print mode: useful for a spike, weaker for a backend

`agent -p --output-format stream-json --stream-partial-output` emits NDJSON events for initialization, user/assistant messages, tool calls, and a terminal result. It returns a stable-looking `session_id` and supports `--resume`, `--continue`, `--model`, images, and sandbox/approval flags.

It is not the right primary conversation transport:

- failed runs may exit nonzero with only stderr and no terminal JSON event;
- partial streaming deliberately emits duplicate assistant flushes that must be filtered;
- tool payloads are open-ended and may change shape;
- thinking is suppressed in print output;
- it cannot naturally service permission requests, user questions, or plan approval;
- Cursor's own documentation currently conflicts on whether writes require `--force` or are available by default in non-interactive mode.

Print mode could be a one-shot task fallback, but using ACP for both conversations and tasks avoids maintaining two provider parsers. I would use print mode only for early comparison tests unless ACP reveals a task-specific blocker.

## Recommended Command Center architecture

The adapter should live under `src/lib/agent-backends/cursor/` and own all Cursor-specific behavior. The rest of Command Center should continue to see the existing neutral descriptor, runtime, task, continuity, transcript, MCP, and failure contracts.

For the first implementation:

- Spawn one ACP process per active Command Center conversation. That isolates the worktree, Cursor config, credentials, `CC_*` session identity, failures, and cancellation. Multi-session concurrency inside one ACP process is not yet proven and is not worth making an MVP dependency.
- Launch the process with the Command Center worktree as its process cwd and pass the same absolute path to `session/new`/`session/load`. Command Center remains the sole worktree owner; do not use Cursor's `--worktree` feature.
- Persist the Cursor session ID as the opaque `AgentSessionRef.ref`. Start with `session/new`; recreate the process and use `session/load` after a server restart or runtime eviction.
- Map ACP message/tool updates into `ConversationBackendEvent` and preserve every native update in lossless transcript envelopes. Unknown fields and notification methods must be tolerated and retained rather than crashing the turn.
- On abort, send `session/cancel`, wait a bounded grace period, then terminate the process group. Treat stdout as protocol-only and collect bounded stderr separately for failure classification.
- Use the official ACP TypeScript SDK unless a compatibility spike exposes a Bun/Node problem. Keep a thin provider port around it so tests drive production mapping code without mocking internal modules.
- Discover a configurable executable path, validating `agent` and `cursor-agent` with `--version`. Do not confuse the editor's `cursor` command with the agent binary.
- Require a host-installed CLI for the first release. Do not silently install or update it. Cursor auto-updates by default and uses date-plus-hash versions, so the adapter needs a minimum-tested version, capability negotiation, and a clear preflight error. Bundling the private Cursor distribution would need separate licensing review.

Authentication should support an existing `agent login` and `CURSOR_API_KEY` in the child environment. Secrets should not be placed in argv or logs. `agent status --format json` can power a doctor/preflight check, but enterprise policy must also be handled: Cursor administrators can disable headless operation and enforce approval/network settings.

## Fit with the current Command Center codebase

The core architecture is ready for a third provider. This is the main reason the estimate is weeks rather than months.

The reusable seams are already provider-neutral:

- `src/lib/agent-backends/descriptor.ts:182-232` defines conversation, task, managed-skill, MCP, and error facets.
- `src/lib/agent-backends/conversation.ts:56-165` defines normalized runtime events, turn inputs, metrics, transcripts, and results.
- `src/lib/agent-backends/continuity.ts:48-67` defines start, validate, resume/recover, and fork behavior over opaque refs.
- `src/lib/agent-backends/task.ts:70-150` defines generic one-shot requests, filesystem policy, usage, continuation, and results.
- `src/lib/agent-backends/conformance.ts:1-22` already tests declared capabilities against observed runtime behavior.

The production registry only needs another descriptor at `src/lib/agent-backends/registry.ts:36-64`, and persistence should not require a database migration. Backend IDs and continuation refs are stored in text columns; extending `src/lib/shared/schemas.ts:7-25` to accept `"cursor"` is sufficient for new durable records while existing Claude/Codex records remain valid.

There are, however, meaningful closed-world leaks to remove:

- `src/lib/config/schemas.ts:132-186` and `src/lib/config/loader.ts:130-206` explicitly materialize only Claude and Codex profiles.
- `src/lib/agent-backends/catalog.ts:123-167` hardcodes the two client-safe catalog records and their filesystem-capability maps.
- `src/features/config/sections/BackendsSection.tsx:142-199` fetches a catalog but then requires and renders exactly Claude and Codex.
- `src/lib/mcp/backend-capabilities.ts:104-147` registers only those two MCP policies.
- `src/lib/commands/route-handlers.ts:66-68` and `:115-117` silently map every non-Codex backend to Claude. That must become schema validation rather than a fallback.
- Several workflow editors and visual-tone maps still encode a Claude-versus-Codex choice.

This is mostly mechanical work, but it spans schema validation, defaults, settings form state, stories, API tests, command discovery, and workflow assignment. It is not safe to stop after adding `"cursor"` to the enum.

Collaboration Mode should deliberately remain unchanged in the first release. `src/lib/workflows/collaboration/backend-pair.ts:1-47` explicitly describes it as a curated Claude×Codex pair, not an N-backend orchestrator. Making Cursor eligible there requires a product decision about pair selection, lane defaults, and continuity—not merely backend registration.

The test footprint of the existing adapters is useful calibration:

- Claude: about 5,714 production lines and 10,638 test lines.
- Codex: about 3,313 production lines and 5,653 test lines.
- The first first-class Codex conversation change was already +3,187/−84 lines across 35 files, after an earlier +1,662-line task integration, and it accumulated a long tail of fixes for resume behavior, queuing, cost accounting, MCP, skills, sandboxing, and process stalls.

Cursor will not duplicate every one of those lines, because the neutral seam now exists and ACP is a strong protocol. The history nevertheless shows why production parity is not a two-day enum-and-toggle patch.

## Conservative initial capability declaration

The adapter should declare only what the authenticated spike proves:

| Command Center contract | Cursor evidence | Initial decision |
| --- | --- | --- |
| Continuation | ACP returns a session ID and advertises `loadSession` | `precise_session` after restart/load round-trip passes; otherwise do not ship resume |
| Fork | Interactive CLI has `/fork`, but current ACP does not advertise a fork method | `synthetic` or `unsupported`, not native |
| Queued steering | No authenticated concurrent-prompt behavior has been proven | Accept only for `next_turn`; never inject mid-turn |
| Structured output | No documented JSON-Schema result channel | `post_validation` with the shared bounded repair path |
| Context/cost metrics | Changelogs mention token data, but current ACP docs do not promise stable turn/cost fields | `contextWindowMetrics: false`; return null cost until observed and reconciled |
| Native ask-user | Cursor has `cursor/ask_question` and plan approval | Advertise only after bridging timeout, cancellation, and user-gate semantics; otherwise answer as unavailable |
| External turns/background | Cursor has subagent/task notifications, but CC external-turn semantics are different | `false` initially |
| Filesystem restriction | Cursor offers permissions and sandbox policy files | `unsupported` until exact allow/deny enforcement passes adversarial tests |
| Managed skills | Cursor discovers `.agents/skills`; CC already publishes a link there for Codex | Reuse/generalize the bridge after a live discovery test |
| MCP | ACP accepts client-provided stdio/HTTP/SSE servers; team MCP is excluded | Start conservatively until ambient-config merge, disable, filtering, and approval semantics are proven |

Cursor models are account- and organization-dependent. `agent models`/`--list-models` and ACP session config options are better sources than a hardcoded global list. A minimal UI can default to `auto`; production support should cache an account-specific catalog and handle model disappearance. Cursor expresses some fast/high-effort choices as model variants, so Command Center should not assume its existing effort selector maps one-to-one.

Images appear straightforward because the current ACP handshake advertises image prompt support. For headless mode, Cursor's docs instead describe referencing local file paths in prompt text; ACP should be preferred so the adapter does not weaken the neutral image contract.

## The two parity blockers

### 1. Exact filesystem confinement

Command Center's `fsWriteRestriction: "enforced"` is a mechanical security claim. It is what permits a backend to act as a graph validator or an ownership-confined implementer; “the prompt asked it not to write” is explicitly insufficient.

Cursor supports `Write(...)` allow/deny permissions, `--sandbox`, and `sandbox.json` with workspace read-write/read-only modes, extra paths, network controls, and temp-write controls. On macOS it uses Seatbelt; on Linux it uses Landlock/seccomp and may require kernel 6.2 plus an AppArmor package for standalone CLI installs.

What is not yet proven is the contract Command Center needs: a generated, process-scoped absolute `allowWrite`/`denyWrite` envelope that controls both direct edit tools and every shell/subprocess write, without altering project-owned `.cursor` files or the user's global configuration. Cursor's security docs frequently describe the sandbox in terms of terminal commands, so shell confinement alone is not enough evidence.

Until direct writes, shell writes, symlink traversal, absolute paths, temp directories, nested processes, and denial precedence all pass an adversarial live suite, Cursor must declare both conversation and task filesystem restriction as unsupported. That still permits ordinary sessions and generic tasks; it excludes safety-gated workflow roles.

### 2. Privileged session instructions

ACP documents user prompt content but no separate system/developer-instruction channel. Cursor automatically reads root `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules`, but Command Center's per-conversation profiles, collaboration charters, and validator governance cannot be written into user-owned project files.

For ordinary conversations, the adapter can follow the current Codex conversation behavior and prepend `sessionInstructions` to the first user turn. That is functionally useful but explicitly weaker than a privileged instruction channel. Generic tasks and especially validator roles should not claim equivalent governance until the spike finds a supported process-scoped rule/plugin mechanism or Cursor exposes a privileged ACP channel.

This does not block the interactive MVP. It does block an honest claim of full task/workflow parity.

## Authenticated spike: exact exit criteria

The spike should produce captured fixtures and a decision table, not a demo that merely streams “hello.” At minimum it should verify:

1. **Prerequisites and auth:** browser login, `CURSOR_API_KEY`, unauthenticated/stale credentials, scriptable status, version detection, admin-disabled behavior, and no secrets in logs.
2. **Session continuity:** new → prompt → process exit → new process → load → prompt; stale IDs; cwd mismatch; replay deduplication; session listing; corrupted or deleted history.
3. **Streaming:** text, thinking if present, read/write/shell tools, MCP, subagents, image content, unknown notifications, malformed frames, stderr, network loss, and terminal failure.
4. **Interaction:** tool permissions, `cursor/ask_question`, `cursor/create_plan`, rejection, user timeout, and cancellation while waiting for each.
5. **Cancellation/lifecycle:** cancel during generation and shell execution, stall watchdog, EOF, SIGTERM, forced process-group kill, and orphan-child checks.
6. **Models/config:** account-specific model list, `auto`, mode and reasoning config options, invalid/removed models, and whether settings survive `session/load`.
7. **MCP isolation:** inject Command Center's MCP servers through ACP; determine how they merge with project/user Cursor MCP; prove disable and tool-filter behavior; confirm that team-level MCP is unavailable as documented.
8. **Environment/worktree:** pass the per-conversation `CC_*` contract and `cctl` path into the child; verify isolation between concurrent conversations; ensure Cursor never creates a nested worktree.
9. **Write envelope:** attempt direct-tool and shell writes inside and outside allowlists, deny overlaps, symlink escapes, absolute paths, temp paths, subprocesses, and network access on macOS and supported Linux.
10. **Instructions and structured results:** test the first-turn instruction envelope, any supported plugin/rule injection, JSON-schema prompt enforcement, the shared validation/repair path, usage counters, and cost semantics.

The go/no-go rules should be explicit:

- Ship the interactive MVP only if session load, cancellation, process cleanup, and event framing are stable.
- Ship Cursor as a generic task backend only if autonomous permissions and instruction delivery are acceptable for those task profiles.
- Mark filesystem restriction `enforced` only after the adversarial suite proves the exact Command Center policy.
- Make Cursor eligible for validators or charter-governed workflow roles only after both write confinement and privileged instruction delivery are proven.
- Treat Cursor participation in Collaboration Mode as a separate product proposal.

## Suggested delivery sequence

1. **Spike and record protocol fixtures** (2–4 days).
2. **Build the ACP process/client port and fake transport harness** with request correlation, feature negotiation, bounded stderr, graceful/forced cancellation, and failure classification.
3. **Implement the conversation facet**: start/load continuity, prompt/event projection, transcript envelopes, images, model config, preflight, and conservative capabilities.
4. **Generalize the closed-world product surfaces**: canonical schemas, registry, config/defaults, catalog, settings UI/stories, command discovery, backend tones, and API tests. Keep Collaboration Mode fixed.
5. **Add production integrations**: managed-skill delivery, authoritative MCP behavior, account model discovery, task runner, post-validated structured output, and installation/auth diagnostics.
6. **Run conformance and live hardening**: declared-versus-observed capabilities, restart/recovery, process leaks, timeout/stall paths, real MCP/model calls, and durable transcript/session round trips.
7. **Evaluate parity separately**: only after the write/instruction gates pass, enable confined graph assignments and consider a Cursor-aware collaboration design.

## Final recommendation

Proceed with the spike. Cursor's ACP implementation removes the biggest usual integration risks—screen scraping, one-shot-only sessions, and lack of bidirectional permissions—so there is a credible path to a good third backend.

Scope the first release as **Cursor for ordinary conversations**, with synthetic/no fork, next-turn queuing, post-validated structured output, null cost/context metrics, and no Collaboration Mode or confined-workflow eligibility. Budget roughly **3 weeks** for that release after access to an authenticated test account.

If the desired outcome is a production backend covering ordinary conversations plus generic tasks, managed skills, MCP, model discovery, and full operational hardening, budget **4–7 weeks**. Do not promise full parity inside that estimate: exact filesystem enforcement, privileged governance instructions, and generalized collaboration are separate gates, making true parity a **6–10+ week** effort and possibly dependent on changes from Cursor.

## Sources

Official sources consulted on 2026-08-12:

- [Cursor CLI overview](https://cursor.com/docs/cli/overview)
- [Cursor CLI installation and updates](https://cursor.com/docs/cli/installation)
- [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters)
- [Cursor CLI output formats](https://cursor.com/docs/cli/reference/output-format)
- [Cursor CLI headless mode](https://cursor.com/docs/cli/headless)
- [Cursor CLI ACP integration](https://cursor.com/docs/cli/acp)
- [Cursor CLI authentication](https://cursor.com/docs/cli/reference/authentication)
- [Cursor CLI configuration](https://cursor.com/docs/cli/reference/configuration)
- [Cursor CLI permissions](https://cursor.com/docs/cli/reference/permissions)
- [Cursor sandbox policy](https://cursor.com/docs/reference/sandbox)
- [Cursor agent security/run modes](https://cursor.com/docs/agent/security/run-modes)
- [Cursor CLI changelog](https://cursor.com/docs/cli/changelog)
- [ACP v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- [ACP TypeScript library](https://agentclientprotocol.com/libraries/typescript)

Repository evidence was taken from the current worktree, especially `.kiro/steering/agent-backends.md`, `src/lib/agent-backends/`, the config/catalog/settings paths cited above, and the Git history of the Codex integration.
