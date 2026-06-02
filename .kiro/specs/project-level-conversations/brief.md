# Brief: project-level-conversations

> Foundation spec for the project-level conversations initiative. Requirements source of truth: `memory-bank/project-level-conversations/REQUIREMENTS.md` (PLC-n IDs referenced below). End-state context: `memory-bank/project-level-conversations/UNDERSTANDING.md`.

## Problem

Conversations in CC are strictly nested under sessions, so there is no way to converse with an agent at the **project** level. To ask the repo a quick question or to plan/scope session work, a user must create a throwaway session and worktree. There is no concept of a durable conversation that runs an agent turn directly in the project's main (repo-root) worktree.

## Current State

- Conversations live only as `session.conversations[]`. `ConversationState` (`src/lib/conversations/schemas.ts`) has no scope/`sessionName`/worktree field; `ConversationListItem` and `ActiveConversation` (`src/lib/active-conversations/schemas.ts`) make `sessionName` and `worktreePath` **mandatory**, and every conversation SSE event carries a required `sessionName`. Keyed `(projectPath, sessionName)` + `id` in `src/lib/state-store/conversations-repo.ts` / `sessions-repo.ts`.
- Prompt execution always resolves a session (`src/lib/prompt/route-handlers.ts`) and runs in `session.worktreePath`. However, a generalized seam already exists: `executePromptStream` accepts `options.executionTarget` and the conversation manager binds the agent cwd to `requestedWorktreePath ?? sessionWorktreePath` (`src/lib/workflows/conversation/manager.ts`); `ExecutionTarget` (`src/lib/workflow-graph/execution-target-resolver.ts`) is today produced only from graph-workflow lanes. Nothing resolves the repo root or calls the path without a session. The actor-rebind guard (`manager.ts`) throws if an existing actor has a different worktree — relevant to parallel-on-main.

## Desired Outcome

A project can own zero or more **durable, session-less conversations** that run agent turns in the **repo-root (main) worktree**, with an open/closed/archived lifecycle, Claude/Codex backend parity (backend fixed after the first turn; model/effort mutable per turn), persistence across reloads/restarts, real-time surfacing through the existing global active-conversations source + SSE, and fully-parallel turns with no concurrency guardrails (the user owns the risk).

## Approach

Generalize the shared conversation schemas with a `scope` discriminator (`session` | `project`) that makes `sessionName`/`worktreePath` conditional, derive types via `z.infer`, and add a session-less persistence/keying path. Add a repo-root `ExecutionTarget` resolver and a session-less prompt entry point that reuses `executePromptStream` and the conversation machine. Make the active-conversations **source** able to return project conversations (data only — presentation/grouping is the panel spec). Adopt the no-guardrail parallel posture (PLC-42) while respecting the actor-rebind guard, and guard the main worktree against init-script/dev-server/pre-merge behaviors (PLC-55).

## Scope

- **In**: session-less conversation data model (schema generalization + SSE event generalization); persistence and keying for project conversations; open/closed/archived lifecycle and the open-count that drives first-run vs cockpit (PLC-7/8/9, data side); Claude/Codex backend parity and per-turn model/effort (PLC-17); main (repo-root) worktree execution path + repo-root `ExecutionTarget` resolver + session-less prompt entry (PLC-10/11/12/13); fully-parallel no-guardrail posture (PLC-42); making the active-conversations source return project conversations (PLC-47, data); main-worktree guards (PLC-55).
- **Out**: the cockpit page UI and composer; spawn cards; the rail's visual grouping/labeling/click-routing; the diff/review UI; per-conversation capability UI and notification parity (handled as direct items reusing existing primitives).

## Boundary Candidates

- Conversation schema + SSE event generalization (the `scope` discriminator).
- Session-less persistence + keying in the state store.
- Main-worktree execution path: repo-root resolver + session-less prompt entry + conversation-machine binding.
- Lifecycle state (open / closed / archived) and the open-set that the page toggle reads.

## Out of Boundary

- Page shell, tabs, unified composer (→ project-conversation-cockpit).
- Spawn-proposal schema and the auto-dispatch primitive (→ chat-session-spawning).
- Rail presentation/grouping/routing (→ unified-conversations-panel extension).
- Main-worktree diff surface (→ diff-viewer extension + cockpit mount).

## Upstream / Downstream

- **Upstream**: `src/lib/conversations/`, `src/lib/active-conversations/`, `src/lib/state-store/` repos, `src/lib/prompt/` (route-handlers, sdk-driver), `src/lib/workflows/conversation/manager.ts`, `src/lib/workflow-graph/execution-target-resolver.ts`.
- **Downstream**: project-conversation-cockpit, chat-session-spawning, the unified-conversations-panel and diff-viewer extensions, and the capabilities/notifications direct items.

## Existing Spec Touchpoints

- **Extends**: none structurally — it *generalizes* shared schemas that existing session conversations also use, so changes must not break session conversations (and any compatibility shim needs Alex's explicit approval).
- **Adjacent**: prompt-execution (implementation-complete), conversation-forking, unified-conversations-panel (consumes the generalized `ActiveConversation`), agent-capabilities-configuration, optimistic-mode, session-lifecycle.

## Constraints

- Schema-first Zod v4 with `z.infer`; `strict` / `noUncheckedIndexedAccess`; no `any`/unchecked `as`.
- No `vi.mock()` of internal modules — use DI; extract pure functions for the schema/keying/resolver logic so they're unit-testable without mocks.
- Follow `PERFORMANCE.md`: focused accessors/setters, parsed-row caches with monotonic invalidation; no regression to state-store latency or SSE broadcast cost when the source now also walks project conversations.
- Generalizing shared schemas risks touching existing session conversations — preserve their behavior; **no backward-compatibility layer without explicit approval**.
- Red-green TDD: failing test pinning each new behavior first.
