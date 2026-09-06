# Cursor backend parity audit

Date: 2026-09-04. Source revision: `06159859ac88c34706cc19943c9c5cfb3020606a`. Installed Cursor SDK: `1.0.28`.

## Assessment

Cursor is a working interactive conversation backend, but it is not yet a full Command Center execution backend. Its implementation supports ordinary coding conversations, while much of CC's agent-assisted automation requires a task facet that Cursor does not register. Some application schemas also explicitly exclude Cursor independently of the descriptor.

Full Claude parity requires three distinct outcomes:

1. **Product coverage:** Cursor can execute every applicable CC operation, including auxiliary tasks, graph workflows, collaboration, naming, ticket generation, and delivery assistance.
2. **Interaction and observability:** queueing, context-preserving forks, managed skills, MCP controls, background-task lifecycle, context metrics, and costs work with accurate UI disclosure.
3. **Execution guarantees:** governed instructions and filesystem write policies have enforceable mechanisms equivalent to the roles CC admits today.

A percentage would conceal these differences. Cursor has substantial conversation support and major automation gaps. Selecting a Claude model through Cursor does not change these capabilities: the execution adapter, not the model family, determines them.

This is a source and focused-test audit, not a fresh authenticated Cursor acceptance run. Supported below means implemented in the checked-out application; it does not certify every model/account/platform combination.

## Backend comparison

| Capability | Claude | Codex | Cursor in CC |
| --- | --- | --- | --- |
| Session and project conversations | Supported | Supported | Supported |
| Streaming text, thinking, tool activity, durable transcript | Supported | Supported | Supported; specialized task/request events remain raw rather than driving all CC lifecycle UI |
| Resume ordinary conversations | Precise provider session | Synthetic-thread continuity contract | Precise provider session; CC-owned local store and supervised worker |
| Conversation fork continuity | Native | Synthetic history seed | Unsupported; shared fork service can still create a copy without model continuity |
| Submit another message while running | Accepted, in-turn delivery | Accepted, next-turn delivery | Rejected/disabled by CC queue gate |
| One-shot task execution | Supported | Supported | No task facet |
| Structured final output | Prompt contract and shared post-validation | Native where representable, prompt fallback otherwise | Prompt contract and shared post-validation for conversations |
| Context-window occupancy/max metrics | Supported | Not declared | Not declared; input token usage is not a context occupancy guarantee |
| Native mid-turn question handling | Supported | Not declared | Not declared; `askQuestion` and `await` denied in main loop |
| Provider-originated external turns | Supported | Not declared | Not declared |
| CC managed skill bundle | Delivered | Delivered | Explicitly hermetic; not delivered |
| User capability cascade | Skills, plugins, agents | Skills, plugins | No capability kinds |
| Exact filesystem write restrictions | Enforced on conversations/tasks | Enforced on conversations/tasks | Unsupported; sandbox disabled |
| CC neutralizes provider-native memory | Yes | Yes | No exposed memory-off lever declared |
| MCP transports | stdio, HTTP, SSE | stdio, HTTP | stdio only |
| MCP per-tool filtering | Supported | Supported on supported transports | Unsupported; a server requiring a filter is rejected |
| MCP authoritative config guarantee | Declared | Declared | Not declared; authority matrix still needs evidence |
| MCP application timing | Live when idle | Next turn | Next turn |
| Cost accounting | Available | Available | `costUsd: null`; synchronous token usage where complete |

Primary evidence: `src/lib/agent-backends/{claude,codex,cursor}/descriptor.ts`; `src/lib/mcp/backend-capabilities.ts:121-202`; `src/lib/agent-backends/cursor/conversation-runtime.ts:921-940`.

## CC features affected

| CC feature | Actual user impact | Evidence |
| --- | --- | --- |
| Graph workflow implementers, validators, advisory and repair assignments | Cursor cannot be assigned. The workflow agent schema only admits Claude/Codex, and task-ineligible backend pickers disable Cursor. Adding a task facet alone does not fix the schema. | `src/lib/workflow-graph/config-schemas.ts:44-91`; `src/components/workflow-config/AssignmentEditor.tsx:114`; `src/features/config/sections/workflow/AgentConfigFields.tsx:67` |
| Native spec managed delivery | The graph execution assignments used for delivery cannot be staffed with Cursor. This does not prevent manual spec CRUD or discussing a spec in a Cursor conversation. | Same workflow assignment boundary; `src/lib/specs/managed-workflow-definition-policy.ts` |
| Planner, validator, output capture, advisory response and plan repair execution | These auxiliary task consumers need Cursor task support as well as appropriate role eligibility. | `src/lib/workflow-graph/planner.ts:174`; `validator-runner.ts:1244`; `context-output-capture-runner.ts:137`; `advisory-response-runner.ts:183`; `plan-repair/agent-runner.ts:118` |
| Ownership-confined workflow work | Cursor cannot provide the write envelope that owned workflow contexts require. Neither conversation nor task confinement is declared. | `src/lib/workflow-graph/validation.ts:701`; `implementer-runner.ts:217`; `src/lib/agent-backends/cursor/policy.ts:32` |
| Collaboration Mode and `/collab` | Cursor cannot be either participant or the initiating backend. Collaboration is an intentional Claude/Codex pair with its own schemas and execution assumptions. | `src/lib/workflows/collaboration/types.ts:91`; `backend-pair.ts:39`; `helpers.ts:276`; `agent-caller-production.ts:234`; `src/features/session/hooks/use-collab-context.ts:160` |
| `cctl agent run` with Cursor | Explicitly refused because Cursor has no task facet. A Cursor conversation can still request a one-shot run using an enabled Claude/Codex backend. Cursor's own native `task` tool is a separate facility and remains allowed. | `src/lib/agent-runs/route-handlers.ts:152`; `src/lib/agent-backends/cursor/policy.ts:67` |
| `/ticket` from conversation context | Ticket-field generation dispatches a task using the originating conversation backend, so Cursor cannot perform this step. Ordinary ticket CRUD and explicit `cctl ticket` operations remain available. | `src/lib/tickets/slash-command.ts:361`; `src/lib/workflows/conversation/actor-implementations.ts:2943` |
| Quick Ticket enrichment | Enrichment follows `defaultAgentBackend`; choosing Cursor globally breaks the agent enrichment step, while initial ticket persistence is separate. | `src/lib/tickets/service-factory.ts:186`; `src/lib/tickets/enrichment.ts:222` |
| `/commit` and `/merge` generated message/context | Cursor cannot execute the task that generates the message. These paths explicitly fall back to a default message and can proceed. Clean git operations are not categorically unsupported. | `src/lib/conversation-commands/service.ts:304-361,470-495` |
| Smart Commit/Merge validation fixes | Automatic code fixing uses task execution under the owning backend, unavailable for Cursor. Running deterministic registered validations remains supported. | `src/lib/workflows/validation-fix.ts:311-359` |
| Conflict analysis/resolution | The agent-assisted conflict path uses the owning backend's task execution and cannot run through Cursor. Distinguish this from a clean merge/rebase or manual git repair. | `src/lib/sessions/conflict-resolution.ts:513-550`; `src/lib/workflows/conversation/execute-fresh-task-run.ts:79-113,191` |
| Compaction generation | Cursor cannot be selected as the summarizing backend. A separately configured Claude/Codex backend can compact Cursor transcripts. This is distinct from provider-native compaction telemetry. | `src/features/config/sections/CompactionSection.tsx:131`; `src/lib/context-artifacts/service.ts:482-510` |
| Conversation naming | Cursor cannot be selected as the naming task backend. Names for Cursor conversations can still be generated through the separately configured backend. | `src/features/config/sections/NamingSection.tsx:104`; `src/lib/conversations/name-generation.ts:168` |
| Session name generation | Still explicitly runs Claude Haiku, so this path retains a Claude dependency even after adding a Cursor task runner. | `src/lib/sessions/service.ts:472-480` |
| Queueing while Cursor works | Composer disables enqueueing and API rejects it with 422 `UNSUPPORTED_BACKEND`. The `next_turn` descriptor value does not mean the user can currently queue a next turn. | `src/components/session/prompt/PromptComposer.tsx:126`; `src/lib/prompt/queue-operations.ts:192-202` |
| Context-preserving conversation forks | No native fork and no synthetic seed. The shared service copies visible history and proceeds with null backend ref/mode, so the new agent does not receive that copied history as fork context. | `src/lib/agent-backends/cursor/continuity.ts:323`; `src/lib/conversations/service.ts:640-705`; `src/lib/conversations/service.test.ts:1483` |
| Background activity and automatic continuation | Cursor does not implement CC's external-turn or background-activity callbacks. Raw native task events are stored, but they do not produce Claude-style tracked activity, task-loss notifications, or completion-triggered external turns. This does not remove CC-owned background jobs. | `src/lib/agent-backends/conversation.ts:334-355`; `src/lib/agent-backends/cursor/transcript-projections.ts:166`; `cursor/conversation-runtime.ts:620`; `claude/conversation-runtime.ts:685` |
| Context thresholds and native compaction reporting | Cursor reports no context-window maximum and always returns `compacted: false`. Occupancy-dependent workflow rotation is unsupported; a future workflow enablement must not pretend the threshold is enforced. | `src/lib/agent-backends/cursor/conversation-runtime.ts:930-935`; `src/lib/workflows/primitives/context-limit-gate.ts:88-124` |
| Managed skills and capability settings | CC does not deliver its bundle to Cursor. Skills/plugins/agents toggles cannot be applied, and discovery produces no provider commands. CC's built-in slash commands remain listed, including commands whose task dependencies cannot run. | `src/lib/agent-backends/cursor/descriptor.ts:99,178`; `cursor/runtime-config.ts:35`; `src/lib/commands/backend-command-catalog.ts:63`; `built-in-commands.ts` |
| MCP controls | Remote HTTP/SSE, per-tool allow/deny filters, configured startup/tool timeouts, live runtime inventory and proven authoritative config are missing. Unsupported filter/timeout fields reject the server rather than silently removing the restriction. Basic stdio discovery/probing and next-turn application exist. | `src/lib/agent-backends/cursor/mcp-translation.ts:66-79,111`; `src/lib/mcp/backend-capabilities.ts:180-202` |
| Shared-memory exclusivity | CC memory delivery and CLI access can still work; Cursor's own memory cannot be switched off through the declared adapter. It may coexist with CC memory. | `src/lib/agent-backends/cursor/descriptor.ts:135-153` |

Ordinary worktree lifecycle, session/project chat, cancellation, images, model selection, transcript display, diffs, file browsing, voice-to-text input, CC questions, documents, notifications, ticket CRUD and dev-server commands do not inherently require the missing task facet. Do not label these universally unsupported. `cctl ask` follows CC's asynchronous end-turn protocol; it does not require Cursor's denied native question tool.

Images are already implemented: PNG/JPEG/WebP/GIF, up to five images, 5 MiB decoded per image and 20 MiB per turn (`cursor/image-input.ts:16-27`). Model parameters and variants are already passed through the generalized model-selection contract (`cursor/worker/sdk-port.ts:41`). The runtime uses a generated catalog plus project allowlist, not live account discovery on every launch (`cursor/model-catalog.ts:43`, `production-wiring.ts:101`). This project's `CommandCenter.json` enables many models; the unconfigured project default is only Composer 2.5. Older Phase 1 planning documents are not a reliable inventory of what remains undone.

## Integration defects and incomplete boundaries

1. **Conversation MCP PATCH selects the wrong backend.** `src/lib/mcp/config-route-handlers.ts:802-809` reads `conversation.backend`, while persisted conversations use `agentBackend`, and only recognizes Claude/Codex. Production wiring supplies no fallback (`route-bindings.ts:103-118`), so it passes Claude to `applyAfterOverrideChange`. That backend determines apply timing in `runtime-apply.ts:590`. Correct the identity lookup, use the canonical schema, and reproduce against a Cursor conversation, both idle and running. This finding is source-confirmed; this audit did not create a new failing reproduction test or patch it.
2. **Fork UI can imply continuity that does not exist.** The unsupported branch still creates a fork with copied transcript and no seed. The panel's special disclosure is for synthetic forks (`src/components/conversation/ConversationPanel.tsx:102`), not this null-continuity case. Either prevent/disclose this outcome or implement a synthetic Cursor fork. Native Claude-equivalent fidelity is a separate requirement.
3. **Production continuity probes are deliberately unbound.** `cursor/production-wiring.ts:209-232` supplies a `resolveBinding` that always rejects. Normal conversation resume works through the runtime's known store, but workflow/collaboration `start`, `validate` and `resumeOrRecover` cannot become production-ready by changing capability flags. Bind conversation identity, cwd and store explicitly first.
4. **A task-facet boolean is too broad for staged rollout.** Current facet gates open many consumers together. The original brief requires nongoverned-only eligibility until instruction and confinement gates pass. Encode this per task profile/role before registering limited task support; do not admit validators or governed work merely because a runner exists.
5. **Provider policy is weaker than the neutral input shape.** Cursor retains a supplied `fsWritePolicy` property but does not translate or enforce it. Existing workflow gates are load-bearing. Add refusal at the adapter boundary for unsupported policy input as well as consumer-side admission when expanding callers.

## What the installed SDK already offers

These are public type declarations in the installed `@cursor/sdk` 1.0.28, not claims that CC has exercised the features live.

| SDK surface | Implication for parity work |
| --- | --- |
| `McpServerConfig` has stdio and HTTP/SSE alternatives (`dist/esm/options.d.ts:21-35`) | Remote MCP support is an integration task: extend portable translation, worker IPC and SDK mapping, then verify auth, headers, lifecycle and failures. It is not blocked by a missing transport type. |
| `AgentOptions.agents`, `AgentDefinition`, `LocalAgentOptions.dirs` and `settingSources` (`options.d.ts:96-143,334`) | There are candidate mechanisms for subagent definitions and skill/settings discovery. CC currently suppresses ambient sources. Prove managed skill delivery and selective cascade application without importing unintended ambient settings. Do not claim that Cursor intrinsically has no skills/plugins/agents because CC declares none. |
| `SDKAgent.getUsage()` and eventual billed `UsageCost` (`agent.d.ts:21-37`; `usage-types.d.ts:1-44`) | Billed cost is not absent from the SDK. CC needs settlement-aware reconciliation and durable correlation to local usage UUIDs. CC run IDs cannot be passed as local usage IDs. Preserve unknown cost until attributable; agent totals alone are not per-turn accounting. |
| `SandboxOptions` only exposes `enabled: boolean` (`options.d.ts:63`) | Turning it on is not evidence of CC's exact path allowlist or network policy. A confinement mechanism must cover shell, direct file operations, MCP and subagents, across every supported OS. |
| Main-loop `tools`/`disallowedTools` explicitly do not constrain subagent toolsets (`options.d.ts:290,312`) | Tool restrictions are not sufficient proof of global filesystem or interaction policy. Test or close subagent escape paths. |
| `SDKAgent`/`Run` provide send/stream/wait/cancel; `AgentOptions` has no top-level system/developer instruction field | A public native mid-run steer/reply or privileged instruction channel is not exposed on the examined surface. Investigate an SDK extension or another supported transport before promising exact Claude equivalence. |

CC's current Cursor instruction delivery is a fenced `System Instructions` block prepended to the first **user message** (`cursor/conversation-runtime.ts:1029-1039`). The label does not give the block system priority. Claude supplies `systemPrompt.append` through its SDK (`claude/query-session.ts:247,500`). The historical implementation brief explicitly identifies privileged instructions and exact confinement as independent eligibility gates (`docs/plans/command-center-59-cursor-backend/IMPLEMENTATION_BRIEF.md:81-90`).

## Recommended implementation order

### 1. Make current behavior accurate and predictable

- Fix conversation MCP backend selection with a failing route-level reproduction first.
- Gate/disclose unsupported fork continuity; test that copied history is not represented as model context.
- Make built-in command availability reflect actual execution requirements and intentional fallback behavior.
- Gate Quick Ticket enrichment and all task-backed default selections before accepting Cursor; avoid advertising a configuration that later fails.
- Add instruction-priority and task-profile eligibility to the neutral admission model. Keep permissions out of backend-name branches.
- Make unsupported write-policy inputs fail at the Cursor adapter boundary.

### 2. Close practical conversation gaps

- Implement CC-owned next-turn queueing; no provider mid-turn input is necessary to store a pending message. Verify enqueue/cancel/durable restart/model choice/image delivery and exactly-once draining before declaring it supported. Keep delivery timing `next_turn`.
- Implement a synthetic fork with independent agent/store identity and bounded history seeding; never reuse the same Cursor ref for two conversations. Label synthetic fidelity accurately.
- Deliver the immutable managed CC skill bundle and implement discovery plus capability cascade translation. Prefer the established bundle/bridge design, with live proof and suppression tests.
- Extend remote MCP, filtering/timeouts where enforceable, inventory and config authority. Use a filtering bridge or supported permission mechanism if the SDK has no per-tool control; never silently ignore restrictions.
- Add billed-usage reconciliation. Preserve per-turn/cumulative semantics, delayed updates, unknown values, restart recovery and cancellation/retry ambiguity.
- Wire suitable task/summary events to neutral background/context reporting where evidence supports it. Do not equate provider token usage with context-window occupancy.

### 3. Add a production task facet and remove auxiliary Claude dependencies

- Build a Cursor task runner on the existing supervised worker boundary. Implement isolated and normal execution profiles, full model selection, cancellation/timeouts/stall handling, structured-output contract/repair, task transcript projection, CC environment and portable tooling.
- Restrict it to explicitly eligible profiles until governed instruction and confinement requirements are met.
- Complete production continuity binding for every consumer that probes or resumes task state.
- Exercise `/ticket`, ticket enrichment, generated commit messages, validation fix, conflict analysis/resolution, naming, compaction, `cctl agent`, planner, output capture, advisory, validator and repair paths individually. Test successful behavior, not just picker enablement.
- Remove the hardcoded Claude Haiku session-name call or route it through the explicit naming-backend configuration.

### 4. Establish governed execution, then enable workflow and collaboration coverage

- Prove a privileged instruction channel, including create/resume and instruction updates. If the pinned SDK cannot supply it, treat the SDK/transport change as an explicit research dependency.
- Implement exact write envelopes with adversarial OS-level tests for shell redirection, symlinks/path traversal, direct file tools, subprocesses, MCP and subagents. General sandbox enablement is not acceptance evidence.
- Extend workflow agent schemas, assignment editors, model config, graph rendering and persistence to registered eligible backends. Verify managed spec delivery, output capture, validator/repair, pause/resume, restart and lane isolation.
- Generalize Collaboration Mode's pair policy, caller/continuity logic and UI. This changes a deliberate product restriction; it is separate from registering Cursor. Define which pairs are supported and test both participant positions and merge/result provenance.

### 5. Close or explicitly retain the remaining Claude-specific differences

- Native in-turn steering, native fork fidelity, native interactive requests, context occupancy/native compaction, external/background turns and provider memory neutralization need supported mechanisms and live evidence.
- Synthetic forks and next-turn queues can deliver useful product coverage while remaining weaker than Claude's native semantics. They should not be presented as exact equivalence.
- Full parity is complete only when Cursor can execute the full accepted feature matrix with Claude disabled, without silent fallback or weakened role guarantees. Where the public provider contract cannot supply a guarantee, report that blocker rather than changing the capability flag.

## Verification

No application behavior was changed. The audit inspected production adapters, shared consumer code, tests, historical design constraints and the installed SDK declarations. Memory recall for `Cursor backend parity` returned no notes.

Focused registered validation runs:

- `vrun-568ba6dc-a8d2-48a1-b6bf-d3fca82da9c1`: passed, 7 files — backend conformance, Cursor descriptor/policy/runtime config/MCP/model selection and facet gating.
- `vrun-e2300e99-e43d-4130-9ca3-6b9fcdf60841`: passed, 5 files — Cursor conversation behavior and transcript projection, queue route, collaboration refusal and command catalog.
- `vrun-9da261c5-7270-434c-b2e8-8a6da08149e4`: passed, 2 files — conversation service (including unsupported-fork behavior) and MCP configuration routes.

The existing tests confirm conservative declarations and selected behaviors; they do not establish missing parity. No fresh authenticated acceptance suite, browser flow, billed model run, or cross-platform confinement experiment was performed for this audit. Implementation should use failing behavior-level reproductions, then focused registered validation, followed by live acceptance against the actual runtime and durable state.
