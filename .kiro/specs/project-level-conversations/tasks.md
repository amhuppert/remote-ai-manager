# Implementation Plan

> `_Boundary:_` names map to design components. Boundaries are chosen so this foundation spec does not collide with **project-conversation-cockpit** (page UI/composer/tabs) or **chat-session-spawning** (spawn-proposal schema/auto-dispatch). This spec touches only: the `scope` discriminator on shared schemas, the `project_conversations` table/repo + state-store dispatch, the `project-conversations/` service+entry+resolver+guards, and the active-conversations data source. It does **not** create any React UI, the spawn-proposal schema, or the rail presentation.
>
> Red-green TDD: write the failing test first for each new behavior (per steering). Tests use DI (factory/setter/injected `Db`), never `vi.mock` of internal modules.

## 1. Foundation: shared scope discriminator and sentinel

- [ ] 1.1 Add the conversation `scope` discriminator and the project sentinel to the shared schema
  - Add `conversationScopeSchema` (`"session" | "project"`, default `"session"`) and a `scope` field on `conversationStateSchema`; derive `ConversationScope` via `z.infer`.
  - Add `PROJECT_CONVERSATION_SESSION_SENTINEL = "__project__"` and an `isProjectSentinel(sessionName)` helper in a client-safe module with no heavy deps.
  - Observable completion: a legacy conversation row/object with no `scope` parses as `scope:"session"`; a project record parses as `scope:"project"`; existing `sessionStateSchema` (which embeds `conversationStateSchema`) still parses legacy sessions unchanged (test green).
  - _Requirements: 1.7, 12.1, 12.3_
  - _Boundary: Conversation scope schema_

- [ ] 1.2 Scope-discriminate the conversation SSE event schemas
  - Convert `conversation-status`, `message-appended`, `message-updated`, `conversation-created`, `conversation-renamed`, `conversation-archived`, `conversation-unread`, `ask-question`, `message-queued` into `scope`-discriminated unions: a session variant (additive `scope:"session"`, retaining `sessionName`, wire-compatible with today) and a project variant (`scope:"project"`, `projectName` + `conversationId`, no `sessionName`). Add a project-only `conversation-open` event (`projectName`, `conversationId`, `open`).
  - Observable completion: today's session-event payloads (with `scope:"session"` stamped) still `parse`; a project-variant event without `sessionName` parses; a project-variant event that carries `sessionName` is rejected (test green).
  - _Requirements: 9.1, 9.2_
  - _Boundary: Conversation scope schema_
  - _Depends: 1.1_

## 2. Foundation: session-less persistence

- [ ] 2.1 Add the `project_conversations` table DDL (additive)
  - Add `CREATE TABLE IF NOT EXISTS project_conversations (...)` to `SCHEMA_DDL` mirroring the `conversations` columns minus `session_name`, plus `open INTEGER NOT NULL DEFAULT 1`, FK → `projects(root_path) ON DELETE CASCADE`; add the `project` and `last_activity` indexes; register any later-added column (e.g. `open`) in the additive-columns mechanism.
  - Observable completion: opening a fresh test DB creates `project_conversations` with the documented columns/indexes; opening an already-migrated DB is a no-op; an older build that lacks this DDL still opens the shared DB without error (additive-only; test green).
  - _Requirements: 1.3_
  - _Boundary: state-db DDL_

- [ ] 2.2 Implement `ProjectConversationsRepo` with the parsed-row cache
  - CRUD keyed `(project_path, id)` encoding/decoding via the shared `conversationStateSchema` (rows carry `scope:"project"`); reuse the JSON-column codec/validation approach from `conversations-repo`. Implement `findById/findByKey/findByProject/findAll/upsert/delete/setPendingPromptText/setArchived/setOpen`.
  - Maintain a `Map<id,{rawRow,parsed}>` + monotonic `cacheVersion`; every mutator bumps it; `findAll`/`findByProject` short-circuit when unchanged and return the cached array by reference (PERFORMANCE.md Pattern 3).
  - Observable completion: `findAll()` returns the same array reference across two calls with no intervening write, a new reference after `upsert`/`setOpen`/`setArchived`; per-project isolation holds; a corrupt row trips a `PersistenceError` at the boundary (tests green, via injected test `Db`).
  - _Requirements: 1.3, 1.6, 3.1, 8.1_
  - _Boundary: ProjectConversationsRepo_
  - _Depends: 1.1, 2.1_

- [ ] 2.3 Make the state-store conversation read/write scope-aware and add focused project accessors/setters
  - Wire the project repo into the store. Dispatch `getConversation`/`mutateConversation`/`setConversationPendingPromptText` on the sentinel `sessionName` to the project repo; add `mutateProjectConversation` (loads the project record, runs the mutator, stamps `lastActivityAt`, upserts inside the write queue — never via `mutateSession`).
  - Add focused accessors `getProjectConversation`, `getProjectConversations`, `listAllProjectConversations`, and focused setters `setProjectConversationArchived`, `setProjectConversationOpen`, `setProjectConversationPendingPromptText`; export from the state-store facade.
  - Observable completion: a sentinel-addressed `getConversation`/`mutateConversation`/`setConversationPendingPromptText` reads/writes the project repo and touches **no** session row; a non-sentinel call keeps the existing session path; single-column project writes run a narrow `UPDATE` (PERFORMANCE.md Pattern 2). Tests green via DI'd repos.
  - _Requirements: 1.1, 1.2, 3.2, 3.5, 6.4_
  - _Boundary: State-store scope dispatch_
  - _Depends: 2.2_

## 3. Core: service, lifecycle, execution target, guards (parallel-capable)

- [ ] 3.1 (P) Implement pure lifecycle helpers
  - `deriveLifecycle({open,archived})` → `open|closed|archived`; `isListedInActiveSource({archived})` → `!archived`; `countOpen(convs)` counts `open && !archived`.
  - Observable completion: unit tests cover every flag combination — open, closed (`!open && !archived`), archived (`archived`), and the open-count for mixed sets (no I/O, no mocks; test green).
  - _Requirements: 3.1, 3.3, 3.6, 3.7_
  - _Boundary: Lifecycle helpers_
  - _Depends: 1.1_

- [ ] 3.2 (P) Implement the repo-root `ExecutionTarget` resolver
  - `createProjectExecutionTargetResolver({ getCurrentBranch })` whose `resolve(projectPath)` returns `{ worktreePath: projectPath, branchName: branch ?? "detached@<shortSha>", isolation:"worktree", laneId:null }`, reusing the existing `ExecutionTarget` type; do not modify the lane resolver.
  - Observable completion: `resolve` returns the repo-root worktree + current branch; on detached HEAD it returns a `detached@<shortSha>` label and still yields a well-formed target (tests green via injected `getCurrentBranch`).
  - _Requirements: 4.1, 4.3, 4.5_
  - _Boundary: resolveProjectExecutionTarget_
  - _Depends: 1.1_

- [ ] 3.3 (P) Add the project-scoped system-prompt context (init/dev-server guard, prompt side)
  - Add `PROJECT_CC_CONTEXT` — a CC orientation string that omits the dev-server promise present in `CC_CONTEXT`.
  - Observable completion: the constant exists and contains no `ensure_dev_server`/dev-server language; a snapshot/string test pins that it does not promise a dev server (11.2).
  - _Requirements: 11.2_
  - _Boundary: Main-worktree guards_
  - _Depends: 1.1_

- [ ] 3.4 (P) Reject the project sentinel as a real session name
  - In session creation, reject `sessionName === PROJECT_CONVERSATION_SESSION_SENTINEL` with a clear validation error.
  - Observable completion: attempting to create a session literally named `__project__` is rejected; all other names are unaffected (test green).
  - _Requirements: 11.4_
  - _Boundary: Sentinel guard (sessions creation)_
  - _Depends: 1.1_

- [ ] 3.5 Implement the `ProjectConversationService`
  - `createProjectConversation` builds a `ConversationState` (`scope:"project"`, `open:true`, deterministic human-readable default title, chosen/config backend) and persists via the project repo; implement `get/list/rename/setArchived/setOpen` and `getOpenProjectConversationCount` over the focused accessors/setters + `mutateProjectConversation`.
  - Observable completion: `createProjectConversation` returns a persisted record with a unique stable id, `scope:"project"`, `open:true`, and a non-empty human-readable title usable on a tab/rail row; closing sets `open:false` without archiving; archiving sets `archived:true`; `getOpenProjectConversationCount` returns the count of `open && !archived` (tests green via DI'd state-store deps).
  - _Requirements: 1.1, 1.4, 1.5, 2.2, 2.3, 3.2, 3.4, 3.6, 3.7_
  - _Boundary: ProjectConversationService_
  - _Depends: 2.3, 3.1_

## 4. Core: scope-discriminate `activeConversationSchema`

- [ ] 4. Convert `activeConversationSchema` to a `scope`-discriminated union
  - Session variant unchanged (retains `sessionName`/`branchName`/`worktreePath`); project variant `scope:"project"` with `worktreePath` = project main path and **no** `sessionName`/`branchName`.
  - Observable completion: today's session active-conversation objects still parse (session variant); a project-variant object without `sessionName` parses; `activeConversationsResponseSchema` accepts a mixed `conversations[]` array (tests green).
  - _Requirements: 8.4, 9.2_
  - _Boundary: ActiveConversation schema_
  - _Depends: 1.1_

## 5. Integration: session-less execution path

- [ ] 5.1 Implement `executeProjectPromptStream` (session-less prompt entry)
  - `createProjectPromptExecutor({ resolveExecutionTarget, executePromptStream, readConfig })` resolves the repo-root target, synthesizes a sentinel `SessionState`-shaped value (`sessionName` = sentinel, `worktreePath` = `projectPath`, `tddEnabled`/default-backend from config, empty `conversations`, `branchName` from the target), supplies the actor input explicitly to the manager via the existing `actorInput` escape hatch, and delegates to `executePromptStream(..., { executionTarget, backend, effort })`. Use `PROJECT_CC_CONTEXT`. Perform no worktree creation, no clean check, no init-script/dev-server call.
  - Observable completion: a call with no `conversationId` creates the first PLC and submits its first turn (2.1); the turn binds the agent cwd to `projectPath` (4.1, 4.6); the entry never invokes a worktree-create, init-script, dev-server, or pre-merge/merge-job flow (11.1, 11.2, 11.3); a dirty main worktree does not block the turn (7.1, 7.2). Tests green via injected `executePromptStream` + resolver.
  - _Requirements: 2.1, 4.2, 4.4, 4.6, 7.1, 7.2, 11.1, 11.2, 11.3_
  - _Boundary: executeProjectPromptStream_
  - _Depends: 2.3, 3.2, 3.3_

- [ ] 5.2 Verify backend lock + per-turn model/effort and parallel/rebind behavior through the entry
  - Through `executeProjectPromptStream` (reusing `executePromptStream`'s get-or-create, `BackendMismatchError`, and backend-factory model/effort validation): assert the backend is selectable before the first turn and fixed after; model/effort change between turns; distinct conversation ids run in parallel; a second concurrent turn for the same id is rejected by single-flight; a running-actor worktree mismatch throws via the rebind guard.
  - Observable completion: a second turn requesting a different backend on an initialized PLC raises `BackendMismatchError` (5.2, 5.3); an invalid model/effort raises the validation error before execution (5.5); during a running turn the reused machine emits scope=project status events (running/awaiting/waiting-for-input) (9.3); two distinct-id turns proceed concurrently (6.1–6.3); same-id concurrent turn is rejected (6.4); a forced running-actor worktree mismatch throws (6.5). Tests green.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 9.3_
  - _Boundary: executeProjectPromptStream_
  - _Depends: 5.1_

- [ ] 5.3 Add the project-conversation route handlers (prompt + lifecycle) with scope=project broadcasts
  - Implement: project create (POST), project prompt by id (POST, SSE) and project first-prompt (POST, SSE) wrapping `executeProjectPromptStream` and mapping `BackendMismatchError`/`ModelEffortValidationError` to typed SSE error frames; lifecycle PATCH rename/archive/open via the service. After each successful lifecycle mutation, broadcast the matching scope=project event (`conversation-created`/`-renamed`/`-archived`/`-open`). Add the thin App-Router re-export shells.
  - Observable completion: `POST .../prompt` streams `text/event-stream` and emits scope=project status/message events during a turn; a backend mismatch returns the SSE `BACKEND_MISMATCH` frame; create returns 201 with the record; rename/archive/open return `{ok:true}` and broadcast the corresponding scope=project event; unknown project/conversation → 404 (tests green via DI'd service/entry/broadcast).
  - _Requirements: 2.1, 3.2, 3.5, 5.3, 9.1, 10.2_
  - _Boundary: Project conversation routes_
  - _Depends: 3.5, 5.1, 1.2_

## 6. Integration: active-conversations source returns PLCs

- [ ] 6.1 Add the project-conversation pass to the active-conversations source
  - Add a `listProjectConversations()` dep (backed by `listAllProjectConversations()`); add a second pass mapping each non-archived, active-status project conversation to a **project-variant** `ActiveConversation` (`scope:"project"`, `projectName`, `worktreePath` = projectPath, no `sessionName`/`branchName`, best-effort `lastActivitySummary`). Preserve the existing session pass and the merged `lastActivityAt` sort.
  - Observable completion: the response includes both session and project conversations; an archived PLC is excluded; a closed (non-archived) PLC is included; the project variant carries the project main worktree and no `sessionName`; existing session entries are unchanged (tests green via DI'd `readState` + `listProjectConversations`).
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 3.3, 3.5_
  - _Boundary: Active-conversations source extension_
  - _Depends: 2.3, 4_

## 7. Integration: snapshot rehydration parity

- [ ] 7.1 Rehydrate project-conversation actors on startup (permission-answer parity)
  - Add a parallel rehydration pass over `listAllProjectConversations()` reusing `shouldRehydrateSnapshot` + the existing actor-creation block, supplying `actorInput` from the project record + repo-root worktree (sentinel `sessionName`). Snapshot persistence/restore already route through the scope-aware state store (no persistence-module change).
  - Observable completion: a project conversation persisted mid-"waiting for a permission answer" is rehydrated into a live actor on startup; non-resumable project snapshots are skipped, mirroring session behavior (tests green via DI'd state reads).
  - _Requirements: 10.1, 10.3_
  - _Boundary: executeProjectPromptStream, ProjectConversationsRepo_
  - _Depends: 2.3, 5.1_

## 8. Validation: regression and performance guards

- [ ] 8.1 Session-conversation regression suite stays green
  - Run the existing `conversations`, `active-conversations`, and prompt-path tests after the schema/dispatch/source generalizations; assert session-conversation creation, execution, persistence, status, archiving, and listing are unchanged, and that the session prompt path is untouched.
  - Observable completion: the pre-existing session-scoped test suites pass unmodified except for additive `scope:"session"` expectations; no session behavior changed (suite green).
  - _Requirements: 12.1, 12.2_
  - _Boundary: regression (session conversations)_
  - _Depends: 2.3, 4, 6.1_

- [ ]* 8.2 Extend the focused-read regression and pin the repo cache
  - Extend `createStateStore-focused-read.test.ts` so the project accessors (`getProjectConversation`, `listAllProjectConversations`) and the active-source project pass do not trip the aggregate spy where a focused accessor suffices; keep the `ProjectConversationsRepo` reference-equality assertion (Pattern 3) and the focused-setter assertions (Pattern 2).
  - Observable completion: the focused-read regression test passes with the new project accessors; the repo cache reference-equality and focused-setter assertions hold (suite green).
  - _Requirements: 1.6, 8.1_
  - _Boundary: ProjectConversationsRepo, State-store scope dispatch_
  - _Depends: 2.2, 2.3, 6.1_
