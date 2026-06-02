# Implementation Plan

> `_Boundary:_` names map to design components. Boundaries are chosen so this spec does **not** collide with the **project-level-conversations** foundation (conversation data model / main-worktree execution / SSE + active-conversations shape) or the **project-conversation-cockpit** (page shell / unified composer / conversation tabs / transcript host). This spec owns only: the spawn-proposal schema + validator, the inline spawn-card component, the deterministic creation wiring (`createChatSpawnService` + spawn route + committed-HEAD base), the NEW shared first-turn-dispatch primitive, and the additive `from chat` tag / PLC back-link / passive status read. It mounts its card into the cockpit's transcript mount point (a contract owned by the cockpit) and adds exactly **one** additive field to the foundation's project-conversation record through the foundation's existing write path.
>
> Red-green TDD: write the failing test first for each new behavior (per steering). Tests use DI (factory/setter/injected git/state deps), never `vi.mock` of internal modules. Agent output is `safeParse`d (untrusted); internal data is `parse`d.

## 1. Foundation: spawn-proposal schema, validator, additive persisted fields

- [ ] 1.1 Define the spawn-proposal schema and result schema
  - Add `spawnAgentSchema` (`claude | codex | dual`), `spawnModeSchema` (`fast | focus | optimistic`), `proposedSessionSchema` (name/branch/target(default `"main"`)/agent/mode + optional `initialPrompt`), `spawnProposalSchema` (1+ proposed sessions, max 20), and `spawnResultSchema` (`created[]` + `failed[]`); derive all `z.infer` types.
  - Observable completion: a conforming proposal object parses; an empty `sessions` array and an out-of-range `agent`/`mode` are rejected; `target` defaults to `"main"` and `initialPrompt` is optional (Zod v4 test green).
  - _Requirements: 1.1, 1.4, 1.5, 5.1_
  - _Boundary: spawnProposalSchema_

- [ ] 1.2 Implement the pure proposal validator
  - `extractProposal(turnOutput)` returns a candidate proposal object or `null` when the turn contains none; `validateProposal(candidate)` runs `spawnProposalSchema.safeParse` and returns `{kind:"valid",proposal} | {kind:"invalid",issues}`. No I/O, no throw, no mutation.
  - Observable completion: a valid candidate → `valid` with the parsed proposal; missing `sessions`/empty array/bad agent/bad mode → `invalid` with human-readable issues; arbitrary non-proposal input → `extractProposal` returns `null` and `validateProposal` never throws (unit tests green, no mocks).
  - _Requirements: 1.2, 1.3_
  - _Boundary: Proposal validator_
  - _Depends: 1.1_

- [ ] 1.3 (P) Add the additive `spawnedFrom` tag to the session schema
  - Add `spawnedFromSchema` (`{ source:"chat", projectName, conversationId } | null`, default `null`) to `sessionStateSchema`; surface `spawnedFrom` on `sessionListItemSchema` so the slim list/status read can show the `from chat` origin. No existing field changes.
  - Observable completion: a chat-spawned session decodes with `spawnedFrom.source === "chat"`; a legacy session row (no field) decodes with `spawnedFrom: null`; the slim list item carries `spawnedFrom` (test green; existing session schema tests unaffected).
  - _Requirements: 4.1, 4.3_
  - _Boundary: Session spawned-from tag_

- [ ] 1.4 (P) Add the additive `spawnedSessionIds` back-link field to the project-conversation record
  - Add `spawnedSessionIds: z.array(z.string()).default([])` to the foundation's project-conversation record schema (the PLC's persisted link to sessions it spawned), additive with a safe default. Add the additive DB column via the existing `ensureAdditiveColumns` mechanism.
  - Observable completion: a PLC record decodes with `spawnedSessionIds` defaulting to `[]` for legacy rows and round-trips a populated list; opening an older DB without the column still opens (additive-only; test green).
  - _Requirements: 4.2, 4.4_
  - _Boundary: PLC spawned-session back-link_
  - _Depends: 1.1_

- [ ] 1.5 (P) Add the spawn-mode sync-guard test
  - In `src/lib/chat-spawning/schemas.test.ts`, write a unit test asserting `spawnModeSchema`'s members exactly match `sessionCreationModeSchema.options` (`src/lib/sessions/schemas.ts`), so the deliberate local duplication of the session creation modes fails CI if either enum drifts (added/removed/reordered literals).
  - Observable completion: the test passes against the current `["fast","focus","optimistic"]` members and fails if `spawnModeSchema` and `sessionCreationModeSchema` diverge (test green).
  - _Requirements: 1.1_
  - _Boundary: spawnProposalSchema_
  - _Depends: 1.1_

## 2. Core: committed-HEAD base, first-turn dispatcher, state-store wiring (parallel-capable)

- [ ] 2.1 (P) Implement the committed-HEAD spawn-base resolver
  - `createSpawnBaseResolver({ getHeadRef })` whose `resolveCommittedHeadBase(projectPath)` returns the committed HEAD ref (branch name or resolved SHA) of the project's main worktree — never a working-tree/stash reference — suitable as the `baseBranch` for `git worktree add`.
  - Observable completion: `resolveCommittedHeadBase` returns the committed HEAD ref via an injected `getHeadRef`; the returned value is a commit-ish (not a working-tree ref), so a worktree created from it carries no uncommitted edits (tests green).
  - _Requirements: 3.3, 3.4_
  - _Boundary: resolveCommittedHeadBase_
  - _Depends: 1.1_

- [ ] 2.2 (P) Implement the readiness-gated first-turn dispatcher (shared primitive)
  - `createFirstTurnDispatcher(deps)` with `dispatchFirstTurn({ projectPath, projectName, session, initialPrompt, agent })`: `initialPrompt === null` → no-op `{dispatched:false}`; single agent → `executePromptStream` on the created session's `conversations[0]` under the existing conversation single-flight (exactly once), mode-independent; `agent:"dual"` → seed the collaboration race with `initialPrompt` as its brief via an injected `startDualRace`. Send only the first turn; never drive a second; on dispatch error log + resolve `{dispatched:false}` (no throw, no retry loop). Factory + DI; method-syntax deps.
  - Observable completion: `initialPrompt:null` → no turn (5.4); single agent → exactly one `executePromptStream` call across `fast`/`focus`/`optimistic` inputs (5.2, 5.6, 5.7); two concurrent `dispatchFirstTurn` for one session → a single turn (single-flight, 5.3); `agent:"dual"` → `startDualRace` invoked once with the `initialPrompt` brief (7.1, 7.2); a forced dispatch error → logged, `{dispatched:false}`, no throw, no second turn (8.3). Tests green via DI, no `vi.mock`.
  - _Requirements: 5.2, 5.3, 5.4, 5.6, 5.7, 7.1, 7.2, 8.3_
  - _Boundary: createFirstTurnDispatcher_
  - _Depends: 1.1_

- [ ] 2.3 Add the additive state-store setters and the passive status accessor
  - Add focused one-time setters `setSessionSpawnedFrom(projectPath, sessionName, spawnedFrom)` and `addPlcSpawnedSessionIds(projectPath, conversationId, sessionNames)` (batched append), both additive single-row writes (called once at creation — not a hot path). Add the focused accessor `getSpawnedSessionStatuses(projectPath, conversationId)` that intersects the PLC's `spawnedSessionIds` with the slim session list items and returns their `derivedStatus` — without `readState()`.
  - Observable completion: `setSessionSpawnedFrom` persists the tag and `addPlcSpawnedSessionIds` appends ids to the PLC; `getSpawnedSessionStatuses` returns the linked sessions' slim status, excludes a since-deleted session name, and trips no aggregate read (PERFORMANCE.md Pattern 1; tests green via DI'd state reads).
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 8.1, 8.4_
  - _Boundary: Session spawned-from tag, PLC spawned-session back-link, Spawned-session status read_
  - _Depends: 1.3, 1.4_

## 3. Integration: deterministic creation wiring and spawn route

- [ ] 3.1 Implement `createChatSpawnService` (validated proposal → creation + dispatch, best-effort)
  - `createChatSpawnService(deps)` with `createFromProposal({ projectPath, projectName, conversationId, proposal })`: `parse` the proposal (trusted boundary), resolve the committed-HEAD base once, then for **each** proposed session (sequentially, to avoid `.git/config.lock` races) map it to the matching existing `create<Mode>` with `baseBranch = committedHead` and the proposal's `name`/`branch`/`target`/`agent`/`mode`; on success write the `from chat` tag, append to the PLC `spawnedSessionIds`, and (iff `initialPrompt`) call `dispatchFirstTurn`. Wrap each session in try/catch: keep successes, record failures in `failed[]`, drop the failed session's `initialPrompt`, do not roll back the batch. Return `SpawnResult`. Deps use method syntax; reuse `createSessionService` (no fork).
  - Observable completion: a 2-session proposal where A succeeds and B's create throws → `created` has A (tagged + linked + dispatched), `failed` has B, A's prompt dispatched and B's dropped, no rollback (6.1, 6.2, 5.5); the committed-HEAD ref is passed as `baseBranch` to creation (3.1, 3.2, 3.3); `agent:"dual"` routes dual seeding through the dispatcher (7.1); creation is deterministic and never performed by the agent (1.6). Tests green via injected `createSession`/resolver/setters/dispatcher.
  - _Requirements: 1.6, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 5.5, 6.1, 6.2, 8.3_
  - _Boundary: createChatSpawnService_
  - _Depends: 1.2, 2.1, 2.2, 2.3_

- [ ] 3.2 Verify New-Session parity and validation reuse through the service
  - Through `createChatSpawnService` with an injected `createSession` that records its inputs: assert each proposed session maps to the correct existing `create<Mode>` call with the right agent/mode/branch/target/base, and that name/branch validation is delegated to the existing creation primitives (a duplicate/invalid name surfaces as that session's `failed` entry consistent with the New Session flow).
  - Observable completion: the mapped creation calls match the proposal's agent/mode/branch/target and the committed-HEAD base; an invalid/duplicate proposed name yields a `failed[]` entry with a clear error and does not abort the batch (3.1, 3.5, 9.4). Tests green.
  - _Requirements: 3.1, 3.5, 9.4_
  - _Boundary: createChatSpawnService_
  - _Depends: 3.1_

- [ ] 3.3 Add the spawn route handler and App-Router shell
  - `createSpawnRouteHandlers(deps)` exposing `POST /api/projects/[name]/conversations/[conversationId]/spawn`: `safeParse` the body against `spawnProposalSchema` (untrusted) → 400 with issues on failure; resolve the project + assert the PLC exists → 404 otherwise; delegate to `createFromProposal` and return `SpawnResult` (200) even when some sessions failed; broadcast a `spawn-result` event scoped to the project + `conversationId`. Add the thin App-Router re-export shell.
  - Observable completion: a valid body → 200 `SpawnResult`; a malformed body → 400 with issues; unknown project/PLC → 404; a partial batch returns 200 with populated `failed[]`; the `spawn-result` event is broadcast (1.6, 6.3, 9.2). Tests green via DI'd service/broadcast.
  - _Requirements: 1.6, 6.3, 9.2_
  - _Boundary: Spawn route handler_
  - _Depends: 3.1_

## 4. Integration: inline spawn-card UI (Storybook-first)

- [ ] 4.1 Build the spawn card render + Storybook story
  - Implement `SpawnCard` (`Proposed sessions · N` header) + `SpawnCardRow` (name, `branch → target`, agent badge, mode) rendering a validated `SpawnProposal`; show an Edit control and a Create / `Create N sessions` control; render a non-actionable "invalid proposal" state (no Create) when given an invalid validation result. DS tokens only (BEM CSS, fold any prototype `.pc-spawn-*` into production naming). Ship `SpawnCard.stories.tsx` covering single-row, multi-row, and invalid states.
  - Observable completion: a single-session proposal renders one row with name/`branch → target`/agent (2.1) and Edit + Create (2.2); a multi-session proposal shows `Create N sessions` (2.4); an invalid proposal renders a non-actionable state with no Create (1.3); a design-system-token compliance check passes (2.6); the Storybook story renders all states for review (tests green).
  - _Requirements: 1.3, 2.1, 2.2, 2.4, 2.6_
  - _Boundary: SpawnCard (+ row/edit/hook)_
  - _Depends: 1.1, 1.2_

- [ ] 4.2 Implement Edit mode + submit so reviewed values are what gets created
  - Add `SpawnCardEditForm` (editable name/branch/target/agent/mode/`initialPrompt` per session) and `useSpawnCard` (local edit state + submit via a React-Query mutation to the spawn route); extract the mode-router/edit helpers as pure functions for unit testing (no `vi.mock`). The submitted payload reflects the current edited values.
  - Observable completion: Edit mutates a field (including `initialPrompt`) and the submitted spawn payload reflects the edit so what the user reviews is what is created (2.3, 2.5); `Create N sessions` submits all proposed sessions in one action (2.4); the edit/mode-router helpers have direct unit tests (tests green).
  - _Requirements: 2.3, 2.4, 2.5, 5.1_
  - _Boundary: SpawnCard (+ row/edit/hook)_
  - _Depends: 4.1, 3.3_

- [ ] 4.3 Surface passive spawned-session status in the card
  - After creation, subscribe the card to the existing session-status / conversation events for the linked sessions and render each session's status from `getSpawnedSessionStatuses`; the card tracks status only and never offers controls that drive a spawned session beyond its first turn.
  - Observable completion: the card shows the linked sessions' status and updates in near-real-time off the existing SSE without manual refresh (8.1, 8.2); no UI affordance drives a spawned session beyond the auto-dispatched first turn (8.3); status is read via the focused accessor, not a whole-state read (8.4). Tests green.
  - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - _Boundary: SpawnCard (+ row/edit/hook), Spawned-session status read_
  - _Depends: 4.1, 2.3_

## 5. Validation: regression, performance, and boundary alignment

- [ ] 5.1 Session-creation and prompt-path regression stays green
  - Run the existing `sessions/service`, `sessions/route-handlers`, and `prompt` suites after the additive `spawnedFrom`/`spawnedSessionIds` schema changes and the new wiring; assert existing session creation, listing, and prompt execution are unchanged and that the spawn path reuses (does not fork) the creation/prompt/single-flight/collaboration primitives.
  - Observable completion: the pre-existing session/prompt suites pass with only additive `spawnedFrom`/`spawnedSessionIds` default expectations added; no existing creation/prompt behavior changed (suite green).
  - _Requirements: 3.2, 9.1, 9.4_
  - _Boundary: regression (sessions + prompt reuse)_
  - _Depends: 3.1, 2.2_

- [ ]* 5.2 Extend the focused-read regression and pin cold-path writes
  - Extend `createStateStore-focused-read.test.ts` so `getSpawnedSessionStatuses` (and the `spawnedFrom`-bearing slim list read) do not trip the aggregate spy where a focused accessor suffices; assert the `from chat` tag and PLC back-link are written via the focused one-time setters at creation rather than a per-keystroke `mutate*` (PERFORMANCE.md Patterns 1–2).
  - Observable completion: the focused-read regression passes with the new accessor; the tag/back-link setter assertions hold (suite green).
  - _Requirements: 8.4_
  - _Boundary: Spawned-session status read, Session spawned-from tag, PLC spawned-session back-link_
  - _Depends: 2.3, 4.3_

- [ ] 5.3 Confirm schema/dispatcher usability without the cockpit and foundation-contract alignment
  - Assert the spawn-proposal schema + validator + `createFirstTurnDispatcher` are exercised against the foundation contracts alone (no cockpit imports) so they function without the cockpit UI; confirm the card consumes only the agreed cockpit transcript mount props and that the single additive foundation field (`spawnedSessionIds`) is written through the foundation's existing project-conversation write path.
  - Observable completion: a test drives `validateProposal` → `createChatSpawnService` → `dispatchFirstTurn` end-to-end with DI and no cockpit dependency (9.1, 9.3); the card's mount props match the agreed cockpit contract (9.2); the foundation field write goes through the foundation write path (4.2). Tests green.
  - _Requirements: 9.1, 9.2, 9.3_
  - _Boundary: spawnProposalSchema, createFirstTurnDispatcher, createChatSpawnService_
  - _Depends: 2.2, 3.1, 4.2_
