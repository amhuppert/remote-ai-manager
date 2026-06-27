# Session Alignment Gap Analysis

## Analysis Summary

- The current Focus Mode implementation is not isolated. Creation modes, objective persistence, initialization conversations, `memory-bank/focus.md`, UI labels, chat spawning, optimistic mode, tests, and runtime prompt injection all depend on `fast | focus | optimistic`.
- There is no session-level Alignment domain today. Reference documents are passive file registrations, graph workflow charters are immutable execution artifacts, and AskUserQuestion is a blocking runtime tool. None of those can directly become the authoritative mutable Alignment state.
- Runtime propagation is the highest-risk implementation area. Current `sessionInstructions` are mostly baked at runtime creation, and the Codex backend injects them only on the first turn, so active Alignment updates will not automatically reach live runtimes.
- The codebase has good reusable pieces: slash-command parsing and queued command dispatch, the AskUserQuestion schema/panel shape, focus confirmation placement, ApprovalGatePanel styling, graph charter rendering/hash ideas, DocsPanel display, state-store migrations, and SSE/broadcast infrastructure.
- The design phase needs to choose a dedicated storage/service shape, define how `/align` drafts and approvals interact with conversations, and decide whether Alignment reaches agents through per-turn preamble text, runtime recreation, or both.

## Document Status

- Specification: `session-alignment`
- Target language: English (`spec.json.language = "en"`)
- Current phase: `requirements-generated`
- Requirements approval: generated but not approved

This gap analysis proceeds because validation can run before approval, but the findings are non-binding until requirements are reviewed and approved.

## Requirements-to-Asset Map

| Requirement | Existing assets | Gap classification |
| --- | --- | --- |
| R1. Replace Focus Mode with Normal/Optimistic creation modes | `src/lib/sessions/schemas.ts`, `src/lib/sessions/service.ts`, `src/lib/sessions/route-handlers.ts`, `src/features/project-detail/components/CreateSessionModal.tsx`, `ModeDot.tsx`, `SessionRow.tsx`, `src/lib/chat-spawning/*`, state-store sessions table | Missing: `normal` enum/default, API contract, UI labels, migration from `fast` to `normal`, removal of `focus` creation path. Constraint: persisted `focus` rows need a deliberate handling choice; adding backward compatibility requires Alex's explicit approval. |
| R2. Alignment lifecycle is presence-based, not creation-mode-based | Session state and reference document listing exist, but no Alignment state | Missing: active/draft Alignment model, presence predicate, session indicator, `/align` suggestion behavior, and explicit exclusion from optimistic/autonomous sessions. |
| R3. `/align` drafts or redrafts the charter | Conversation command parser/service/queue supports `/commit` and `/merge`; prompt editor slash popup has command suggestions | Missing: `/align` command schema, dispatch path, draft-generation service, durable draft state, and agent-facing prompt/tool contract for producing free-text charter content. |
| R4. Charter approval gate | `FocusConfirmationBar`, `ApprovalGatePanel`, graph approval-gate service pattern | Missing: draft-specific approval API, reject/regenerate flow, active-vs-draft semantics, and UI copy/state for "Approve Charter". Constraint: focus initialization currently archives the init conversation; Alignment approval must not. |
| R5. Decision proposal tool and auto charter update | AskUserQuestion schemas, MCP tool, answer route, panel, and runtime resolver | Missing: non-blocking decision proposal tool/service, durable decision proposal state, bulk approval/rejection, append-only decision log write, auto-sent follow-up message to the same conversation, and auto-activation of the revised charter. Constraint: AskUserQuestion is disabled for autonomous turns and blocks a runtime; it should be reused as UI shape, not as the state authority. |
| R6. Decision log is append-only and not injected | No session decision log domain exists | Missing: decision log table/repo/API/UI, approved/rejected status, reverse-chronological presentation, optional origin message references, and strict exclusion from runtime injection except when summarized into the active charter. |
| R7. Active charter injected every turn with live runtime propagation | `prepareTurnForMachine` builds `sessionInstructions`; Claude runtime receives `systemPrompt.append`; Codex runtime injects instructions only on first turn; runtime recreation currently watches model/effort/output format | Missing: active charter prompt assembly, inline-vs-digest threshold, pointer text, `runtimeAlignmentVersion`, `lastSeenAlignmentVersion`, stale runtime detection, and a regression test proving live runtime propagation. Unknown: whether per-turn preamble alone is sufficient across both Claude and Codex backends. |
| R8. Versioning, history, rollback, and worktree mirror | SQLite state-store, additive schema columns, Umzug migrations, graph charter hash/render helpers, artifact/reference document registry | Missing: authoritative Alignment tables/service, version history, draft history, diff and rollback APIs, mirror writer for `.cc/session-alignment/charter.md`, and reference-doc registration for transparency only. Constraint: reference documents cannot be the source of truth because they only store file path and description. |
| R9. UX discoverability and state updates | `SessionInfoStrip`, `RightPane`, `DocsPanel`, active conversations API, conversation SSE schemas, broadcaster | Missing: Alignment indicator, active/draft/decision-log view, draft preview, version/diff controls, `alignment-updated` style event or cache invalidation path, and active-conversation metadata for sessions needing Alignment attention. |
| R10. Remove `objective` and `<objective>` injection | `objective` is in schemas, DB rows, session repo, creation service, optimistic workflow, chat spawning, tests, and `prepareTurnForMachine` | Missing: replacement prompt path for normal and optimistic sessions, removal of objective-backed prompt injection, test rewrites, and data migration strategy. Constraint: physical DB column removal may require a schema-version bump or rebuild strategy; logical removal can leave the column unused if approved in design. |

## Current Implementation Notes

### Creation Modes and Objective

- `sessionCreationModeSchema` currently accepts `fast`, `focus`, and `optimistic`, while `sessionStateSchema` stores `objective` and defaults `creationMode` to `fast`.
- Session creation service has separate `createSessionFast`, `createSessionFocus`, and `createSessionOptimistic` paths. Focus creates an initialization conversation and writes a placeholder `memory-bank/focus.md`; optimistic stores instructions as `objective`.
- Chat spawning maps non-fast sessions to an objective, so proposed session creation will need the same mode contract update.
- Tests explicitly assert `focus` remains valid and `fast` is the default. Those tests are now useful characterization targets for red-green migration work.

### Prompt and Runtime Propagation

- `prepareTurnForMachine` registers `memory-bank/focus.md` as a passive reference document and builds `sessionInstructions`, including `<objective>...</objective>` when present.
- Claude runtime receives `sessionInstructions` through `systemPrompt.append` when the runtime is created.
- Codex runtime currently includes `sessionInstructions` only on the first turn.
- Existing runtime recreation only accounts for model, reasoning effort, and output format changes. Alignment requires a new invalidation criterion or a backend-agnostic per-turn injection mechanism.

### Commands and Queues

- `/commit` and `/merge` are centralized through `parseConversationCommand`, conversation command service, live dispatch, queued command handling, and prompt editor suggestions.
- `/align` can reuse that path, but it should probably return a different command outcome than commit/merge because it creates or updates draft Alignment state rather than dispatching a git job.
- Queued commands are claimed one-at-a-time at the head of the prompt queue. Design should specify whether `/align` follows the same single-command semantics.

### AskUserQuestion and Approval UI

- AskUserQuestion already supports multiple questions, options, recommended flags, tradeoff text, notes, required answers, and multi-select.
- The tool is runtime-scoped and blocks until an answer returns. Decision proposals need durable session state and should survive UI refreshes independently of a runtime resolver.
- `ApprovalGatePanel` and graph approval services provide useful patterns for user review, but graph workflow approval state is scoped to workflow executions and should not be reused as Alignment storage.

### Reference Documents and DocsPanel

- `reference_documents` stores only `project_path`, `session_name`, `file_path`, `description`, and timestamps.
- `DocsPanel` reads markdown from worktree files and displays registered reference documents.
- Alignment should use reference documents only as a discoverable mirror, likely by registering `.cc/session-alignment/charter.md`. The authoritative active/draft/version state should remain in app state.

### Graph Workflow Charter Reuse

- Graph workflow charters are structured, immutable snapshots attached to executions.
- Useful reusable ideas include canonical rendering, digest rendering, hash computation, source-of-truth language, and materialized `.cc/.../charter.md` mirrors.
- Session Alignment is free-text, mutable, session-scoped, and explicitly out of scope for graph workflows. Reusing the graph schema or execution snapshot model would conflict with the requirements.

## Implementation Options for Design Phase

### Option A: Extend Session Rows and Reference Docs

Store active/draft Alignment fields directly on the session row, keep version metadata as JSON, and mirror the active charter through the reference document system.

Pros:
- Smallest number of new modules and tables.
- Session aggregate reads can include Alignment status without extra joins.
- Fastest path for basic active-charter prompt injection.

Cons:
- Version history, rollback, decision log, and draft history become awkward JSON blobs.
- Session rows become a dumping ground for a mutable document subsystem.
- Reference documents remain passive and cannot enforce source-of-truth rules.
- Harder to test as a deep module.

### Option B: Dedicated Session Alignment Domain

Add a dedicated domain under `src/lib/session-alignment/` with schemas, repo, service, route handlers, mutations, and state-store tables for active versions, drafts, decisions, per-session seen versions, and mirror metadata.

Pros:
- Clear source of truth and information hiding.
- Natural fit for version history, diff, rollback, draft approval, and append-only decisions.
- Easier to test with pure helpers and repo/service contract tests.
- Avoids overloading reference documents or graph workflow state.

Cons:
- More files and API integration work.
- Session list, active conversations, prompt injection, DocsPanel, and SSE all need explicit integration.
- Requires careful transaction boundaries for "approve decision -> append log -> enqueue/dispatch follow-up -> activate charter".

### Option C: Dedicated Authority with Existing UI/Discovery Reuse

Use a dedicated Session Alignment service and tables as the authority, then reuse existing UI and platform surfaces:

- `/align` through conversation-command infrastructure.
- Approval display through an Alignment-specific wrapper around existing panel styling.
- Decision proposal display using AskUserQuestion option/panel primitives backed by Alignment state.
- DocsPanel/RightPane as the discovery surface, with `.cc/session-alignment/charter.md` registered as a mirror.
- Graph charter renderer/hash concepts adapted for free-text content.
- Prompt injection integrated in conversation runtime preparation with either per-turn preamble, runtime version invalidation, or both.

Pros:
- Best alignment with the requirements and project architecture.
- Keeps source-of-truth state explicit while avoiding a parallel document browser.
- Lets design reuse proven UI patterns without coupling to graph workflow or blocking question state.

Cons:
- Broadest integration surface.
- Needs disciplined sequencing and characterization tests to avoid regressions in session creation and runtime behavior.

## Effort and Risk

Estimated effort: XL. This touches API schemas, DB schema and migrations, session creation, runtime prompt plumbing, command dispatch, queue semantics, UI state, reference document display, SSE/cache updates, and a large test surface.

Highest risks:

- Runtime propagation: active Alignment updates may not reach existing Claude or Codex runtimes unless the design changes per-turn input or runtime invalidation.
- Migration: `fast` to `normal`, removal of `focus`, and removal of `objective` affect persisted data and many tests.
- State authority: using reference documents or graph charters as the source of truth would violate requirements and create rollback/versioning problems.
- Decision auto-update: approved decisions require an atomic-enough sequence across decision log writes, transcript/message queue updates, agent rewrite, and active charter activation.
- Legacy focus sessions: the requirements say no focus-to-Alignment migration, but schemas that reject `focus` can break old rows unless the design explicitly chooses how to handle them.

## Recommended Design Direction

Use Option C as the starting design candidate: dedicated Alignment authority, existing UI/discovery reuse, and explicit runtime propagation work. This is not an implementation decision; it is the lowest-risk design baseline to review because it satisfies the source-of-truth and version/history requirements without misusing existing subsystems.

Design should sequence work in small red-green slices:

1. Characterize current session creation modes, objective injection, and runtime instruction behavior.
2. Add mode schema/API migration from `fast` to `normal` and remove focus creation behavior from new flows.
3. Introduce Session Alignment storage/service with active version, draft, history, rollback, and mirror write tests.
4. Add `/align` parsing and command handling that drafts Alignment without archiving conversations.
5. Add active charter injection and a regression test proving existing live runtimes see changed Alignment.
6. Add decision proposal state, decision log, and auto-update flow.
7. Add SessionInfoStrip/DocsPanel/RightPane UI integration and SSE/cache invalidation.

## Research Needed Before Design Approval

- Prove the runtime propagation mechanism with tests for both Claude and Codex backends. The design must not rely on first-turn-only instructions.
- Decide the active-charter injection format: inline threshold, digest format, pointer text, and where digest content is generated.
- Define the Alignment storage schema: draft table, version table, decision table, version counters, content hashes, origin message references, and rollback semantics.
- Define `/align` tool/prompt contract: how the agent proposes a free-text charter, how redrafts preserve user intent, and how approval activates the draft.
- Define the decision proposal tool contract: option schema, bulk approval semantics, rejected decision handling, and the exact transcript message that CC auto-sends after approval.
- Decide the UI placement inside `RightPane`/`DocsPanel`: active charter view, draft preview, decision log, history, diff, and rollback controls without creating a parallel document registry.
- Decide how to handle persisted legacy `focus` rows when creation schemas stop accepting `focus`.
- Decide whether the physical `objective` column remains unused or is removed through a schema-version migration.
- Specify SSE/cache invalidation for Alignment updates so open session views and active conversation lists stay current.
- Confirm graph workflows continue using their immutable graph charters and do not consume session Alignment.

---

# Design-Phase Verification & Decisions (2026-06-26)

Discovery type: **Light / Complex-Integration** — the feature is an extension to existing
systems, but runtime propagation (R7) carried enough risk to warrant source-level re-verification.
The gap analysis above was re-confirmed via parallel code-reading subagents; the load-bearing
findings and the resolved open decisions are recorded here.

## Verification Outcomes (re-confirmed touchpoints)

- **Creation modes / objective** — `sessionCreationModeSchema = z.enum(["fast","focus","optimistic"])`
  default `"fast"` (`src/lib/sessions/schemas.ts:29-34,62`); `objective` at `:61`; creation paths
  `createSessionFast/Focus/Optimistic` (`src/lib/sessions/service.ts:453-572`); focus writes
  `memory-bank/focus.md` (`:340-358`) + `initialization` role (`:279`); optimistic stores
  instructions as `objective` (`:546`); columns `objective TEXT`, `creation_mode TEXT NOT NULL
  DEFAULT 'fast'` (`state-db.ts:142-143`); request schema discriminated union (`schemas.ts:134-154`);
  chat-spawning objective map (`spawn-service.ts:199-202`); UI `CreateSessionModal`/`ModeDot`/`SessionRow`.
- **Propagation (load-bearing)** — `sessionInstructions` assembled once in
  `createManagedBackendRuntime` (`actor-implementations.ts:1491-1505`), `<objective>` at `:1499-1501`.
  Claude bakes them into `systemPrompt.append` once at creation
  (`claude/conversation-runtime.ts:910-916`); **Codex injects them only on the first turn**
  (`codex/conversation-runtime.ts:378-387`, `isFirstTurn`); per-turn dispatch hardcodes
  `sessionInstructions: []` (`actor-implementations.ts ~1063`). `shouldRecreateRuntime` recreates
  only on model/effort/outputFormat change (`:592-613`), called at `:1420-1444`; the recreate path
  re-fetches fresh `sessionState` (`:1449-1452`) and rebuilds `sessionInstructions`.
  **Conclusion: a mid-session charter change cannot reach a live runtime today.**
- **Slash machinery** — `parseConversationCommand` (`conversation-commands/parse.ts:3,12-26`,
  `COMMANDS=["commit","merge"]`); discriminated union (`schemas.ts:3-6`); dispatch
  (`dispatch.ts:16-37`) → service eligibility→generate→job (`service.ts:116-367`); queue holds
  commands one-at-a-time at head (`prompt/queue.ts:191-204`); suggestions
  (`PromptEditorSlashCommandPopup.tsx:33-55`); `FocusConfirmationBar` (`{onConfirm,disabled?,loading?}`)
  + `ApprovalGatePanel` reusable; **focus finalization archives the init conversation — Alignment
  must NOT archive.**
- **AskUserQuestion / charter / storage** — question/option/note schema
  (`conversations/schemas.ts:86-114`), answer wire `{selected,note,skipped,question}` (`:296-306`),
  blocking resolver in-memory (`ask-user-question-tool.ts:159-164`), disabled for autonomous turns.
  Graph charter `renderCharterMarkdown`/`renderCharterPromptSection`/`computeCharterHash` are
  **bound to the structured `WorkflowCharter`** (`workflow-graph/charter/render.ts:80-170`) — not
  directly reusable for free-text. `reference_documents` stores only path+description
  (`state-db.ts:245-255`) → cannot be authority. Schema floor + `ADDITIVE_COLUMNS`
  (`state-db.ts`), Umzug migrations index (`migrations/index.ts`), `KNOWN_SCHEMA_VERSION=0`
  (`state-db.ts:27`); SSE union + `ScopedStatusEvent` (`api/sse-events.ts`). **No generic
  per-session document substrate exists** beyond `reference_documents`.

## Synthesis Outcomes

- **Generalization (deferred, deliberately).** Session alignment and graph-workflow charters are
  both "governing documents." A shared core is the requirements' only sanctioned future
  convergence, **not v1**. We generalize the *interface concept* (digest+pointer governing-context
  framing) via small free-text helpers, but keep the implementation session-scoped and mutable —
  no shared abstraction is built, no graph code is touched (R12.1, YAGNI).
- **Build vs. adopt.**
  - *Adopt the patterns, build thin free-text helpers* — the structured graph renderer/hash cannot
    serve free-text; reusing the *ideas* (sha256 content hash, digest+pointer, `.cc` mirror) is
    cheap and avoids forcing free-text into `WorkflowCharter`. Building `renderAlignmentPromptSection`
    + `computeAlignmentHash` is ~40 lines and fully testable.
  - *Adopt UI shape, not the blocking resolver* — reuse the AskUserQuestion option/note panel for
    decision approval, but back it with durable proposal state (a refresh- and turn-boundary-survivable
    table), because the flow must end the turn and auto-send a follow-up message.
  - *Adopt the existing recreation seam* for propagation rather than building a per-turn backend
    channel.
- **Simplification.** One `SessionAlignmentService` (deep module) over three tables + one additive
  column; no separate pending-write table (the **draft row carries the auto-activate intent**); no
  LLM-generated digest (deterministic truncation+pointer); no concurrency guard (out of scope,
  last-writer-wins documented).

## Design Decisions

### Decision: Propagation = version-gated runtime recreation (not per-turn preamble)
- **Context**: R7.3 demands guaranteed delivery to already-running runtimes; verification shows
  none exists today.
- **Alternatives**: (A) true per-turn preamble injected fresh each turn; (B) stale-runtime
  detection + recreation when `runtimeAlignmentVersion < activeAlignmentVersion`.
- **Selected**: (B). Extend `shouldRecreateRuntime` with an `alignmentVersion` comparison; stamp the
  runtime with the version baked into its instructions; read `getActiveVersion` (cheap) before the
  recreate gate; the existing recreate path rebuilds instructions with the charter section.
- **Rationale**: reuses a proven seam with **zero** backend-abstraction change, and is the **only**
  mechanism that propagates uniformly to Codex — its first-turn-only injection would ignore a
  post-turn-1 preamble, whereas a recreated runtime's first turn carries the charter. Charter
  changes are rare, so recreation cost is acceptable.
- **Trade-offs**: recreation discards the in-memory runtime (resume preserves continuity, as the
  existing model-change recreation already does); one extra integer read per turn.
- **Follow-up**: the mandated R7 regression test must prove recreation + charter delivery for both
  Claude and Codex runtime types, and that recreation preserves conversation continuity.

### Decision: Dedicated authoritative domain + dedicated tables (research Option C)
- **Context**: app state must be source of truth (R8.2); version history + append-only decision log
  + transient proposals.
- **Alternatives**: (A) session-row JSON blobs; (B/C) dedicated domain/tables.
- **Selected**: dedicated `src/lib/session-alignment/` + three tables + one additive conversations
  column.
- **Rationale**: clean information hiding and round-trip-testable durability; reference docs are
  pointers (can't be authority); session row must not become a document dumping ground.
- **"No parallel registry" reconciliation**: that constraint governs *discoverability* (we reuse
  DocsPanel + reference-docs for the mirror); the requirements explicitly assign the *authority*
  layer to `SessionAlignmentService`. A dedicated authority is therefore compliant.

### Decision: Unified draft row carries activation intent
- **Context**: one agent-facing write tool must serve both gated `/align` drafts and auto-activating
  post-decision rewrites (R3, R5.5, R11).
- **Selected**: `/align` and decision-approval each create an empty `draft` version row; the agent's
  `write_session_charter` fills it; the row's `auto_activate` flag (set by CC, never the agent)
  decides immediate activation vs. human banner.
- **Rationale**: gating stays in CC (agent-offloading principle); removes the need for a separate
  pending-write table.
- **Trade-offs**: losing the marker on a mid-flight server restart degrades to a manual approve
  (safe); v1 last-writer-wins if both draft sources race (concurrency guard out of scope).

### Decision: `objective` logical removal; `fast`/`focus`→`normal` hygiene migration
- **Selected**: remove `objective` from the domain schema/serialization/injection; leave the
  nullable physical column unwritten (no `KNOWN_SCHEMA_VERSION` bump, no brick). Idempotent Umzug
  `0004` maps `creation_mode IN ('fast','focus')` → `'normal'`.
- **Rationale**: additive/forward-compatible per DB-migration rules. Mapping a stale `focus` enum
  value is value hygiene that keeps old rows readable — **distinct** from the forbidden
  focus-session/`focus.md`-seeding migration (no alignment is derived from old focus sessions).
- **Follow-up (sign-off)**: confirm the defensive `focus`→`normal` value mapping is acceptable, and
  that logical (not physical) `objective` removal is acceptable.

## Risks & Mitigations
- **Codex first-turn-only injection** — mitigated by recreation (a recreated runtime injects on its
  fresh first turn); verified by the R7 test.
- **Recreation continuity loss** — recreation must resume; covered by the R7 test (assert transcript
  continuity), and de-risked by the existing model-change recreation already doing this in prod.
- **Decision auto-update atomicity** — approve→log→draft→enqueue→fill→activate spans turns; modeled
  as a transactional activation with a recoverable auto-activate marker; failure degrades to manual
  approve.
- **Migration safety** — idempotent `0004`; logical `objective` removal avoids a breaking rebuild.
- **Scope creep into graph workflows** — hard boundary: no graph code modified; shared core deferred.
