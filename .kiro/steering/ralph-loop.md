# Ralph Loop Workflows

Autonomous multi-iteration development engine. Runs Claude Code in a supervised loop — one SDK `query()` per iteration — until an objective completes or a termination condition fires.

## Architecture

```
POST /workflow (create, status: planning)
  → generate-plan (optional, fire-and-forget)
  → confirm → startOrchestrator() [fire-and-forget]
       ↓
    runLoop() [while(true)]
       → check pause/abort signals
       → runIteration()
            → fresh ConversationState (role: "iteration")
            → git snapshot (pre)
            → buildIterationPrompt()
            → in-process MCP tools (report_status, update_fix_plan)
            → SDK query() [persistSession: false, bypassPermissions]
            → git diff (post) → classifyProgress()
       → persist iteration results + broadcast SSE
       → evaluateExit() → continue or halt
       ↓
    removeOrchestrator()
```

**Key principle**: Fire-and-forget dispatch. `startOrchestrator()` returns immediately; the loop runs as a background promise. Errors are logged, never surfaced to HTTP responses.

## Module Organization (`src/lib/ralph-loop/`)

| Module | Role | Design |
|--------|------|--------|
| `orchestrator.ts` | Main loop + iteration execution | Only public entry point; fire-and-forget |
| `orchestrator-registry.ts` | Control registry (pause/abort) | HMR-safe `globalThis` singleton |
| `circuit-breaker.ts` | Progress-based safety valve | **Pure function** — no side effects |
| `exit-detector.ts` | Ordered exit condition evaluation | **Pure function** — priority-ordered checks |
| `fix-plan-manager.ts` | Task plan CRUD | **Pure function** — returns new arrays |
| `progress-detector.ts` | Git-based progress classification | **Pure function** — compares snapshots |
| `prompt-builder.ts` | Per-iteration prompt construction | Builds Markdown with plan, history, instructions |
| `mcp-tools.ts` | Claude's per-iteration MCP tools | Recreated per iteration with fresh closures |
| `plan-generator.ts` | AI-powered initial plan generation | Fire-and-forget SDK query with `submit_plan` tool |
| `workflow-stream-registry.ts` | Live NDJSON streaming to UI | HMR-safe `globalThis`, separate from SSE broadcaster |

**Convention**: Pure function modules (`circuit-breaker`, `exit-detector`, `fix-plan-manager`, `progress-detector`) have zero imports of state/broadcast modules. Testable in isolation.

## Iteration Isolation

Each iteration is fully isolated:
- Fresh `ConversationState` with `role: "iteration"` and own JSONL transcript
- Fresh `AbortController` (linked to parent for user-abort propagation)
- Fresh MCP server instance (closures over mutable state)
- `persistSession: false` — no SDK session reuse across iterations

No state leaks between iterations except what is explicitly persisted in `RalphLoopIterationMeta` and `workflow.fixPlan`.

## Task Plan Lifecycle

Tasks flow: `pending` → `completed` | `skipped`

Claude mutates the plan mid-iteration via the `update_fix_plan` MCP tool, which immediately persists via `mutateSession()` and broadcasts `workflow-fix-plan-updated` SSE.

Plan generation (`plan-generator.ts`) gathers the last 6 messages from the most recent non-iteration conversation (truncated to 500 chars each) as context, then runs a single SDK query with a custom `submit_plan` tool.

## Exit Conditions (Priority Order)

Evaluated by `exit-detector.ts` after each iteration:

1. **Plan complete** — all tasks resolved → status `completed`
2. **Iteration cap** — reached `maxIterations` → `halted`
3. **Circuit breaker open** → `halted`
4. **Permission denied** — 2+ consecutive blocked iterations → `halted`
5. **Test saturation** — 3+ of last 5 iterations are testing-only → `halted`
6. **Stalled exit signal** — 2+ of last 3 iterations signal exit but tasks remain → `halted`

Only `plan_complete` is a successful halt. Everything else is problematic.

## Circuit Breaker

State machine: `closed` → `half_open` → `open` (terminal, requires manual reset)

- `closed`: N consecutive `no_progress` → `half_open` (default N=3)
- `half_open`: one more `no_progress` → `open`; progress → back to `closed`
- Separate track: M consecutive same error type → `open` immediately (default M=5)

Progress = any of: `filesChanged > 0`, status report says "complete", or tasks were completed/skipped.

## Context Budget Management

The orchestrator tracks `peakContextTokens` per iteration from SDK usage data:
- **Soft limit** (default 160K tokens): `isWindingDown()` flag activates, appending wrap-up warnings to MCP tool responses
- **Hard limit** (default 180K tokens): iteration abort with status `context_limit`

## Dual Streaming

Two distinct real-time channels:
- **Global SSE broadcaster** (`/api/events`): Status/progress events consumed by all connected clients (`workflow-status`, `workflow-iteration-complete`, `workflow-fix-plan-updated`, `workflow-circuit-breaker`)
- **Per-workflow NDJSON stream** (`/workflow/stream`): Live iteration content (assistant messages, tool use blocks) consumed by the specific session's UI panel

## MCP Tools (Per-Iteration)

Created via `createSdkMcpServer` + `tool()` from the Agent SDK. In-process, no network hop.

| Tool | Purpose | Side Effects |
|------|---------|-------------|
| `report_status` | Status + work summary + exit signal | Updates mutable `statusReport` closure |
| `update_fix_plan` | Complete/skip/add tasks | `mutateSession()` + SSE broadcast (immediate) |

Both tools validate input with `safeParse` and return corrective messages on failure. Both append context-limit warnings when `isWindingDown()` is true.

`AskUserQuestion` is denied at the `canUseTool` layer — Claude must proceed autonomously.

## Workflow Status Lifecycle

```
planning → running → completed
                  → halted (circuit breaker, iteration cap, etc.)
                  → aborted (user-initiated)
         → paused → running (resume)
                  → aborted
```

Pause is graceful: current iteration completes, then loop stops. Abort propagates immediately via `AbortController`.

## Configuration

Per-workflow only (no global config). Stored in `SessionState.workflow.config`. Editable during `planning` or `paused` status.

| Field | Default | Range |
|-------|---------|-------|
| `maxIterations` | 20 | 1–100 |
| `iterationTimeoutMs` | 3,600,000 (1hr) | 1min–2hr |
| `contextSoftLimitTokens` | 160,000 | — |
| `contextHardLimitTokens` | 180,000 | — |
| `circuitBreaker.noProgressThreshold` | 3 | — |
| `circuitBreaker.sameErrorThreshold` | 5 | — |

## SDK Query Options

```typescript
systemPrompt: { type: "preset", preset: "claude_code", append: "<objective>...</objective>" }
permissionMode: "bypassPermissions"
persistSession: false
settingSources: ["user", "project", "local"]
env: { ...process.env, CLAUDECODE: "" }  // prevents nested-session detection
```

## Key Conventions

- **State mutations**: All through `mutateSession()` — serialized, atomic writes to `state.json`
- **HMR-safe singletons**: Registries use `globalThis.__csm_*` keyed maps
- **Conversation role tagging**: Iteration conversations use `role: "iteration"` to distinguish from normal conversations
- **Non-throwing background work**: Plan generation and orchestrator errors are caught and logged, never thrown to callers

---

_Document patterns, not every field. Schemas in `schemas.ts` are the source of truth for data shapes._
