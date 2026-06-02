# Brief: chat-session-spawning

> Inline session-spawning spec for the project-level conversations initiative. Requirements source of truth: `memory-bank/project-level-conversations/REQUIREMENTS.md` (PLC-29–36, plus PLC-31's spawn-base rule and PLC-34's failure rule).

## Problem

Sessions can only be created through the New Session modal. An agent in a project conversation can scope work but cannot **propose and create** the sessions to do it — optionally each seeded with a first prompt — as part of the conversation. There is also no reliable primitive to auto-send a session's first user turn the moment its agent is ready.

## Current State

- Session creation: `CreateSessionModal` → `useCreateSessionMutation` → `POST /api/projects/[name]/sessions` → `src/lib/sessions/route-handlers.ts` → `src/lib/sessions/service.ts`. Modes fast/focus/optimistic; dual Claude+Codex race exists via the collaboration/race primitive.
- `optimistic-mode` auto-executes its instructions as the first turn, but `executeOptimisticWorkflow` (`src/lib/shared/optimistic.ts`) is a **fire-and-forget one-shot** that assumes a merge follows — it is **not** a reusable "dispatch this session's first user turn once its agent is ready (after worktree setup/init/backend live), exactly once, drop on setup failure, mode-independent, dual-race-aware" primitive. That primitive does not exist yet.
- The handoff `ProjectChat.jsx` prototype renders multi-row spawn cards (`Proposed sessions · N`, Edit / Create N sessions).

## Desired Outcome

An agent turn in a project conversation can emit a **structured, validated** spawn proposal for one or more sessions, rendered as an inline card with **Edit** and **Create**. Creating spins up the sessions with **full New-Session parity**, tags them `from chat`, links them back to the spawning conversation, and — for any session carrying an optional `initialPrompt` — reliably auto-dispatches that prompt as the session's first user turn once its agent is ready. The conversation then **passively tracks** spawned-session status without driving them.

## Approach

Define a machine-validated spawn-proposal schema (1+ sessions, each with name/branch/target/agent/mode + optional `initialPrompt`); the agent emits it, Command Center validates and acts deterministically (agent-offloading — the agent does not create sessions itself). Render the inline card in the cockpit transcript. On Create, call the existing session-creation primitives; spawned branches start from the main worktree's committed HEAD (no uncommitted carryover). Build a new shared **"auto-send first user turn when ready"** primitive on `prompt/queue.ts` + single-flight locking, readiness-gated, drop-on-setup-failure, dual-race seeds both agents, best-effort batch.

## Scope

- **In**: spawn-proposal schema + validation (PLC-30); inline spawn-card UI with Edit/Create incl. multi-session batch (PLC-29); full New-Session parity reusing existing primitives (PLC-31) and the committed-HEAD spawn base; `from chat` tagging + back-links (PLC-32); optional per-session `initialPrompt` (PLC-33) and the readiness-gated auto-dispatch primitive with drop-on-failure + best-effort batch (PLC-34); dual-race seeding both agents (PLC-35); passive status tracking (PLC-36).
- **Out**: the conversation data model/execution (foundation); the cockpit/transcript host that renders the card (cockpit spec); the New Session modal itself; rail surfacing of spawned sessions (foundation/panel); autonomous driving of spawned sessions after creation.

## Boundary Candidates

- Spawn-proposal schema + validation boundary (agent output → validated data).
- Inline spawn-card UI (render + Edit + Create).
- Deterministic creation wiring to existing session primitives.
- The readiness-gated "auto-dispatch first user turn" primitive.

## Out of Boundary

- Backend execution path and project-conversation persistence (foundation).
- The transcript/pane that hosts the card (cockpit).
- Driving spawned sessions beyond their first turn.

## Upstream / Downstream

- **Upstream**: project-level-conversations (#1, the conversation that emits proposals); `src/lib/sessions/` service + route-handlers; session-lifecycle, session-branching; `src/lib/prompt/queue.ts` + single-flight; optimistic-mode (loose seed for the auto-execute shape); the collaboration/race primitive for dual.
- **Downstream**: the sessions table (rows tagged `from chat`); leaf otherwise.

## Existing Spec Touchpoints

- **Extends**: session-lifecycle / session-branching (reuse their creation + branch/worktree primitives, do not fork).
- **Adjacent**: optimistic-mode (shares the auto-execute concept; the new primitive should be reusable and could later back optimistic-mode), parallel-execution-contexts (dual-race), agent-capabilities-configuration (spawned sessions carry their own capabilities).

## Constraints

- Agent-offloading principle: validate the agent's proposal with Zod, then act deterministically; the orchestrator decides creation/retries, not the agent.
- Schema-first Zod v4; `strict`; no `any`/unchecked `as`.
- No `vi.mock()` of internal modules — DI (factory/setter) so the proposal validator, creation wiring, and the auto-dispatch primitive are unit-testable as pure functions; guard against tests that only exercise mocks.
- The auto-dispatch primitive must guarantee **exactly one** first turn (no duplicate/conflicting send) and ride the existing message-queue + single-flight rather than a parallel path.
- Red-green TDD: failing tests pinning proposal validation, committed-HEAD spawn base, drop-on-failure, dual-race seeding, and best-effort batch.
