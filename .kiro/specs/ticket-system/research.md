# Gap Analysis: ticket-system

Date: 2026-07-10 · Phase: post-requirements, pre-design · Method: 4 parallel codebase research passes (conversation-commands, refs/injection, sessions/state-store, CLI/UI)

## 1. Current State Investigation

### Assets directly reusable

| Surface | Asset | Location |
|---|---|---|
| Slash commands | Whole-message parse (`COMMANDS` array), eligibility + dispatch service, LLM fill-in via `executeWorkflowTaskRun` with JSON-schema output + fallback, client autocomplete (`BUILT_IN_CLAUDE_COMMANDS`) | `src/lib/conversation-commands/{parse,schemas,service,generation,dispatch}.ts`, `src/lib/prompt/sdk-driver.ts:691-754`, `src/lib/prompt/queue.ts:276-289`, `PromptEditorSlashCommandPopup.tsx` |
| References | XML ref wire format with embedded `read-command`/`compaction-command`; `segmentTextByRefs()` designed for new ref types; Tiptap paste→chip extension; serializer renders chips back to XML; copy-button precedent | `src/lib/conversations/{ref-parser,ref-segments,schemas}.ts`, `src/lib/prompt-editor/{ref-paste-extension,serializer}.ts`, `src/components/CopyMessageRefButton.tsx` |
| System prompt assembly | Flat `sessionInstructions` block array (ccContext, charter injection, reference-docs list, TDD, …) — new blocks are additive; per-turn charter fetch precedent (`getActiveInjection`) | `src/lib/workflows/conversation/actor-implementations.ts`, `src/lib/session-alignment/{service,render}.ts` |
| Charter | Programmatic charter activation precedent: `copyActiveCharter()` (session fork) and `approveDraft()`; render/injection handled downstream | `src/lib/session-alignment/service.ts` |
| Session creation + auto first turn | `provisionSession()` shared by all creation flows; `createSpawnedSession` + `setSessionSpawnedFrom` metadata precedent; `dispatchFirstTurn()` (readiness-gated, exactly-once) for agent-immediate mode | `src/lib/sessions/service.ts`, `src/lib/chat-spawning/spawn-service.ts`, `src/lib/prompt/first-turn-dispatch.ts` |
| State store | End-to-end repo template: repo + DDL floor + aggregate wiring + setters + index exports + `assertRoundTripDurability` contract test | `src/lib/state-store/reference-documents-repo.ts` (+ `.contract.test.ts`), `state-db.ts`, `state-aggregate.ts`, `setters.ts` |
| Central content snapshots | Worktree-independent store under configDir (`captureFromWorktree`/`read`) + materializer writing stored content into a lane worktree | `src/lib/workflow-graph/{shared-document-store,document-materialization}.ts` |
| Compaction | Create/refresh/read compaction artifacts (server service + `cctl conversation compact`) for pre-compacting attached conversations | `src/lib/context-artifacts/`, conversation read/compaction route handlers |
| SSE | Broadcaster with replay buffer; envelope stamp/strip helpers; client invalidation-map pattern | `src/lib/events/{broadcaster,sse-envelope}.ts`, `src/lib/mcp/sse-invalidation.ts`, `NotificationListener.tsx` |
| CLI | Group registration pattern (`docs.ts` + `docs.help.ts`), help-registry SSOT, identity resolution (`resolveSessionContext`), token-gated endpoint convention | `src/cli/core.ts`, `src/cli/commands/docs.{ts,help.ts}`, `src/cli/help-registry.ts`, `src/cli/shared.ts` |
| UI | Route-shell → feature-dir convention; per-domain `{queries,mutations,query-keys}.ts`; Radix primitives (Select, SegmentedControl, Tabs, Dialog, AlertDialog, Badge, StatusDot); markdown render components + Tiptap editor; project-detail tab-state pattern | `src/features/project-detail/`, `src/lib/projects/{queries,query-keys}.ts`, `src/components/ui/` |

### Conventions extracted
- Schema-first domains: `src/lib/<domain>/schemas.ts` (Zod, `z.infer`), route handlers in-domain, thin `src/app` shells.
- Serialized single-writer SQLite; repos with row codecs + prepared statements; additive DDL in the synchronous schema floor; contract tests are mandatory for persisted fields.
- Comprehensive structured logging (`createLogger`) on all new server code; DI over `vi.mock` for tests.
- Responsiveness contract: every mutation optimistic or visibly pending; SSE drives invalidation.

## 2. Requirement-to-Asset Map

| Req | Need | Existing asset | Gap tag |
|---|---|---|---|
| R1 Creation/identity | tickets table, schemas, CRUD service/routes | repo template exists | **Missing**: tickets domain (new, patterned) |
| R1.5–6 Per-project sequential numbers | scoped counter, never reused | none (only global `AUTOINCREMENT`) | **Missing**: per-project allocator; trivial under the serialized write queue (MAX+1 or counters table) |
| R2 Lifecycle | free transitions + one automation | plain field mutation | none — simple CRUD |
| R3 Attachments | typed attachment entries + descriptions; file snapshot durability | shared-document-store pattern (execution-scoped) | **Constraint/Adapt**: needs ticket-scoped central store analog under configDir; deletion cleanup |
| R3.5–6 Disclosure index/graph | index render + on-demand retrieval + ticket→ticket navigation | cctl three-tier output conventions | **Missing**: `cctl ticket get` shape carrying index |
| R4 Start work | session creation + link + modes + failure atomicity | `provisionSession`, `spawnedFrom` metadata precedent, `dispatchFirstTurn` | **Missing**: ticket↔session link storage + start orchestration (composes existing) |
| R5.1–2 Materialization | files→worktree + reference-doc registration; conversation pre-compaction→readable refs | `createReferenceDocument`, document-materialization pattern, compaction service | **Missing**: ticket materializer orchestration (composes existing) |
| R5.3 Auto-approved charter | programmatic create+activate at provision | `copyActiveCharter`/`approveDraft` precedents | **Missing**: small seam; verify draft-flow bypass is clean |
| R5.4–5 Live ticket block | per-turn block from live ticket state | `sessionInstructions` array + per-turn charter fetch precedent | **Missing**: block builder (patterned); perf care per PERFORMANCE.md |
| R6 Ticket refs | new XML ref type, paste→chip, copy button, agent resolution | ref subsystem explicitly extensible; raw XML reaches agent with embedded commands | **Missing**: `<ticket-ref>` schema/segmentation/chip/serializer + copy button |
| R7 /ticket command | parse entry, generation, immediate create, auto-attach | conversation-commands subsystem; `/align` shows non-job outcome path | **Missing**: ticket case; **Unknown**: how the generation turn sees conversation context (commit uses git state, not transcript) |
| R8 CLI parity | `cctl ticket` group + endpoints | docs group template, help SSOT | **Missing**: group + endpoints + skill-doc update (patterned) |
| R9 UI list/board/detail | global route, filters, Kanban DnD, detail editor, live updates | route/feature/query conventions; Radix primitives; markdown editor | **Missing**: tickets feature; **Unknown**: DnD approach — no DnD library in package.json, no board precedent |
| R10 Session indicators | badge + navigation on session surfaces | Badge/StatusDot; `spawnedFrom` list-item plumbing precedent | **Missing**: link surfacing in session list items |

### Complexity signals
- Mostly CRUD + orchestration composing proven primitives; two genuinely new UI capabilities (Kanban drag-drop, ticket-ref chips — the latter patterned); one new cross-cutting object (central ticket content store).

## 3. Implementation Approach Options

### Option A — Extend existing components
Fold tickets into `sessions`/`projects` domains (columns on existing tables, UI inside project-detail).
- ✅ fewest new files
- ❌ tickets have a distinct lifecycle, cross-project queries, and their own attachment model; would bloat `SessionState` and violate the domain-per-concept structure; additive columns on hot tables carry the documented check-then-ALTER build race.
**Not recommended.**

### Option B — New domain composing existing primitives
New `src/lib/tickets/` (schemas, repo, service, route-handlers, queries/mutations/keys), new `src/features/tickets/`, new `cctl ticket` group, new `<ticket-ref>` type — every integration point (slash command, charter, first turn, reference docs, compaction, SSE) composed from the existing seams identified above; session linkage carried ticket-side with a minimal session-list surfacing hook.
- ✅ matches CC's composable-primitives philosophy and structure.md exactly; testable in isolation; no structural rewrites anywhere
- ❌ ~6 subsystems touched at their extension points; more files
**Recommended.**

### Option C — Hybrid / phased delivery of B
Same structure as B, sequenced: (1) domain + CRUD + CLI + list/detail UI, (2) start-work + materialization + charter + live block, (3) ticket refs + /ticket command + Kanban polish.
- ✅ each phase independently verifiable; de-risks the two Unknowns before they block core value
- ❌ needs cross-phase interface discipline
**Recommended as the task-phasing of Option B.**

## 4. Effort & Risk

| Area | Effort | Risk | Justification |
|---|---|---|---|
| Tickets domain (schemas/repo/service/routes/SSE) | M | Low | Direct template (reference-documents); counter is new but single-writer-safe |
| `cctl ticket` group | S–M | Low | docs.ts mirror + help SSOT; read `.kiro/steering/cli.md` first |
| Start-work + materialization + charter + live block | M–L | Medium | Composes 5 seams; atomicity on provisioning failure; charter bypass needs verification |
| Ticket refs (XML/chip/copy/resolve) | M | Low–Medium | Subsystem explicitly extensible; cross-project resolution endpoint new |
| /ticket slash command | S–M | Medium | Pattern exists; generation-context question unresolved |
| UI list/board/detail | L | Medium | New Kanban + DnD capability, no precedent; rest is conventional |
| **Overall** | **XL (decomposable)** | **Medium** | Breadth, not depth — no architectural shifts |

## 5. Recommendations for Design Phase

**Preferred approach**: Option B structured, Option C phased.

**Key design decisions to make**:
1. Ticket↔session link storage (ticket-side session history array vs. session-side pointer vs. both) with focused accessors per PERFORMANCE.md for list rendering.
2. Ticket content store shape: generalize `shared-document-store` vs. sibling `ticket-content-store` under configDir; snapshot retention on ticket delete.
3. Per-project number allocation mechanism inside the serialized write queue.
4. `<ticket-ref>` attribute set + embedded commands (`cctl ticket get …`), global (cross-project) resolution.
5. Live ticket block: data source, freshness, size discipline (index only, no content inlining).

**Research Needed (carry forward)**:
- How the `/ticket` generation turn accesses conversation context — transcript window, compaction, or an in-conversation authoring turn (the `/align` shape) instead of a detached generation turn.
- Kanban DnD: adopt `dnd-kit` vs. native HTML5 DnD; keyboard-accessible status change fallback (design-system + APG review).
- Charter auto-activation seam: confirm `approveDraft()` (or a new service function) cleanly creates an active charter with no open draft and no attended-turn requirement.
- Compaction pre-generation timing: at attach vs. at start (staleness vs. cost).
- SSE: new ticket event family + client invalidation map scope (remember the `.strict()`/`_sentAt` gotcha).
- Whether Blocked/Closed columns need WIP affordances on the board (pure UI, low stakes).

**Constraints to respect**:
- Shared DB across branches: additive-only schema; new tables preferred over new columns on existing hot tables (documented ALTER race).
- Worktree isolation: snapshots live in configDir, never in any worktree; materialized payloads go under ignored namespaces (`.cc/`).
- Responsiveness contract for every ticket mutation (drag-to-status especially).
- Structured logging + DI testing standards on all new modules; contract test for the tickets repo from day one.

## 6. Design Decisions (design phase — two-agent collaboration, 2026-07-10)

Produced by parallel Claude/Codex drafts (`design.agent_one.md` / `design.agent_two.md`), cross-review, one negotiation round, and an evidence-based resolution (`memory-bank/collaboration/24cc5b2a-8427-4564-806e-b095adb20819/round-1/agent_one/resolution_decision/main.md`). Canonical result: `design.md`. All §5 carry-forward questions are now resolved:

1. **Ticket↔session link storage** — ticket-side `ticket_sessions` (no session FK): `ended_at`/`end_reason` audit, dual partial active-unique indexes, join-derived liveness with the `session.created_at <= link.linked_at` name-reuse guard; reconciliation demotes links, never status.
2. **Content store** — sibling `ticket-content/<ticket-uuid>/<attachment-uuid>/<name>` under configDir (not a generalization of the workflow shared-document store: lifecycles differ). Durable snapshots: file bytes at attach; conversation compaction markdown at attach (ensure-if-missing) + refresh/re-snapshot at start; resolution prefers live artifact, falls back to the labeled snapshot; raw-transcript read commands exposed while the source exists (5.6).
3. **Numbering** — monotonic `ticket_counters` (no project FK) allocated with the insert in one write-queue transaction; deletes never decrement.
4. **`<ticket-ref>`** — self-closing XML: `project-name`, `ticket-number`, `identifier`, `title`, `read-command` (`cctl ticket get project#n`); agent-side resolution; additive extensions of the existing ref pipeline.
5. **Live ticket block** — complete attachment index rebuilt every turn into the transient *effective prompt* (NOT `sessionInstructions`: persistent QuerySessions bake instructions at runtime creation); bounded per-entry description budget, entries never omitted.
6. **`/ticket`** — server-owned: awaited `executeWorkflowTaskRun` structured turn (resumes conversation `backendRef` → native context; bounded transcript rendering fallback when null), then server-side compaction ensure + snapshot + atomic create/auto-attach + deterministic notices.
7. **SSE** — lean `TicketListItem`-carrying `ticket-changed` deltas + pure idempotent list reducer sharing one filter/order module with optimistic mutations; exact invalidation only for absent detail/link data (per data-fetching steering).
8. **Kanban DnD** — adopt `@dnd-kit/core` only (React 19-compatible, keyboard sensor); no `sortable` in v1; non-drag status control mandatory.
9. **Start-work** — all-or-nothing: per-ticket start/delete lock, immutable entry snapshot, compact→provision→materialize→charter→final link+status transaction, `deleteSession` compensation exactly once, kickoff post-commit, restart-safe ordinal session names.
10. **Schema integrity** — `tickets` FK→`projects(root_path) ON DELETE CASCADE` (house convention; see corrections below) + best-effort blob cleanup on project delete; DDL CHECKs beneath Zod.

**Corrections to §1/§5 findings** (verified in code during resolution):
- `executeWorkflowTaskRun` routes through the conversation actor and **resumes `backendRef`** (`actor-implementations.ts:2472`) — task runs DO have native conversation context (supersedes the earlier "generation turn sees only its prompt" finding; `/commit` generation is conversation-aware).
- SSE steering explicitly prefers delta-carrying events + `setQueryData` when a thin event would force large-list invalidation; the MCP invalidation map is the invalidation-case reference, not the default rung.
- `projects` rows survive scans (`missing: true`, `discovery.ts:106`); only explicit `deleteProject` ("every trace", `sessions/service.ts:931`) removes the aggregate; sessions/conversations already FK-cascade from projects (`state-db.ts:155,237`).

## 7. UI design handoff (2026-07-10)

Alex produced the UI prototype in Claude Design; the handoff bundle lives at `memory-bank/prototypes/ticket-system-prototype/` (screens `00`–`06`, `project/handoff-notes.md`, frozen design-system bundle). Incorporated into `design.md` §"UI and Interaction" as the authoritative visual spec. Notable outcomes:
- New surface: **CreateTicketDialog** (screen 06) — UI creation form for R1.1, added to the File Structure Plan; all other surfaces map 1:1 onto the existing component plan.
- Status/type visual language fixed (token-only): status dot+rail treatments; type badges via an extension of `Badge tier="type"`'s `typeAppearance` map (`research`/`tech_debt`/`performance`) rather than hand-rolled badges.
- Two new keyframes (`tk-card-land`, `tk-sse-in`) go into `theme.css` as animation tokens (global-CSS guardrail respected).
- Prototype-only "end link" affordance on the active-session card is explicitly non-shippable (demos the 4.4 restart; real demotion is reconciliation-driven).
- No scope expansion beyond the 56 approved acceptance criteria.
