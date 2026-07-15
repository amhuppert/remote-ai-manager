# Tool-by-Tool Migration Design

**Status:** Implemented; retained as the transport-migration record. Current command and output contracts live in `.kiro/steering/cli.md`.

Phases 1–4 of the [CC CLI migration](./README.md). AskUserQuestion has its own document
([03](./03-ask-user-question-async.md)).

## 1. Migration principle: keep the service, replace the transport

Every MCP tool handler today is a thin wrapper: parse args (Zod) → call injected deps → format a
result string. The migration keeps that exact shape and swaps the transport:

```
before:  SDK MCP dispatch → tool handler → service deps
after:   cctl → HTTP route handler → same service deps
```

Business logic (`reference-documents/`, `dev-server/`, `workflow-graph/` services) is **not**
rewritten. New route handlers live in each domain's `route-handlers.ts` per the structure
convention (API mirrors resources). Tool wrapper files are deleted only in Phase 4, after their
registrations are gone.

Three cross-cutting rules for all new endpoints and commands:

- **Identity comes from the URL** (`/api/projects/[name]/sessions/[session]/…`), matching the
  existing resource layout. The CLI fills these from its env identity (doc 01 §2).
- **Token required** (doc 01 §4) on all new endpoints; existing endpoints unchanged.
- **Every command steers the next step** via the guidance-hint convention (doc 01 §6). The
  sections below give each command's hint where one applies; commands without one are deliberate.

## 2. Phase 1 — Notifications, documents, dev servers, workflow lifecycle

### 2.1 `cctl notify`

New endpoint — the existing push-notification routes only manage config and test sends.

- `POST /api/projects/[name]/sessions/[session]/notifications`
  Body: `{ title?: string, message: string, urgency?: "info" | "attention" }`.
  Delegates to the same dispatch path as `dispatchPushForConversationStatus`
  (`src/lib/push-notification/dispatcher.ts`), tagged with a `trigger: "agent"` variant.
- CLI: `cctl notify "<message>" [--title <t>]`. Exit 1 if push is unconfigured/disabled, with a
  one-line reason (agents should treat that as non-fatal). No hint — a notification is terminal.

### 2.2 `cctl docs register|list|delete`

Reference documents have GET (list) and GET content routes
(`src/lib/sessions/reference-documents-route-handlers.ts`); register/delete are MCP-only
(`src/lib/reference-documents/tools.ts:230-263`).

- `POST /api/projects/[name]/sessions/[session]/reference-documents`
  Body: `{ filePath: string, description: string }` — same semantics as `register_document`
  (path validated against the session worktree).
- `DELETE /api/projects/[name]/sessions/[session]/reference-documents/[id]`
- CLI: `cctl docs register <path> --description "<why it matters>"`, `cctl docs list [--json]`,
  `cctl docs delete <id>`.
- Hints: `list` ends with `hint: register new docs with 'cctl docs register <path> --description
  …'; remove stale ones with 'cctl docs delete <id>'`. `register`/`delete` get none — restraint is
  part of the convention.

### 2.3 `cctl dev list|ensure|stop`

Endpoints fully exist (`src/lib/dev-server/route-handlers.ts:175-415`). CLI mapping only:

- `cctl dev list [--json]` → GET dev-servers. Output includes `localUrl`/`remoteUrl` — the fields
  agents actually need; the human format prints them first.
- `cctl dev ensure [serverName]` → START route (which already carries ensure semantics). Blocks
  until liveness or a bounded timeout; prints the resolved URLs on success. Distinguishes
  `NO_DEV_SERVERS_CONFIGURED` (exit 1 + pointer to `CommandCenter.json`) from start failure.
  Hint on success: `hint: drive the app at <localUrl>; re-check liveness with 'cctl dev list'`.
- `cctl dev stop <serverName>` → STOP route.

### 2.4 `cctl workflow` read/lifecycle subcommands

Endpoints exist (`src/lib/workflow-graph/execution-route-handlers.ts:1381-1411`,
`src/lib/workflows/route-handlers.ts`). CLI mapping:

- `cctl workflow list|get <id>|status|delete <id>|start <id> [--file inputs.json]`
- Hint on `start`: `hint: track progress with 'cctl workflow status'`.
- `cctl workflow templates [--tier global|project]` — requires extending the templates listing to
  cover the project tier (today's route covers global only; `list_templates` MCP covers both).

`status` deserves care: it is the highest-frequency call in workflow contexts. Default output is a
compact per-context table (id, state, completed/total tasks); `--json` returns the full payload.

## 3. Phase 2 — Planner file flow

### 3.1 `cctl workflow validate|create|replace --file plan.json`

Endpoints exist for create/start/replace; the design adds:

- `POST /api/projects/[name]/sessions/[session]/graph-workflow/validate` — runs exactly the
  create-path Zod parse + graph structural checks (dependency cycles, unknown context refs,
  prerequisite sanity) *without persisting*. Returns `{ ok } | { error, issues[] }`.
- CLI: `cctl workflow validate --file plan.json` (exit 2 on issues, one per line with JSON-path
  locations), then `cctl workflow create --file plan.json`.
- This is the canonical hint-chained flow (doc 01 §6): `validate` (ok) →
  `hint: valid — create it with 'cctl workflow create --file plan.json'`; `create` →
  `hint: start it with 'cctl workflow start <id>'`.

This replaces the single worst MCP interaction in CC: emitting a full workflow graph as inline
tool-call arguments. The `graph-workflow-planning` skill gets updated to author `plan.json` via the
Write tool and iterate on `validate` output.

### 3.2 `cctl charter write --file` / `cctl decisions propose --file`

The alignment domain has read/approve/reject/resolve routes but no agent-side submission
(`src/lib/session-alignment/route-handlers.ts`); submission currently happens only via the MCP
tools (`src/lib/session-alignment/tools.ts`).

- `POST /api/projects/[name]/sessions/[session]/alignment/charter` — body mirrors
  `write_session_charter` input; produces the same draft-pending-approval state + SSE.
- `POST /api/projects/[name]/sessions/[session]/alignment/decisions` — mirrors `propose_decisions`.
- CLI: both take `--file` (payloads are structured and multi-paragraph; inline flags don't fit).

### 3.3 `cctl agent run` — job-shaped

The long-running agent-run flow executes in-process in the server with `cwd` = session worktree and
can run for tens of minutes. Decision: **keep execution server-side, make it a job** — the server
keeps agent config resolution, artifact-registry integration (auto-registering `referenceDocuments`),
logging, and timeout policy. A CLI-local spawn would duplicate all of that into the bundle.

- `POST /api/projects/[name]/sessions/[session]/agent-runs` → `{ runId }`. Body mirrors the tool
  input (prompt, outputSchema expectations, timeoutMs, workingDirectory default = session
  worktree).
- `GET  …/agent-runs/[runId]` → `{ status: "running" | "completed" | "failed", summary?, referenceDocuments?, error? }`
- `POST …/agent-runs/[runId]/cancel` — aborts via the existing AbortController path.
- CLI: `cctl agent run --file prompt.json --wait [--timeout 25m]`; on Bash kill mid-wait the run
  continues, `cctl agent status <runId>` / `cctl agent cancel <runId>` recover. `--wait` prints the
  same JSON shape the MCP tool returned (`summary` + `referenceDocuments`), so downstream agent
  behavior is unchanged.
- Hints: without `--wait` → `hint: poll with 'cctl agent status <runId>'; cancel with 'cctl agent
  cancel <runId>'`. On completion with artifacts (interpolated from response facts) →
  `hint: agent run registered <N> reference documents — read them before building on the summary`.

## 4. Phase 3 — Graph-workflow lane tools

Lane conversations get only the `cc-graph-workflow` server today
(`src/lib/workflow-graph/workflow-execution-server.ts:358-378`); its four tools move to endpoints
under the workflow execution resource. Lane identity comes from `CC_WORKFLOW_EXECUTION_ID` /
`CC_WORKFLOW_CONTEXT_ID` env (doc 01 §2), which CC injects when spawning lane conversations.

**Halt-check moves to the API layer.** Today every lane tool handler is wrapped by
`wrapMcpHandlerWithHaltCheck` (`src/lib/workflow-graph/tool-server.ts:470-514`), which consults
`getPendingHaltReason`/`getPendingToolBlock`. The new endpoints perform the same check first and, on
halt, return `409 { halt: true, reason }`; the CLI prints the halt reason verbatim and exits 1. The
instruction text the agent sees is unchanged.

All four verbs nest under the `cctl workflow` group (they are graph-workflow lane operations, kept
in the same namespace as the authoring/lifecycle verbs rather than scattered as top-level groups).

### 4.1 `cctl workflow task complete`

- `POST /api/projects/[name]/sessions/[session]/graph-workflow/contexts/[contextId]/tasks/[taskId]/complete`
  Body: `{ summary: string }`.
- Server side runs exactly today's handler path (`tool-server.ts:212-257` →
  `execution-tool-context.ts:272-336`): the atomic `mutateActive()` task mutation **plus the
  mid-turn rotation-gate evaluation** (`evaluateMidTurnContextLimit`, sticky `rotateBeforeNextTurn`
  flag). The response carries `{ ok, stopInstruction? }`.
- CLI prints the success line, then — if present — the stop instruction verbatim on stdout
  ("CONTEXT LIMIT REACHED … End your turn now with a brief handoff note."). Exit 0 in both cases:
  completion succeeded; the stop is a cooperative instruction, exactly as it is today via the tool
  result.
- Concurrency: parallel `cctl workflow task complete` calls are safe — the mutation is already
  serialized through `mutateActive()`; no new locking needed.
- Hint (interpolated from response facts): `hint: <N> tasks remain in this context` — the
  step-two-when-ready steering for the lane loop. When a `stopInstruction` is present it is
  primary output and **replaces** the hint (doc 01 §6: protocol is never demoted to `hint`, and a
  "continue" hint must not sit next to a "stop" instruction).

### 4.2 `cctl workflow task add`, `cctl workflow shared-doc upsert`, `cctl workflow collab request`

- `POST …/contexts/[contextId]/tasks` (add_task) — endpoint enforces the `allowAgentTaskAdd`
  mutability config, mirroring the conditional registration today.
- `PUT …/graph-workflow/shared-documents/[name]` (upsert_shared_document) — same
  central-content-store write path.
- `POST …/contexts/[contextId]/collaboration-requests` (request_collaboration) — enforces
  `allowAgentCollaboration`; response includes the pending-collaboration block state the wrapper
  exposes today.
- Where a capability is disabled by config, the endpoint returns 403 with the same explanatory text
  the MCP registration conditionality implied; the CLI surfaces it verbatim (exit 1).

### 4.3 Lane prompt templates

Lane prompts currently instruct MCP tool usage by name. Phase 3 rewrites them to the `cctl`
invocations, including the exact `cctl workflow task complete … --summary` command. This is
load-bearing: lane agents don't browse skills — the prompt is their only discovery surface.

## 5. Failure & abort semantics (all phases)

- **Bash killed mid-command:** plain mutations are single HTTP requests — either they landed or
  they didn't; every command is safe to re-run (server-side idempotency where re-running would
  double-apply, e.g. `docs register` de-dupes on path). Job-shaped ops continue server-side
  (§3.3).
- **Server restart mid-command:** connection error → exit 3 with "is the CC server running?" text.
  No client-side retry loops — the agent decides.
- **Turn aborted while a job runs:** jobs outlive turns by design; the next turn can `status` them.
  This replaces the in-process AbortSignal coupling MCP handlers had.

## 6. Decommissioning checklist (Phase 4)

Delete, in dependency order:

1. `src/lib/mcp-gateway/session-server.ts` and all `register*Tool` wrapper files whose logic now
   lives behind route handlers (`ask-user-question-tool.ts`, `agent-notification-tool.ts`,
   `reference-documents/tools.ts` MCP surface, `planner-tools.ts`, `start-graph-workflow-tool.ts`,
   `list-templates-tool.ts`, `dev-server/mcp-tools.ts`, `session-alignment/tools.ts` MCP surface,
   `codex-tool.ts` MCP surface).
2. `src/lib/workflow-graph/tool-server.ts` + `workflow-execution-server.ts` MCP assembly
   (halt-check logic relocated per §4).
3. `src/lib/agent-backends/claude/session-tools-supervisor.ts` (all of it).
4. In `query-session.ts`: `mcpKeepaliveTick`, stream-closed thresholds and supervised-server
   special-casing, `setMcpServers` rebind mutation queue, `supervisedMcpServerName` option.
5. `task-runner.ts:186-192` AskUserQuestion name-based denial (superseded by the server-side mode
   check, doc 03 §6).
6. Docs/steering sweep: CLAUDE.md (`ensure_dev_server` MCP instructions → `cctl dev ensure`),
   `command-center:agent-context` skill, `.kiro/steering/workflows.md`, `graph-workflow-planning`
   skill, any prompt templates still naming `mcp__cc-session-tools__*`.

Grep gates for completion: zero hits for `createSdkMcpServer`, `cc-session-tools`,
`cc-graph-workflow`, `setMcpServers` in `src/`.
