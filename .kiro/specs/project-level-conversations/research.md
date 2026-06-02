# Research & Design Decisions — project-level-conversations

## Summary

- **Feature**: `project-level-conversations` (foundation spec)
- **Discovery Scope**: Extension (generalizes existing conversation/prompt/state-store subsystems; integration-focused light discovery)
- **Key Findings**:
  1. `projectPath` already **is** the repo-root checkout. `resolveProjectPath()` returns `path.join(baseDir, name)` after verifying a `.git` entry exists there, so the "main worktree" for a project conversation is simply `projectPath`. No new worktree resolution is required — only a thin repo-root `ExecutionTarget` adapter.
  2. The execution seam already exists end-to-end. `executePromptStream(projectPath, session, …, options.executionTarget)` threads `executionTarget` to `ensureConversationActor`, which binds the actor's `worktreePath` to `executionTarget.worktreePath ?? session.worktreePath` and already enforces the **actor-rebind guard** (throws when a *running* actor would be rebound to a different worktree; stops+recreates an *idle* one). PLC-42's parallel posture and PLC-10's main-worktree binding fall out of this with no machine fork.
  3. Conversations are **physically nested** inside `SessionState.conversations[]` in the `ManagerState` aggregate, even though the SQLite `conversations` table is separate and keyed `(project_path, session_name, id)` with a **composite FK to `sessions(project_path, session_name)` ON DELETE CASCADE**. `mutateConversation`/`createConversation` route through `mutateSession`. A truly session-less conversation cannot live under a session row → it needs its own persistence path.
  4. Conversation runtime/lock/actor/persistence keys are all `${projectPath}::${sessionName}::${conversationId}`. Per-conversation single-flight + actor identity are keyed on this triple, so **distinct conversation ids already get independent actors and locks** — parallel turns across PLCs work natively as long as each PLC has a unique id, even when they share a sentinel `sessionName` and the same worktree path.
  5. SSE conversation events (`conversation-status`, `message-appended`, `conversation-created`, …) are **broadcast to all clients**; the client routes by reading `projectName`/`sessionName`/`conversationId` off the payload to invalidate the right React Query keys (`sse-reconnect.ts`). Events currently carry a **mandatory `sessionName`**. Generalizing the event shape with a `scope` discriminator (project events omit `sessionName`) is the right data-contract change; presentation/routing of project events is downstream.
  6. The active-conversations source (`active-conversations/route-handlers.ts`) walks `readState().projects[].sessions[].conversations[]` — a genuine whole-state reader (PERFORMANCE.md sanctions `readState` here). PLCs are not under any session, so the source needs a parallel walk over project conversations.

## Research Log

### Repo-root resolution & the existing ExecutionTarget

- **Context**: PLC-10/13 require running in the repo-root (main) worktree without creating a branch/worktree; the brief points at `execution-target-resolver.ts`.
- **Sources Consulted**: `src/lib/projects/resolver.ts`, `src/lib/workflow-graph/execution-target-resolver.ts`, `src/lib/workflows/conversation/manager.ts`, `src/lib/prompt/sdk-driver.ts`.
- **Findings**: `ExecutionTarget = { worktreePath; branchName; isolation: "session" | "worktree"; laneId: string | null }`. Today it is produced only from graph-workflow lanes (`createExecutionTargetResolver().resolve({execution, contextId, session})`). For a project conversation, the target is `{ worktreePath: projectPath, branchName: <repo HEAD branch>, isolation: "worktree", laneId: null }`. `ensureConversationActor` already accepts `{ executionTarget }` and binds `worktreePath = executionTarget.worktreePath ?? session.worktreePath`.
- **Implications**: Add a small **repo-root resolver** (`resolveProjectExecutionTarget(projectPath)`) that returns this shape (reading the current branch via existing git helpers). No change to `execution-target-resolver.ts`'s lane logic; this is an additive sibling. The session-less prompt entry passes it through `options.executionTarget`.

### Branch name for the main-worktree target

- **Context**: `ExecutionTarget.branchName` is non-null. We must report the repo-root's current branch for the header label and target shape.
- **Sources Consulted**: `src/lib/git/` helpers (e.g. `diff.ts` uses `git rev-parse`), `getProjectDisplayName`.
- **Findings**: A `git rev-parse --abbrev-ref HEAD` (or existing branch helper) at `projectPath` yields the current branch. The header label `main · worktree` (PLC-12) is a fixed presentational token, independent of the actual branch name; the resolver still returns the real branch for the target/diff base.
- **Implications**: Resolver reads the current branch lazily (cheap git probe). Detached-HEAD edge case: fall back to a stable label (e.g. the short SHA) so the target stays well-formed; the turn must not be blocked.

### Session-less persistence: dedicated table vs. nullable session column

- **Context**: PLC-1/2/3 require durable project conversations; PLC-43/12-preserve require session conversations untouched. The `conversations` table FK + the aggregate's session-nesting make in-place reuse risky.
- **Sources Consulted**: `state-db.ts` (DDL, `KNOWN_SCHEMA_VERSION = 0`, forward-only guard, additive-column migration), `state-aggregate.ts`, `store.ts`, `conversations-repo.ts`, the `shared-state-db-across-branches` memory.
- **Findings**: (a) Making `conversations.session_name` nullable + dropping/rewriting the composite FK is a **destructive schema migration** on a forward-only DB shared across all branches/sessions; old `main` reading new session-less rows would mis-key them in `indexConversations`. (b) The aggregate reconciles `conversations` by walking session-nested arrays; a session-less row has no host array. (c) A **dedicated `project_conversations` table** (FK to `projects(root_path)` only) sidesteps the FK, leaves the session path byte-for-byte unchanged, and is purely additive (new table via `CREATE TABLE IF NOT EXISTS` + additive columns), so old `main` simply ignores it.
- **Implications**: Build a `ProjectConversationsRepo` mirroring `ConversationsRepo` (same parsed-row cache + monotonic `cacheVersion` per PERFORMANCE.md Pattern 3) over a new `project_conversations` table, keyed `(project_path, id)`. Reuse the **shared `conversationStateSchema`** for row encode/decode (the `scope` field rides as a column). Project conversations are **not** added to `ManagerState.projects[].sessions[]`; they are read through focused accessors and a focused project-conversations active-source walk.

### Scope discriminator on the shared schemas

- **Context**: The brief mandates a `scope` discriminator (`session | project`) generalizing `ConversationState`, `ActiveConversation`, and the SSE events, deriving types via `z.infer`, making `sessionName`/`worktreePath` conditional.
- **Sources Consulted**: `conversations/schemas.ts`, `active-conversations/schemas.ts`, `sessions/schemas.ts` (embeds `conversationStateSchema`).
- **Findings**: `ConversationState` has **no** `sessionName`/`worktreePath` today (those live on the parent `SessionState`); it is scope-agnostic already. So the minimal generalization adds an explicit `scope: "session" | "project"` field (default `"session"`) to `conversationStateSchema` — existing rows/sessions decode as `scope:"session"` natively (no shim). `ActiveConversation` and the SSE events **do** carry mandatory `sessionName`/`worktreePath`; those become a discriminated union on `scope` (project variant omits `sessionName`, sets the worktree to the project main path).
- **Implications**: `conversationStateSchema` gains `scope` (backward-natural default). `SessionState.conversations` stays valid (all `scope:"session"`). `ActiveConversation` and `conversation-*` SSE event schemas become `z.discriminatedUnion("scope", …)`. Downstream consumers narrow on `scope`. No backward-compat shim needed because the default makes legacy data first-class.

### Keying & the sentinel sessionName

- **Context**: Runtime/lock/actor/persistence/transcript debounce keys are `${projectPath}::${sessionName}::${conversationId}`. The conversation machine context carries `sessionName`. `applySyncDerivedFields` → `mutateConversation(projectPath, sessionName, id, …)` and `persistConversationSnapshot(projectPath, sessionName, id, …)` both assume a session row exists.
- **Sources Consulted**: `runtime-state.ts`, `persistence.ts`, `manager.ts`, `mark-unread.ts`.
- **Findings**: The machine/manager/runtime code is sessionName-shaped but does not *semantically* require a real session — it only needs a stable string in the key triple and a working `mutateConversation`/`getConversation`/`persist`. If we route those three state-store operations to dispatch on a reserved sentinel `sessionName` (`"__project__"`), the entire machine/manager/runtime path is reused unchanged for both scopes.
- **Implications**: Introduce a module-level constant `PROJECT_CONVERSATION_SESSION_SENTINEL = "__project__"` (a value disallowed as a real session name). The session-less prompt entry constructs a synthetic `SessionState`-shaped value with `sessionName = sentinel`, `worktreePath = projectPath`. The state-store's `getConversation`/`mutateConversation`/`setConversationPendingPromptText` (and the persistence module's writes) **dispatch on the sentinel** to the `ProjectConversationsRepo` instead of the session path. Distinct PLC ids → distinct key triples → independent actors/locks → native parallelism (PLC-42).

### Active-conversations source returning PLCs

- **Context**: PLC-47 (data): the source must return PLCs across all projects with open/closed/archived visibility; PLC-46 (data): consistent shape + real-time.
- **Sources Consulted**: `active-conversations/route-handlers.ts`, `active-conversations/schemas.ts`.
- **Findings**: The handler builds `ActiveConversation[]` from session-nested conversations, filtering `archived`/`role`/status, and sets `sessionName`/`worktreePath`/`branchName` from the session. It is a sanctioned whole-state reader. For PLCs we add a parallel pass over the project-conversations repo (a focused `findAllProjectConversations()` that returns `{projectPath, conversation}` rows), mapping each to the **project variant** of `ActiveConversation` (scope `"project"`, worktree = project main path, no `sessionName`).
- **Implications**: Extend the route handler deps with a `listProjectConversations()` reader and emit project variants into the same `conversations[]` array. Visibility: include non-archived (open or closed — closed is just "no open tab", still listed); exclude archived. Keep the existing session pass intact (PLC-43/12). Performance: the project-conversations repo uses the same parsed-row cache; the extra walk is O(#PLCs) and reuses cached parses.

### Main-worktree guards (init script / dev server / pre-merge)

- **Context**: PLC-55 — no init script, no dev server, no pre-merge for project turns.
- **Sources Consulted**: `sdk-driver.ts` (turn path), session-creation/init flows, dev-server liveness modules (referenced in steering), `CC_CONTEXT` system prompt.
- **Findings**: Init script and dev-server spawning are triggered by **session-creation** and **session dev-server** flows, not by `executePromptStream`. The session-less prompt entry never invokes those flows, so init-script/dev-server are not-run **by construction**. The only positive guard needed: ensure no project-level code path offers `ensure_dev_server`/init for the main worktree, and the system-prompt orientation for a project turn should not promise a dev server. Pre-merge validation runs only on merge jobs, which PLCs never start.
- **Implications**: These are largely **negative guarantees** verified by tests (a project turn performs no init-script exec and registers no dev server) plus a project-scoped system-prompt context string that omits the dev-server promise. No new guard subsystem.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Dedicated `project_conversations` table + repo; sentinel-keyed reuse of machine/manager | New table FK'd to `projects` only; reuse shared `conversationStateSchema` with a `scope` field; state-store dispatches on sentinel sessionName to the new repo; machine/manager/runtime unchanged | Session path untouched (PLC-43/12); purely additive DDL safe on the shared forward-only DB; reuses proven row-cache + parallel-turn keying; no machine fork | One reserved sentinel string to police; two conversation read/write dispatch arms in the state store | **Chosen.** Smallest change satisfying all reqs while keeping session behavior byte-stable. |
| Nullable `session_name` + drop composite FK on existing `conversations` table | Reuse the one table; `session_name` null ⇒ project scope | Single table | Destructive migration on a shared forward-only DB; old `main` mis-keys session-less rows; aggregate session-nesting breaks; higher blast radius on session path | Rejected — violates "no backward-compat without approval" risk posture and the shared-DB landmine. |
| Separate project-conversation **entity/machine** (parallel orchestrator) | New schemas + new state machine for PLCs | Total isolation | Forks the conversation machine, transcript, manager, prompt path; contradicts "composable primitives, not feature silos"; massive duplication | Rejected by the steering Design Philosophy. |

## Design Decisions

### Decision: Generalize the shared `ConversationState` with an additive `scope` field (not a parallel entity)

- **Context**: PLC-1/43/12 — add project conversations without changing session conversations or rewriting the shared model.
- **Alternatives Considered**: (1) parallel project-conversation entity; (2) nullable session column.
- **Selected Approach**: Add `scope: z.enum(["session","project"]).default("session")` to `conversationStateSchema`. `SessionState.conversations` remains valid (all default `"session"`). The project-conversations repo persists rows with `scope:"project"`. `ActiveConversation` + SSE events become `scope`-discriminated unions.
- **Rationale**: `ConversationState` already lacks `sessionName`/`worktreePath`, so the only true generalization is the explicit `scope`. The `.default("session")` makes every already-persisted row decode natively → no backward-compat shim (honors the no-shim-without-approval rule). Reuses the entire conversation machine/transcript/manager surface (composable primitives).
- **Trade-offs**: Two storage homes for one logical type; mitigated by sharing the schema and the row-cache pattern.
- **Follow-up**: Ensure `sessions/schemas.ts` (which embeds `conversationStateSchema`) still parses without explicit `scope` on legacy rows (default covers it).

### Decision: Dedicated `project_conversations` table + `ProjectConversationsRepo`

- **Context**: FK + aggregate session-nesting block a session-less row in the existing table.
- **Selected Approach**: New `project_conversations` table keyed `(project_path, id)`, FK → `projects(root_path) ON DELETE CASCADE`, columns mirroring `conversations` (minus `session_name`, plus nothing else — `scope` is implicit/persisted). Repo mirrors `ConversationsRepo` including the parsed-row cache + monotonic `cacheVersion`.
- **Rationale**: Purely additive DDL (safe on the shared forward-only DB; old `main` ignores the table). Zero change to the session aggregate, diff/commit, or `conversations` table. PERFORMANCE.md Pattern 3 reused verbatim.
- **Trade-offs**: Some encode/decode duplication with `conversations-repo.ts`; mitigated by reusing `conversationStateSchema` + extracting the shared JSON-column codec helpers where clean.
- **Follow-up**: Project conversations are **excluded** from `ManagerState`; the active-source and accessors read the repo directly. Confirm no existing whole-state consumer needs PLCs inside `ManagerState`.

### Decision: Sentinel `sessionName` to reuse the machine/manager/runtime keyspace

- **Context**: Runtime/lock/actor/persistence keys + machine context are sessionName-shaped.
- **Selected Approach**: Reserve `PROJECT_CONVERSATION_SESSION_SENTINEL = "__project__"`. The session-less prompt entry builds a synthetic session value (`sessionName=sentinel`, `worktreePath=projectPath`, `tddEnabled` per config, empty `conversations`) and passes the repo-root `executionTarget`. The state-store conversation read/write functions (`getConversation`, `mutateConversation`, `setConversationPendingPromptText`) and the persistence module dispatch on the sentinel to the `ProjectConversationsRepo`.
- **Rationale**: Reuses 100% of the conversation machine, manager lifecycle, runtime registry, single-flight locking, transcript writing, and the actor-rebind guard. Distinct PLC ids → distinct keys → independent actors/locks → native parallel turns (PLC-42) on a shared worktree, with the rebind guard preventing in-flight corruption (R6.5).
- **Trade-offs**: A reserved string that must be rejected as a real session name (validation at session creation). One dispatch branch in three state-store functions.
- **Follow-up**: Add a guard so a real session can never be named `__project__`. Ensure `mutateConversation`'s sentinel arm bumps the project-repo `cacheVersion` and updates `lastActivityAt` without touching any session row.

### Decision: Repo-root `ExecutionTarget` resolver as an additive sibling

- **Context**: PLC-10/12/13.
- **Selected Approach**: `resolveProjectExecutionTarget(projectPath): Promise<ExecutionTarget>` returns `{ worktreePath: projectPath, branchName: <current branch | short SHA on detached>, isolation: "worktree", laneId: null }`. The session-less prompt entry passes it via `options.executionTarget`.
- **Rationale**: Reuses the existing `ExecutionTarget` contract and the actor binding seam; no change to the lane resolver. The `main · worktree` header label (PLC-12) is a presentational constant owned downstream; this spec exposes the resolved branch/worktree.
- **Trade-offs**: A cheap git probe per first-actor-bind; idempotent and only on the main path.

### Decision: Generalize SSE conversation events with a `scope` discriminator

- **Context**: PLC-46 (data) — real-time consistency via the existing event surface, distinguished by scope not a separate channel.
- **Selected Approach**: `conversation-status`/`message-appended`/`message-updated`/`conversation-created`/`conversation-renamed`/`conversation-archived`/`conversation-unread`/`ask-question`/`message-queued` event schemas become discriminated on `scope`. Session variant keeps `sessionName` (byte-compatible with today). Project variant carries `projectName` + `conversationId` and `scope:"project"` (no `sessionName`). Broadcast remains all-clients; client routing/presentation is downstream.
- **Rationale**: Keeps one event channel and one consumer contract (PLC-46 data). Session wire stays unchanged, so existing UI consumers are unaffected. Project surfaces (downstream) narrow on `scope`.
- **Trade-offs**: Event schema churn; bounded by reusing a shared `scope`-base via `z.discriminatedUnion`.

## Risks & Mitigations

- **Shared forward-only DB landmine** (memory: `shared-state-db-across-branches`) — Adding the `project_conversations` table is purely additive, so old `main` ignores it; we do **not** mutate the `conversations` table or any persisted enum used by `main`'s session path. The `scope` field on `conversationStateSchema` defaults to `"session"`, so even if a session row were ever written by this branch it remains parseable by `main`. Mitigation: no destructive migration; additive table + defaulted field only.
- **`readState()`/active-source regression** (PERFORMANCE.md Pattern 1/3/4) — The active-source adds an O(#PLCs) walk over the cached project-conversations repo; no new `readState` calls on hot paths; project-conversation single-column writes (pending prompt text, archive) use focused setters, never `mutate*`. Mitigation: reuse the parsed-row cache + monotonic version; add focused accessors/setters mirroring the session ones.
- **Sentinel collision** — A real session literally named `__project__` would corrupt dispatch. Mitigation: reject the sentinel as a session name at session creation; document the reserved value.
- **Actor-rebind during parallel turns** (R6.5) — Two turns for the *same* PLC id would share an actor; the existing rebind guard already throws for a running mismatch and per-conversation single-flight already rejects a second concurrent same-conversation turn. Mitigation: rely on existing guard + lock; cover with a test.
- **Detached HEAD on main** — `branchName` could be undefined. Mitigation: resolver falls back to short SHA; turn proceeds (PLC-45 spirit: never block).

## References

- `memory-bank/project-level-conversations/REQUIREMENTS.md` — PLC-n source of truth.
- `memory-bank/project-level-conversations/UNDERSTANDING.md` — agreed end-state.
- `PERFORMANCE.md` — Patterns 1 (focused accessors), 2 (focused setters), 3 (parsed-row cache + monotonic version), 4 (event-loop starvation).
- Auto-memory `shared-state-db-across-branches` — additive-only DDL discipline on the shared DB.
- `.kiro/steering/engineering-principles.md` — composable primitives; DI over `vi.mock`; method-syntax deps interfaces.
