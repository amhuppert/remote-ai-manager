# CC CLI Migration — Master Design

**Status:** Design approved-pending-review · 2026-07-02
**Scope:** Replace Command Center's in-process MCP tools with a purpose-built CLI (`cctl`) + agent skills, backed by the CC server's HTTP API.

Documents in this set:

| Doc | Contents |
|---|---|
| `README.md` (this file) | Motivation, tool inventory & disposition, phase plan, risks, success metrics |
| [`01-cli-foundation.md`](./01-cli-foundation.md) | Binary build & distribution, env contract, auth, versioning, CLI conventions, testing strategy |
| [`02-tool-migrations.md`](./02-tool-migrations.md) | Per-tool endpoint + CLI command design, new API endpoints, lane tools, decommissioning checklist |
| [`03-ask-user-question-async.md`](./03-ask-user-question-async.md) | The AskUserQuestion async redesign (state machine changes, answer-as-message, edge cases) |
| [`04-progressive-disclosure.md`](./04-progressive-disclosure.md) | Help registry as single source of truth, graph-shaped progressive disclosure, dynamic help context, three-tier output contract (hint/reminders/instruction), lane reminders |
| [`05-workflow-definition-editing.md`](./05-workflow-definition-editing.md) | Targeted editing of saved workflow definitions (`cctl workflow edit` + outline/selector reads), operation vocabulary, revision guard, invariant gates |
| [`06-workflow-live-editing.md`](./06-workflow-live-editing.md) | Live editing of launched executions (`cctl workflow live …`), lifecycle classifier + frontier invariant, `liveRevision`, structural edit boundaries, execution-UI config display/editing |

---

## 1. Motivation (ranked)

1. **Reliability.** In-process SDK MCP servers require a dedicated babysitting subsystem:
   `SessionToolsSupervisor` (pre-turn rebinds, reactive rebind-on-stream-close, 2-strike kill
   escalation, single-flight rebind dedup — `src/lib/agent-backends/claude/session-tools-supervisor.ts`),
   a 30s MCP keepalive tick, and stream-closed threshold tracking in
   `src/lib/agent-backends/claude/query-session.ts`. A CLI invoked through Bash has no binding to
   break; failures become ordinary non-zero exits with readable errors, which agents recover from
   well. The entire recovery subsystem becomes deletable.
2. **Backend portability.** In-process SDK MCP servers exist only for the Claude backend. Codex
   sub-agents receive only *external* MCP servers (`src/lib/agent-backends/codex/task-runner.ts:233-255`
   translates portable stdio/http configs; in-process servers are structurally excluded). A CLI works
   for any backend that can run shell commands — and for agents running outside CC entirely.
3. **Planner-tool ergonomics.** `create_graph_workflow` / `replace_graph_workflow` have huge nested
   schemas, and agents must emit the entire workflow as inline tool arguments — one escaping error
   wastes the whole attempt. `cctl workflow create --file plan.json` + `cctl workflow validate`
   inverts this: plans become files the agent writes, validates, and iterates on cheaply.
4. **Token efficiency.** Real but modest for most tools (small schemas, small outputs, amortized by
   prompt caching). Concentrated in the planner tools. We will measure rather than assume
   (§6 Success metrics).

**Explicit non-goals:**

- External MCP servers (`playwright`, `chrome-devtools`, `next-devtools`) are untouched.
- Multi-user auth / remote-network hardening (Tailscale exposure) — the instance token (doc 01 §4)
  is a floor, not a full auth story.
- State-inspection/mutation debug commands (`cctl state …`) — a **separate future track**,
  deliberately excluded here. Prerequisite: token enforcement. Read-only commands first.
- No dual-mode operation. Each phase removes MCP registrations in the same change that ships the
  CLI equivalent; rollback is a revert. (Per project rule: no backward compatibility without
  explicit approval.)

## 2. Current state

Two in-process SDK MCP servers, both attached via `Query.setMcpServers()`:

- **`cc-session-tools`** (`src/lib/mcp-gateway/session-server.ts:256-365`) — 19 tools, session
  context injected via closures. Supervised by `SessionToolsSupervisor`.
- **`cc-graph-workflow`** (`src/lib/workflow-graph/workflow-execution-server.ts:358-378`, tools in
  `src/lib/workflow-graph/tool-server.ts:457-533`) — 4 tools for workflow execution lanes. Lane
  conversations get **only** this server (no cc-session-tools). Tool handlers are wrapped with a
  halt-check (`wrapMcpHandlerWithHaltCheck`) that must move to the API layer.

Roughly half the needed HTTP API already exists (graph-workflow lifecycle, dev servers, the answer
route). See disposition table below and doc 02 for gaps.

## 3. Tool inventory & disposition

Phase column refers to §4. "Endpoint" reflects what exists today (verified 2026-07-02).

### cc-session-tools (19)

| Tool | Endpoint today | CLI command | Phase |
|---|---|---|---|
| `send_notification` | Missing (only config GET/PUT + test send) | `cctl notify` | 1 |
| `register_document` | Missing (list/read exist) | `cctl docs register` | 1 |
| `list_documents` | Partial (GET exists) | `cctl docs list` | 1 |
| `delete_document` | Missing | `cctl docs delete` | 1 |
| `get_dev_servers` | Exists | `cctl dev list` | 1 |
| `ensure_dev_server` | Exists (start route) | `cctl dev ensure` | 1 |
| `stop_dev_server` | Exists | `cctl dev stop` | 1 |
| `list_graph_workflows` | Exists | `cctl workflow list` | 1 |
| `get_graph_workflow` | Exists | `cctl workflow get` | 1 |
| `get_graph_workflow_status` | Exists | `cctl workflow status` | 1 |
| `delete_graph_workflow` | Exists | `cctl workflow delete` | 1 |
| `list_templates` | Partial (global tier only) | `cctl workflow templates` | 1 |
| `start_graph_workflow` | Exists | `cctl workflow start` | 1 |
| `create_graph_workflow` | Exists (needs file-input + validate flow) | `cctl workflow create --file` | 2 |
| `replace_graph_workflow` | Exists (same) | `cctl workflow replace --file` | 2 |
| `write_session_charter` | Missing (approve/reject exist) | `cctl charter write --file` | 2 |
| `propose_decisions` | Missing (resolve exists) | `cctl decisions propose --file` | 2 |
| `run_codex` | Missing | `cctl codex run` (job-shaped) | 2 |
| `AskUserQuestion` | Answer route exists; ask missing | `cctl ask --file` | 3 |

### cc-graph-workflow (4)

| Tool | Endpoint today | CLI command | Phase |
|---|---|---|---|
| `complete_task` | Missing | `cctl workflow task complete` | 3 |
| `add_task` | Missing | `cctl workflow task add` | 3 |
| `upsert_shared_document` | Missing | `cctl workflow shared-doc upsert` | 3 |
| `request_collaboration` | Missing | `cctl workflow collab request` | 3 |

## 4. Phase plan

Each phase is independently shippable and ends with the corresponding MCP registrations removed.

**Phase 0 — Foundation** (doc 01)
`cctl` single-file bundle built alongside `next build`; installed to `<configDir>/bin/` at server
startup; env contract injected at the `QuerySessionOptions.env` seam (`CC_SERVER_URL`,
`CC_API_TOKEN`, `CC_PROJECT`, `CC_SESSION`, `CC_CONVERSATION_ID`, PATH prepend); instance token;
version handshake (`cctl doctor`); skill scaffold.
*Exit criteria:* an agent inside a CC session can run `cctl doctor` and get a green handshake.

**Phase 1 — Stateless session tools**
Notifications (new endpoint), reference documents (new POST/DELETE), dev servers, workflow
read/lifecycle ops. Skill sections shipped; tools deregistered from `session-server.ts`.
*Exit criteria:* all Phase-1 tools removed from MCP; before/after metrics captured (§6).

**Phase 2 — Authoring tools**
Planner file-based flow (`workflow create/replace/validate --file`), alignment submission endpoints
(charter/decisions), job-shaped `codex run`.
*Exit criteria:* `cc-session-tools` reduced to `AskUserQuestion` only.

**Phase 3 — Turn-control tools**
Lane tools (`complete_task` + halt-check at API layer, `add_task`, `upsert_shared_document`,
`request_collaboration`) and the AskUserQuestion async redesign (doc 03). Lane prompt templates
rewritten to instruct `cctl`.
*Exit criteria:* both in-process MCP servers empty; live-test pass per doc 03 §9.

**Phase 4 — Decommission**
Delete `mcp-gateway/`, `session-tools-supervisor.ts`, keepalive + stream-closed machinery,
`setMcpServers` rebind plumbing, tool wrapper files (service logic is retained — doc 02 §1).
Docs/steering sweep (CLAUDE.md, `command-center:agent-context` skill, workflows steering,
graph-workflow-planning skill). *Exit criteria:* no `createSdkMcpServer` call sites remain;
full suite green.

**Suggested spec slicing:** one kiro spec per phase (Phases 0+1 may merge). These documents are the
design input; requirements per spec should be derived from the relevant doc sections.

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Conversation-machine surgery for async ask (turn-end transitions feed UI, queue drain, notifications) | High | Doc 03 §4–5; machine-snapshot rehydration contract test; mandatory live-test pass (doc 03 §9) |
| Cooperative turn-end not honored after `cctl ask` / rotation-gate instruction | Medium | Same trust model as the shipped `complete_task` rotation gate; skill discipline; degradation is graceful (answer queues) |
| Agents forget the CLI exists (discovery) | Medium | Skill + one-line nudge in session system prompt; per-command guidance hints chain multi-step flows (doc 01 §6); lane prompts explicitly instruct `cctl` |
| Version skew CLI ↔ server | Medium | Server-owned binary + build-stamp handshake (doc 01 §3, §5) |
| Long ops vs Bash timeout ceilings (`codex run`) | Medium | Job-shaped endpoint + `--wait`; raise `BASH_MAX_TIMEOUT_MS` via env contract (doc 01 §2) |
| Orphaned server ops when Bash is killed mid-`--wait` | Low | Job model already decouples; jobs are cancellable/inspectable (doc 02 §5) |
| Invocation-layer validation weaker than Zod-at-dispatch | Low | `--file` inputs validated server-side with terse actionable errors; `workflow validate` pre-flight |

## 6. Success metrics

Capture before Phase 1 and after each phase (the logging/DuckDB tooling from
`cc-performance-log-analysis` applies):

- **Context overhead:** tokens consumed by tool schemas per fresh context window (before: both MCP
  servers' schemas; after: skill nudge + on-demand SKILL.md).
- **Invocation reliability:** MCP tool failure/retry rate vs CLI non-zero-exit rate; count of
  supervisor rebinds/kills per week (should go to zero, then the metric itself is deleted).
- **Code deletion:** `session-tools-supervisor.ts`, keepalive/stream-closed logic, rebind queue,
  `mcp-gateway/` — tracked as net-LOC removed in Phase 4.
- **Planner flow:** workflow-creation attempts per successful creation (expect ≥1 escaping/truncation
  retry eliminated per large plan).
