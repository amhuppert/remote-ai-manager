Review of the alternative managed-capabilities design — 22 September 2026

The [alternative](../designs/managed-capabilities-design.md) makes a useful challenge to the [original proposal](2026-09-22-managed-capabilities-design-proposal.md): reduce the first delivery and remove unnecessary scheduling paths. I adopted those changes. Its strongest architectural claim—one launch digest plus runtime recreation replacing application receipts—does not hold against the current lifecycle.

This review checked the design against current source and installed SDK contracts. The alternative's host-wide usage survey was not repeated. Those observations can inform priority, but cannot establish future use, usage on Alex's other machine, or absence of native built-in agents. No production code, live settings, or alternative-design text was changed.

| Topic | Disposition | Decision |
|---|---|---|
| D1: ordinary changes apply at turn start | Accept-reduced | Adopt the scheduling policy, including retiring idle scheduling after equivalent behavior is verified. Keep explicit next-conversation exceptions. |
| D1: recreate runtimes on every tooling change | Reject | Controlled close can lose background work; existing adapters already have less disruptive application mechanisms. |
| D1: replace receipts and component state with one launch digest | Reject | Construction is not acceptance, and frozen capabilities can coexist with newly applied MCP. |
| D2: native inventory, adapter ownership, shared Claude settings composition | Accept | Consolidates duplicated knowledge. Use a small neutral contract at the seam rather than importing domain API schemas into descriptors. |
| D2: Codex name identity groups every matching path | Reject | The current resolver discards duplicate identities; source-specific identity is simpler than implementing group membership, mixed state, and mixed ownership. |
| D2: child native default equals parent state | Reject | A false child default remains false when the parent is enabled. Keep child default and parent disable separate. |
| D2: focused frontmatter comment correction | Accept-reduced | Fix the recorded bug and preserve literal block content. Defer complete YAML parsing until structured declarations warrant it. |
| D3: native MCP tool exclusion and supported timeout translation | Accept | Keep verification of actual MCP name exclusion under the real launch mode. Unsupported allowlists get a limitation rather than a false guarantee. |
| D3: add a Claude agent call-denial hook | Reject for this delivery | It leaves descriptions in context and adds an enforcement path without an established need beyond the stated context-control goal. |
| D3: continue suppressing plugin MCP | Accept-reduced as staging only | Defer generalized importing, disclose omissions, and use existing MCP configuration where useful. Retain native availability as the target; do not wait for an arbitrary second plugin. |
| D4: support notes, subtle indicator, quiet success | Accept-reduced | Adopt explicit UI cleanup; keep typed control semantics and compose existing primitives within the feature. |
| D5: complete project-conversation MCP scope | Accept | Already shared by both designs. Include persistence reads, tooling routes, fanout, and SSE identity, not just the panel URL. |
| Codex agents, Cursor structured agent MCP | Defer | Remove from the first delivery while keeping native functionality available and explaining missing CC controls. |
| Codex process-scoped managed-skill roots | Defer | Keep the bridge initially and surface delivery failures. Revisit by total complexity, not a rule against transport-specific implementations. |
| Dynamic inventories, legacy SSE bridge, immature plugin APIs | Defer | Both proposals already agree; no additional machinery is justified here. |

**Why the D1 mechanism needs changing**

The alternative distinguishes accidental runtime death from a controlled close and says nothing observable is lost. Current Claude [query-session](../../src/lib/agent-backends/claude/query-session.ts) contradicts that premise: `close()` calls `notifyBackgroundTasksLostIfAny("closed")` before closing the SDK, while idle eviction deliberately avoids closing when waitable background tasks exist. The conversation actor also retracts subprocess background activity during replacement. A resume reference preserves conversational continuity; it does not preserve a subprocess's active work or MCP connections.

Next-turn scheduling is still a good simplification. Claude can use its native MCP mutation at that boundary; Codex rebuilds native options per turn; Cursor already replaces only its MCP bridge when needed. Creation-bound controls keep their explicit next-conversation timing until a safe faster mechanism is demonstrated. This avoids buying a new task-preservation mechanism to make toggles more immediate.

The proposed attestation timing also does not fit all three adapters. Codex constructs native options inside [runTurn](../../src/lib/agent-backends/codex/conversation-runtime.ts), after shared pre-turn preparation. Cursor emits its exact MCP hash on worker input acceptance in [conversation-runtime](../../src/lib/agent-backends/cursor/conversation-runtime.ts). A read-only field sampled before dispatch either reports old state or certifies construction before acceptance. Renaming that field does not replace the acknowledgment event.

Cursor supplies a concrete counterexample to one combined desired/actual digest: change a skill preference and an MCP server. Its [capability delivery](../../src/lib/agent-backends/cursor/capability-delivery.ts) restores the frozen capability snapshot on resume, while the new MCP can apply to this turn. The correct outcome is “MCP applied; skill deferred.” One mismatch cannot express that, and driving recreation from it can cause restarts that never resolve the mismatch. Preserve the existing per-kind capability state and MCP state. An aggregate digest may correlate a request, but is not sufficient proof or replacement policy.

**D2 corrections are ordinary correctness, not extra edge-case machinery**

The [resolver](../../src/lib/agent-capabilities/resolver.ts) resolves a child's own default first and only forces it off when its parent is disabled. Therefore parent-native-off → child-default-off → CC-parent-on still leaves the child off. The adapter must expose the child's own setting, normally on, and let parent suppression remain a separate overlay. Scanning all installed children is correct; copying the parent's effective state is not.

The same resolver builds a map keyed by `itemId`. Assigning two native skills the same name ID loses one source before path emission. Distinct native defaults or plugin owners make the proposed “one override applies to both” more than a presentation decision. Retain adapter-owned source identities and use native names as display labels. A stable ID can be project-relative where appropriate while invocation resolves to the current native path.

The existing [Codex skill catalog](../../src/lib/agent-backends/codex/skill-catalog.ts) already parses native results, but filters disabled entries before exposing commands. Reuse it by exposing the complete validated inventory and filtering only command/invocation projections. Also, emitting only explicitly changed rows does not preserve unrelated native `skills.config` entries once the emitted array replaces the inherited array. Specify an adapter merge and verify that changing B preserves a native disable of A.

For frontmatter, a full YAML dependency and a wider interpretation contract are unnecessary for the recorded comment bug. The existing [parser](../../src/lib/commands/frontmatter.ts) must consume indented block content before skipping comment lines: `# literal: text` inside a description is content. This bounded correction does not imply complete YAML/block-scalar support. Structured agent declarations can justify a proper parser in a later slice.

**Availability, deferral, and control value**

I agree that immediately implementing generalized plugin MCP importing, a Codex agent cascade, and Cursor agent MCP translation makes the first delivery too broad. I narrowed it. However, “one plugin server is not enough; reconsider at two” is an arbitrary threshold. One useful server can justify a bounded addition, and no number of unused servers justifies a general interpreter.

The native-versus-managed duplication concern is real and already a verification condition in the original proposal. It is a reason to prove identity, precedence, and known-disable behavior before changing suppression. The claim that lifting strict mode necessarily creates a duplicate was not demonstrated by this review. The pinned Claude SDK distinguishes dynamic, settings-owned, and plugin-owned servers; `setMcpServers` explicitly retains omitted plugin servers and can replace an explicitly named plugin server. Those ownership semantics require a focused check, not assumptions either way.

Until native availability is delivered, identify missing plugin components and point to existing CC MCP configuration. Keep that limitation temporary in the design rather than preserving blanket suppression to obtain a stronger switchboard than Alex needs.

I would not add the Claude agent `PreToolUse` hook in this delivery. It could be useful if Alex wants to prevent delegation or spend through a specific agent, even while its description stays visible. That is a different benefit from reducing context. Replacing a callback with a similar number of hook lines does not establish complexity neutrality: invocation identity, input parsing, ordering, SDK behavior, tests, and explanation still need ownership. Keep read-only/coarse control until the benefit is needed.

**Changes incorporated into the proposal**

The revised proposal now schedules ordinary application at turn start, proposes removal of idle-only scheduling, narrows the parser fix, defers Codex agent controls and structured Cursor agent MCP, and retains the Codex skill bridge for the first delivery with visible failures. It makes the support-note UI cleanup explicit and keeps it inside the capability feature using existing primitives.

It also explicitly specifies independent child defaults, native selector-array preservation, actual acceptance receipts, and the valid coexistence of new MCP with frozen capability selections. Plugin MCP availability remains a bounded follow-up rather than a prerequisite for the initial correctness work.

The current scoped complexity score remains approximately 6/10. The same three weak diagnostics remain: interface simplicity, local ownership of backend knowledge, and understandable contracts. Fewer scheduling states and narrower scope help; a proposed line-count reduction or 9/10 target does not establish improvement if it moves acceptance and lifecycle complexity into an underspecified digest.

Documentation and source review only. No implementation tests or live SDK probes were run for these revisions.
