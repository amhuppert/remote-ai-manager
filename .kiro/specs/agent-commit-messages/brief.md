# Brief: agent-commit-messages

## Problem

Commit messages produced through Command Center are low-value or burdensome. The standalone commit flow forces the user to hand-type a message into `CommitDialog`; the smart-merge flow auto-generates a meaningless squash message (`"Merge ${branch} into ${target}"`). Spinning up a fresh agent to write messages would have to re-infer the changes and their purpose from the diff alone. Meanwhile the implementing agent — the conversation that produced the changes — already holds exactly the context a good commit message needs, and that context is discarded today.

Both flows are also triggered from buttons outside any conversation (`SessionGitPanel` → dialogs), disconnected from where the work actually happened.

## Current State

- **Standalone commit**: `SessionGitPanel` "Commit" button → `CommitDialog` (user types message) → `POST .../commit` (`src/lib/git/route-handlers.ts` `commitSession`) → `dispatchCommitJob` (`src/lib/jobs/queue.ts`) → `commitMachine` (`src/lib/workflows/commit/machine.ts`: commit → validate → agent-fix loop). Message is 100% user input.
- **Smart merge**: `SmartMergeDialog` (autoResolve toggle) → `POST .../merge` → route handler hard-codes `mergeMessage = "Merge ${branch} into ${target}"` (`route-handlers.ts:327`) → `dispatchMergeJob` → `mergeMachine`. Intermediate commits are hard-coded (`"WIP: uncommitted changes"`, `"resolve merge conflicts"`, `"auto-fix: validation errors"`) and are squashed away — only the squash message survives on the target branch.
- **In both machines the commit/squash message is a plain input** (`CommitInput.message`, `MergeInput.message`); nothing inside the machines generates messages.
- **Slash-command interception precedent**: `/collab` is detected in `src/lib/prompt/sdk-driver.ts` (`hasCollabPrefix`, checked in `executePromptStream`) before any SDK call and dispatched to a different flow. All other slash commands pass through to the agent.
- **Structured output support exists**: conversation turns accept `outputFormat` (JSON schema), validated via the structured-output gate (`src/lib/workflows/primitives/structured-output-gate.ts`); result lands in `context.lastResult.structuredOutput`.
- **Autocomplete**: CC-native commands are an inline constant `BUILT_IN_CLAUDE_COMMANDS` in `src/features/session/prompt/PromptEditorSlashCommandPopup.tsx:26-33` (currently just `/collab`), merged with filesystem-discovered commands.

## Desired Outcome

- Typing `/commit` in a conversation commits the session worktree with an agent-written message; typing `/merge` runs the smart-merge flow with an agent-written squash message. Both leverage the conversation's existing context.
- The agent's role is strictly limited to generating the commit message. Everything else — staging, committing, validation, merge, conflict handling, publish — remains the existing deterministic machine flow, unchanged.
- The Git-panel Commit/Merge buttons, `CommitDialog`, and `SmartMergeDialog` are gone; slash commands are the only triggers.
- `/commit` and `/merge` appear in the editor's slash-command autocomplete as built-ins.

## Approach

**Generate, then dispatch** (chosen over a machine-internal "generatingMessage" state): intercept `/commit` and `/merge` in the prompt path the same way `/collab` is intercepted. Run a structured-output agent turn **in the same conversation** (so it streams to the UI like a normal reply and sees full context) whose output is the commit message; then dispatch the existing job (`dispatchCommitJob` / `dispatchMergeJob`) with that message. The commit and merge machines stay completely unchanged because the message is already a plain input to both.

Why: simplest path, zero structural changes to two battle-tested machines, natural UX (user sees the agent compose the message), and the conversation lock is held naturally during generation.

## Scope

- **In**:
  - Interception of `/commit [hint…]` and `/merge` in the prompt route/SDK-driver path.
  - A message-generation turn: narrow prompt + structured-output schema (`{ message: string }`-shaped), run in the invoking conversation; optional trailing text after `/commit` passed as a hint/steering input.
  - Dispatch wiring: generated message → `dispatchCommitJob` / `dispatchMergeJob` (merge always `autoResolve: true`).
  - Fallback: if generation fails (agent error / invalid structured output after retries), proceed with a default message (commit: generic; merge: `"Merge ${branch} into ${target}"`), log it, and surface a notice.
  - Removal of Commit/Merge buttons in `SessionGitPanel`, `CommitDialog`, `SmartMergeDialog`, and their mutations' dialog-only plumbing (routes stay; see Out).
  - `/commit` and `/merge` entries in `BUILT_IN_CLAUDE_COMMANDS`.
  - Structured logging per `.kiro/steering/logs.md` throughout the new path.
- **Out**:
  - Any change to `commitMachine` / `mergeMachine` states, actors, or guards.
  - Agent-written messages for intermediate merge commits (WIP / conflict-resolution / validation-fix) — they stay hard-coded.
  - Per-invocation merge options (`autoResolve` toggle, flags) — `/merge` is always auto-resolve.
  - Conflict-resolution UX, ready-to-land/land/discard flows (unchanged).
  - Workflow-graph-initiated merges (graph engine may still dispatch jobs with its own messages).

## Boundary Candidates

- **Command interception & parsing** (recognize `/commit`/`/merge`, extract hint) — sits beside `hasCollabPrefix` in the prompt path.
- **Message generation** (prompt construction, structured-output schema, fallback policy) — a focused module, candidate `src/lib/git/commit-message.ts` or similar domain home.
- **Dispatch glue** (generated message → existing job dispatchers) — thin; reuses `prepareDispatch` semantics untouched.
- **UI removal + autocomplete registration** — independent of the backend seam.

## Out of Boundary

- The merge machine's internals and the smart-merge prepare/publish/CAS architecture (owned by the `smart-merge` spec).
- Slash-command discovery/filtering/keyboard UX (owned by `command-autocomplete`).
- The commands service filesystem discovery (`src/lib/commands/service.ts`).
- Generic CC-native-slash-command framework — only these two commands; no premature registry abstraction beyond the existing built-ins constant.

## Upstream / Downstream

- **Upstream**: commit machine + merge machine (message as input), jobs queue (`dispatchCommitJob`/`dispatchMergeJob`, `prepareDispatch` session locking), conversation actor + structured-output gate (turn execution), `/collab` interception pattern in `sdk-driver.ts`, single-flight conversation lock.
- **Downstream**: future CC-native slash commands could follow the same interception + built-ins pattern; any later "commit message quality" iteration builds on the generation module.

## Existing Spec Touchpoints

- **Extends**: none — no existing spec is modified.
- **Adjacent**:
  - `smart-merge` — machines/jobs are consumed as-is; this spec only changes who authors `MergeInput.message` and how the job is triggered.
  - `command-autocomplete` — autocomplete UI/discovery untouched; only the `BUILT_IN_CLAUDE_COMMANDS` constant gains two entries.
  - `agent-invoked-collaboration` — `/collab` interception is the pattern template, not modified.

## Constraints

- **Machines must remain unchanged** — explicit design decision; the message stays a plain input.
- **Lock interplay**: the `/commit`/`/merge` prompt turn holds the conversation lock during generation; job dispatch (`prepareDispatch`) then acquires the session lock. The generation turn must complete (releasing the conversation flow into job dispatch) without deadlocking either; merge publish finalizes the session (marks finished, stops dev servers) — acceptable since the triggering conversation belongs to the session being merged.
- **Fallback must be non-blocking**: the deterministic flow never hard-fails because the LLM misbehaved.
- Project standards: red-green TDD, DI over `vi.mock()` for internal modules, structured logging (`createLogger`), Zod schema-first (`src/lib/<domain>/schemas.ts`), no backward-compatibility shims for the removed dialogs (direct removal, per explicit user approval).
