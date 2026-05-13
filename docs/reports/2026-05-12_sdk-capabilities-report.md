# Anthropic Agent SDK and Codex SDK Capability Report

**Date:** 2026-05-12
**Scope:** `@anthropic-ai/claude-agent-sdk` v0.2.111 (latest on npm: 0.2.140) and `@openai/codex-sdk` v0.125.0 (latest on npm: 0.130.0).

## Sources Reviewed

- Anthropic Agent SDK TypeScript reference and changelog.
- OpenAI Codex SDK README and source.
- Local type definitions in `node_modules/@anthropic-ai/claude-agent-sdk` and `node_modules/@openai/codex-sdk`.
- Command Center implementation under `src/lib/agent-backends/`, `src/lib/codex-tool.ts`, `src/lib/workflows/`, and `src/lib/workflow-graph/`.

---

## Executive Summary

Command Center already uses the most important baseline features of both SDKs: Claude long-lived `query()` sessions with `streamInput`, Claude session resume/precise-fork, Claude structured output, in-process SDK MCP servers (`cc-session-tools`), Codex persistent threads with `runStreamed`/`run`, Codex structured output, Codex local image input, and portable MCP translation for both backends.

The unused value falls into six themes:

1. **Safety & rollback** — Claude file checkpointing + `rewindFiles()` enables a deterministic "undo this turn's file edits" primitive that today doesn't exist.
2. **Diagnostics** — `getContextUsage()`, full `modelUsage`/cache/rate-limit data, Codex `reasoning_output_tokens`, structured Codex item types (`reasoning`, `todo_list`, `web_search`, `file_change`, `item.updated`) are all available but not surfaced.
3. **Mid-session control** — Claude's `setModel`, `setPermissionMode`, `applyFlagSettings`, `toggleMcpServer`, `reconnectMcpServer`, `getContextUsage` are unused; this is the key cost lever for graph workflows.
4. **Execution profiles** — The interactive Codex runtime hardcodes `danger-full-access` / `approvalPolicy: never` / `webSearchMode: disabled`. Task-runner already accepts these as inputs (`src/lib/agent-backends/task.ts:18-21`); they need the same plumbing for sessions.
5. **User-intervention loops** — Hooks (26 of 27 unused), `AskUserQuestion`, `Elicitation`, permission requests can convert "stuck agent" into explicit pending-question UI.
6. **Native lifecycle integration** — `WorktreeCreate`/`Remove`, `FileChanged`, `PreCompact`/`PostCompact`, `Stop`, `SessionStart`/`End`, `startup()` warm subprocess. The first two map perfectly onto CC's worktree-isolation model.

A real bug surfaced during review: `src/lib/codex-tool.ts:103-107` runs the `run_codex` MCP tool with `sandboxMode: "danger-full-access"` despite the tool's documentation stating workspace-write access.

The recommended sequence is: (P0) Claude file checkpointing → diagnostics panel → execution profiles → fix `run_codex` sandbox + register reference documents → cost rails. (P1) Mid-session control + AskUserQuestion + hooks + dynamic discovery + rich Codex stream UI. (P2) Subagent lanes + prewarming + advanced runtime config + prompt suggestions.

---

## 1. Current Command Center Usage

### 1.1 Claude Agent SDK

Primary integration: `src/lib/agent-backends/claude/query-session.ts`, `conversation-runtime.ts`, `task-runner.ts`, `native-tooling.ts`.

| Area | Used | Reference |
|---|---|---|
| Entry | `query()` long-lived | query-session.ts:200-228 |
| Entry | `query()` one-shot for session naming | task-runner.ts:34-118 |
| Options | `cwd`, `model`, `effort`, `systemPrompt: { preset: "claude_code", append }`, `settingSources`, `permissionMode: "bypassPermissions"`, `allowDangerouslySkipPermissions: true`, `disallowedTools`, `plugins`, `outputFormat: { type: "json_schema" }`, `maxTurns`, `resume`, `forkSession`, `resumeSessionAt`, `persistSession: true`, `env`, `mcpServers`, `strictMcpConfig: true`, `canUseTool`, `stderr` | query-session.ts |
| Query methods | iterator, `streamInput`, `setMcpServers`, `mcpServerStatus` | query-session.ts:376, 441, 477, 501 |
| Hooks | `canUseTool` only | native-tooling.ts:76-107 |
| MCP | In-process SDK server `cc-session-tools` injected via `instance` | conversation-runtime.ts:50, 126 |
| Messages | `system.init`, `assistant`, `user`, `result.success/error`; raw forwarding via `__raw_message` | query-session.ts:518-714 |
| Session control | `resume`, `forkSession`, `resumeSessionAt` | conversation-runtime.ts:160-186 |

**Notable underuse:** file checkpointing + `rewindFiles()`; 26 of 27 hook events; `AskUserQuestion` (disabled in normal runtime, denied in task runner); permission requests bypassed; subagents + `agentProgressSummaries`; `startup()` prewarming; dynamic discovery (`supportedModels`, `supportedCommands`, `supportedAgents`, `accountInfo`); `getContextUsage()`; partial messages; prompt suggestions; `maxBudgetUsd` / `taskBudget`; sandbox settings; `setModel`/`setPermissionMode`/`applyFlagSettings`; `toggleMcpServer` / `reconnectMcpServer`; `seedReadState`; `stopTask`.

### 1.2 Codex SDK

Primary integration: `src/lib/agent-backends/codex/conversation-runtime.ts`, `task-runner.ts`, `mcp-translation.ts`; `src/lib/codex-tool.ts` (the `run_codex` MCP tool exposed to Claude sessions).

| Area | Used | Reference |
|---|---|---|
| Entry | `new Codex(options)`, `startThread`, `resumeThread` | task-runner.ts:79; conversation-runtime.ts:240, 250 |
| Methods | `Thread.run()`, `Thread.runStreamed()` | both runtimes |
| ThreadOptions | `mcpServers`, `system_instructions`, `env`, `model`, `reasoningEffort`, `workingDirectory` | conversation-runtime.ts |
| TurnOptions | `outputSchema`, `signal` | runtimes |
| Input | text + `local_image` (image attachments supported) | conversation-runtime.ts |
| Task-runner profile fields | `sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, `webSearchMode`, `additionalDirectories` (typed in `AgentTaskRequest`) | `src/lib/agent-backends/task.ts:18-21` |

**Notable underuse / problems:**

- The **interactive** runtime ignores `reasoning`, `todo_list`, `web_search`, `item.updated`, and most structured `file_change` details — flattens everything to text, Bash, and MCP blocks.
- The interactive runtime hardcodes `sandboxMode: "danger-full-access"`, `approvalPolicy: "never"`, `webSearchMode: "disabled"`. These options exist in the task-runner shape but aren't exposed as session-level controls.
- `run_codex` (`src/lib/codex-tool.ts:103-107`) hardcodes `danger-full-access` despite the tool's README stating workspace-write access. **This is a real bug.**
- `run_codex` writes reference documents under `memory-bank/codex/` but does **not** register them with CC's artifact / reference-document registry (`src/lib/workflows/primitives/artifact-registry.ts`).
- Codex `reasoning_output_tokens` and richer token accounting are not surfaced.
- Codex SDK options `baseUrl`, `apiKey`, `codexPathOverride`, custom `env` are not used for explicit provider/runtime configuration.
- No precise-fork support (Codex SDK limitation, surfaced as `preciseFork: false` in the capability matrix).

---

## 2. Capability Gap Matrix

| SDK | Capability | Current State | Opportunity |
|---|---|---|---|
| Claude | `enableFileCheckpointing` + `Query.rewindFiles()` | Not used | Native per-turn file undo. |
| Claude | `extraArgs: { "replay-user-messages": null }` | Not used | Stable user-message UUIDs needed for rewind. |
| Claude | Hook events (26 of 27 unused) | Only `canUseTool` | Push-based file/worktree/compaction/stop events; policy and audit. |
| Claude | `AskUserQuestion` | Disabled / denied | Route into CC's pending-question UX with phone notification. |
| Claude | `permissionMode: plan`/`acceptEdits`/`dontAsk`/`auto` | Only `bypassPermissions` | Tiered execution profiles. |
| Claude | `agents` (programmatic subagents) | Not used | Inline specialist agents (security review, doc synth) without filesystem deps. |
| Claude | `agentProgressSummaries` | Not used | Periodic AI summaries for long subagent work. |
| Claude | `Query.getContextUsage()` | Not used as primary source | Authoritative context-window breakdown by category. |
| Claude | `modelUsage`, cache reads/writes, rate-limit events | Partially scraped | Accurate cost / cache / throttling diagnostics. |
| Claude | `Query.setModel()` | Not used | Mid-session model switching — direct cost lever for graph workflows. |
| Claude | `Query.setPermissionMode()` | Not used | Switch into `plan`/`acceptEdits` mid-flight based on phase. |
| Claude | `Query.applyFlagSettings()` | Not used | Runtime override of any setting. |
| Claude | `Query.toggleMcpServer` / `reconnectMcpServer` | Not used | Granular MCP lifecycle vs full `setMcpServers` replace. |
| Claude | `Query.supportedModels/Commands/Agents` + `accountInfo` | Not used | Dynamic capability discovery for UI selectors. |
| Claude | `Query.stopTask` / `seedReadState` | Not used | Cancel background tasks; tell agent it has read a file. |
| Claude | `startup()` warm subprocess | Not used | ~20× faster first prompt. |
| Claude | `maxBudgetUsd` / `taskBudget` | Not used | Hard cost / token rails for autonomous workflows. |
| Claude | `includePartialMessages` | Not used | Token-level streaming for snappier UI. |
| Claude | `promptSuggestions` | Not used | Suggested next-action chips. |
| Claude | `sandbox: SandboxSettings` | Not used | Restricted execution profiles. |
| Claude | `additionalDirectories` | Not used | Multi-directory access for monorepo sessions. |
| Claude | `onElicitation` + `Elicitation` hooks | Not used | MCP-driven user-input prompts. |
| Codex | `reasoning`, `todo_list`, `web_search`, `item.updated`, structured `file_change` | Ignored in interactive runtime | Rich Codex stream UI blocks. |
| Codex | `sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, `webSearchMode` | Hardcoded in interactive runtime; typed but not exposed | Session-level execution profiles. |
| Codex | Image input (`local_image`) | Used | — |
| Codex | `additionalDirectories` | Not exposed in interactive runtime | Approved cross-directory context. |
| Codex | `reasoning_output_tokens` and detailed token accounting | Not surfaced | Improve Codex cost diagnostics. |
| Codex | `baseUrl`, `apiKey`, `codexPathOverride` | Not used | Provider/proxy/path configuration for advanced installs. |
| Codex | `run_codex` reference documents | Written, not registered | Wire into artifact / reference-document registry. |
| Codex | `run_codex` sandbox correctness | Hardcoded `danger-full-access` despite README | **Bug fix** — match docs or change docs. |

---

## 3. Recommendations

### P0 — Safety, Diagnostics, Correctness

#### P0.1 — Claude Turn Rewind via File Checkpointing

The single highest-value SDK capability CC isn't using. Directly addresses the main risk of autonomous coding.

Implementation:

- Set `enableFileCheckpointing: true` on the Claude `query()` options in `query-session.ts`.
- Add `extraArgs: { "replay-user-messages": null }` so replayed user messages keep stable UUIDs.
- Persist the user-message UUID with each transcript turn.
- Add a dry-run preview action: `query.rewindFiles(uuid, { dryRun: true })`.
- Add a confirmation action that calls `query.rewindFiles(uuid)` and pairs it with `git diff` display so changes are explicit.

Constraints to document in the UI:

- File-level rollback only; does not rewind conversation history.
- Tracks SDK file edit tools (Write, Edit, NotebookEdit). **Bash-mediated edits may bypass checkpointing**, so always pair rewind with diff inspection.

#### P0.2 — Runtime Diagnostics Panel

Convert CC's transcript from raw log into operator console.

Claude data:
- `Query.getContextUsage()` (per-category breakdown).
- Result-message `usage`, `modelUsage`, cache read/write tokens.
- `total_cost_usd` and per-model cost contribution.
- Rate-limit events (`SDKRateLimitEvent`).
- Tool-use summaries (`SDKToolUseSummaryMessage`).
- `Query.mcpServerStatus()` snapshot.

Codex data:
- Input / cached input / output / `reasoning_output_tokens`.
- Streamed `reasoning` summaries.
- Active `todo_list` state.
- `item.updated` command progress.
- Structured `file_change` items (path, change kind).
- `web_search` events when enabled.

#### P0.3 — Safer Execution Profiles

Stop hardcoding `danger-full-access` everywhere. Introduce explicit profiles:

- **Fast local** — current behavior; trusted worktrees.
- **Workspace write** — file writes limited to the assigned worktree.
- **Read-only research** — no writes; web search optionally enabled.
- **Approval required** — ask before risky tools or commands.

Claude path: use sandbox settings for restricted modes; reserve `bypassPermissions` for trusted profiles; use `canUseTool` and `PermissionRequest` hooks for approvals.

Codex path: stop hardcoding the interactive runtime to `danger-full-access`. Plumb `sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, `webSearchMode` through `ConversationBackendRuntime` (the typed shape already exists in `src/lib/agent-backends/task.ts`). Default interactive Codex sessions to `workspace-write`.

#### P0.4 — Fix `run_codex` Sandbox + Register Reference Documents

Two independent fixes co-located in `src/lib/codex-tool.ts`:

**Sandbox fix:** lines 103-107 use `danger-full-access` but the tool's README states workspace-write. Either change the implementation to `workspace-write` (preferred — matches the documented contract) or update the README. The current state is a security correctness bug.

**Reference-document registration:**

- Validate each returned `referenceDocuments[].filePath` is inside the assigned worktree.
- Register each file with CC's artifact / reference-document registry (`src/lib/workflows/primitives/artifact-registry.ts`).
- Link the registered documents from the transcript entry that invoked `run_codex`.
- Display them in the same UI used for other reference documents.

#### P0.5 — Cost & Token Rails

For autonomous graph workflows, nothing currently prevents a runaway $50 burn.

- Add `maxBudgetUsd` to Claude options, threaded through workflow context with a per-context override.
- Add `taskBudget: { total: number }` for token-budget aware pacing.
- Surface as a `CommandCenter.json` setting (`maxBudgetUsdPerTurn` / `maxBudgetUsdPerWorkflow`).
- Hook `result.subtype === "error_max_budget_usd"` into the workflow halt-reason taxonomy.

### P1 — Control Surface, Intervention, Discoverability

#### P1.1 — Mid-Session Model & Permission Switching

Direct cost lever for graph workflows. Today CC fixes the model per session.

- Expose `Query.setModel(model)` and `Query.setPermissionMode(mode)` on `ConversationBackendRuntime` (capability-gated; Claude-only initially).
- Add to graph workflow node config: a node can declare `{ model: "claude-haiku-4-5", permissionMode: "plan" }` and the in-flight conversation switches in place.
- Combine with `Query.applyFlagSettings()` for less common knobs (`maxTurns`, `effort`).
- Outcome: cheap haiku for fan-out validators, opus for hard merge steps, in the same conversation.

#### P1.2 — Built-In User Intervention Flow

Stop disabling `AskUserQuestion`; route it into CC's pending-question system.

- Allow `AskUserQuestion` for interactive Claude sessions where the UI can answer it.
- Configure `toolConfig.askUserQuestion.previewFormat: "html"` (or `"markdown"`).
- Route requests into CC's pending-question store; resume the SDK turn when answered.
- Send a phone notification when a long-running session blocks on a question or permission decision.
- Add project policy for when questions are allowed in autonomous tasks (default: deny in unattended workflows; allow in interactive sessions).

Pair with `onElicitation` for MCP-driven elicitations.

#### P1.3 — Claude Hooks for Policy, Audit, and Native Lifecycle

The hook surface (27 events) is the largest single piece of unused leverage. Land as a single new file `src/lib/agent-backends/claude/hooks.ts` that owns registration and forwards events into the existing event bus that feeds SSE — don't plumb 27 hooks individually.

High-value subset to land first:

| Hook | Why for CC |
|---|---|
| `FileChanged` | Push-based diff updates; replaces git polling. |
| `WorktreeCreate` / `WorktreeRemove` | CC's whole isolation model is worktrees — tailor-made integration. |
| `PreCompact` / `PostCompact` | Long graph workflows have no warning today that a turn is mid-compaction. |
| `Stop` / `StopFailure` | Distinguish natural stop from `error_max_turns` without parsing result subtypes. |
| `SessionStart` / `SessionEnd` | Lifecycle audit, analytics, cleanup. |
| `PreToolUse` | Block disallowed paths, warn on destructive commands, attach policy context. |
| `PostToolUse` / `PostToolUseFailure` | Structured tool output / failure capture for debug logs. |
| `PermissionRequest` / `PermissionDenied` | Granular permission events for UI and notifications. |
| `Notification` | Send push notifications for long-running or blocked work. |
| `UserPromptSubmit` | Pre-process prompts (expand macros, redact secrets, append session context). |
| `TaskCreated` / `TaskCompleted` / `SubagentStart` / `SubagentStop` | First-class subagent observability. |

Hooks complement the transcript system — use them for policy, audit, and side effects, not as a transcript replacement.

#### P1.4 — Dynamic Capability Discovery

Reduce hard-coded model and tool assumptions.

Claude:
- `supportedModels()` for model-picker validation.
- `supportedCommands()` for slash-command palette.
- `supportedAgents()` for available subagents display.
- `accountInfo()` for account/plan diagnostics.
- `mcpServerStatus()` for live MCP health (already used; surface in UI).
- `resolveSettings()` after SDK upgrade.

Codex:
- Surface SDK + CLI version.
- Surface configured model / reasoning settings.
- Continue probing native MCP config; show which servers are CC-managed vs native (already done in `native-mcp-suppression.ts` — surface in UI).

Static schemas remain as fallback validation; the UI should prefer runtime-discovered capabilities where possible.

#### P1.5 — Rich Codex Stream UI

The Codex SDK already emits structured items CC discards. Add first-class UI blocks for:

- `ReasoningItem` — concise reasoning summaries.
- `TodoListItem` — active plan/progress.
- `FileChangeItem` — file list, diff, change kind.
- `WebSearchItem` — search events with citations.
- `item.updated` events — command progress instead of waiting for completion.
- `ErrorItem` — structured error display.

Update the message router in `codex/conversation-runtime.ts` to handle every member of the `ThreadEvent` and `ThreadItem` unions.

#### P1.6 — MCP Operator Controls

Use `Query.toggleMcpServer(name, enabled)` and `Query.reconnectMcpServer(name)` to back per-server enable/disable and "reconnect" buttons in the MCP UI. Today CC has only `setMcpServers()` (full replace), which is heavyweight for a single failed server.

### P2 — Polish and Specialization

#### P2.1 — Claude Subagent Lanes

Use `agents` for bounded, read-only sidecar work inside a session. Good candidates: codebase exploration, security review, test strategy, documentation synthesis, migration impact analysis.

Constraints: subagents share a Claude Code session — they are not equivalent to CC's worktree-isolated sessions. Treat them as in-session assistants. Start read-only, pair with `agentProgressSummaries`. Write-capable subagents need careful policy.

#### P2.2 — Claude Prewarming

Use `startup()` when the user opens a session or focuses the prompt editor. Wrap in `query-session.ts` so a session can be pre-warmed before the user submits.

Tradeoff: more resident Claude Code processes if not TTL-managed. Pair with idle eviction.

#### P2.3 — Partial Messages and Prompt Suggestions

`includePartialMessages: true` enables `stream_event` deltas — token-level rendering for snappier UI. Requires updating the message router in `query-session.ts:518-714` to handle `stream_event`.

`promptSuggestions: true` surfaces context-aware next-action chips. Polish-tier; do after core diagnostics work.

#### P2.4 — Advanced Codex Runtime Configuration

Expose only where they solve real operator problems. Make these admin/project settings, not default user-facing:

- `codexPathOverride` for non-standard installs.
- `baseUrl` and `apiKey` for explicit provider/proxy configuration.
- Custom `env` for controlled runtime variables.
- `additionalDirectories` for approved cross-repository context.

---

## 4. Structured Output Improvements

Both SDKs support structured output, and CC already uses it in validators and delegated tasks.

- Centralize JSON Schema generation for shared Zod schemas.
- Prefer deriving schemas from production Zod definitions where practical.
- Keep backend-specific parsing fallbacks, especially for Codex final-message JSON parsing.
- Store the exact output schema version with validation results.

Reduces drift between workflow validators, Codex task calls, and Claude structured output.

---

## 5. Architectural Notes

- `ConversationBackendRuntime` capability matrix (`src/lib/agent-backends/conversation.ts:74-99`) is the natural place to express new optional features (`fileCheckpointing`, `midSessionModelSwitch`, `imageInput` (already), `webSearch`, `executionProfiles`, `subagents`). Capability flags keep the abstraction honest when only one backend supports a feature.

- Hook integration (P1.3) should land as a single new file (`src/lib/agent-backends/claude/hooks.ts`) that owns registration and forwards into the existing SSE event bus — not 27 individual plumbing paths.

- File checkpointing (P0.1) policy ("checkpoint user-message-id → rewind on validator fail") should live in the workflow graph engine (`src/lib/workflow-graph/`), not individual nodes.

- Codex profile parity (P0.3): extend the portable abstraction in `src/lib/agent-backends/portable-mcp.ts` with a sibling `portable-execution-profile.ts` so sandbox / approval / network / webSearch get translated symmetrically per backend. The `AgentTaskRequest` shape already proves this is feasible.

---

## 6. Risks and Cautions

- **Do not replace CC's transcript store with SDK session APIs** (`listSessions`, `getSessionMessages`, `SessionStore`, deprecated V2 `unstable_v2_*`). CC's transcript model is product-specific and includes workflow, UI, and artifact metadata the SDKs do not own. Use SDK session APIs for recovery, reconciliation, and diagnostics only.
- Claude file checkpointing is **file-level only**. Present as "rewind files" not "rewind session."
- **Bash-mediated edits may bypass checkpointing.** Always pair rewind with diff inspection.
- `bypassPermissions` + `danger-full-access` is acceptable in trusted worktrees but should not be the only mode for unattended workflows.
- Claude subagents are not equivalent to CC worktree-isolated sessions — treat as in-session assistants.
- Codex lacks native precise-fork, ask-user-question, and context-window metrics. CC should not pretend backend parity is stronger than it is — keep capability matrix honest.
- Both installed SDKs are behind latest npm releases (Claude: 0.2.111 vs 0.2.140; Codex: 0.125.0 vs 0.130.0). Upgrade in a separate task with focused regression tests before relying on newer APIs.
- The deprecated `TodoWrite` tool (deprecated in claude-agent-sdk v0.2.136) — once CC upgrades, switch any references to `TaskCreate`/`Get`/`Update`/`List`.

---

## 7. Skip / Don't Adopt

- **Session helpers** (`listSessions`, `getSessionMessages`, `tagSession`, `renameSession`, top-level `forkSession`, `SessionStore`) — conflicts with CC's deliberate transcript-ownership model.
- **Deprecated V2 session API** (`unstable_v2_createSession`, `unstable_v2_resumeSession`, `unstable_v2_prompt`).
- **Deprecated `TodoWrite` tool** — when upgrading the SDK, swap to the Task tools.

---

## 8. Suggested Implementation Order

1. **Fix `run_codex` sandbox correctness** (P0.4 sandbox half) — small, security-relevant.
2. **Claude file checkpointing + rewind** (P0.1).
3. **Runtime diagnostics panel** (P0.2).
4. **Execution profiles** + Codex interactive runtime un-hardcoding (P0.3).
5. **Register `run_codex` reference documents** (P0.4 registration half).
6. **Cost & token rails** (P0.5).
7. **Mid-session model & permission switching** (P1.1).
8. **AskUserQuestion + permission flow into CC pending-question UX** (P1.2).
9. **Hooks subset for policy / native lifecycle** (P1.3).
10. **Dynamic capability discovery** (P1.4).
11. **Rich Codex stream UI** (P1.5).
12. **MCP operator controls** (P1.6).
13. **Subagent lanes**, **prewarming**, **partial messages / prompt suggestions**, **advanced Codex runtime config** (P2).

---

## 9. References

- Claude Agent SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Claude Agent SDK changelog: https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
- Codex SDK README: https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- Codex SDK npm: https://www.npmjs.com/package/@openai/codex-sdk
- CC backend abstraction: `src/lib/agent-backends/conversation.ts`
- CC Claude integration: `src/lib/agent-backends/claude/{query-session.ts, conversation-runtime.ts, native-tooling.ts, task-runner.ts}`
- CC Codex integration: `src/lib/agent-backends/codex/{conversation-runtime.ts, task-runner.ts, mcp-translation.ts, native-mcp-suppression.ts}`
- CC `run_codex` MCP tool: `src/lib/codex-tool.ts`
- CC artifact registry: `src/lib/workflows/primitives/artifact-registry.ts`
