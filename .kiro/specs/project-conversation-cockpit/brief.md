# Brief: project-conversation-cockpit

> Project-page UI spec for the project-level conversations initiative. Requirements source of truth: `memory-bank/project-level-conversations/REQUIREMENTS.md` (PLC-n IDs). Shipping direction + interaction detail: the handoff bundle under `memory-bank/project-level-conversations/project/` (Two-pane Cockpit prototype).

## Problem

The project page is a single-column sessions table with a legacy single-line command bar. There is nowhere to hold a project-level conversation, switch between several, compose prompts, or review the agent's changes to the main worktree. The command bar only filters/navigates; it can't prompt an agent.

## Current State

- `src/features/project-detail/ProjectDetailView.tsx`: header → `CommandConsole` → `SessionRows` (one column). Reusable row sub-components (`StatusPill`, `BranchChip`, `ModeDot`, `KebabMenu`, `.v3-row`) under `src/features/project-detail/components/`.
- `src/features/project-detail/components/command-suggestions.ts` already hardcodes the `/new`, `/capabilities`, `/workflow-builder` palette and computes filter suggestions; `filter-tokens.ts` owns `key:value` token parsing/state. **These are what the unified composer must reuse** (not `command-autocomplete`, which is a separate Claude-skill dropdown).
- The session `PromptComposer` (`src/features/session/prompt/PromptComposer.tsx`) already has Claude/Codex toggle, model/effort, image attach, voice.
- The diff engine `computeDiff(worktreePath)` (`src/lib/git/diff.ts`) and `DiffPanel` (`src/features/session/git/DiffPanel.tsx`) are reusable for the main worktree once a main diff endpoint exists (diff-viewer extension).

## Desired Outcome

The project page renders the **first-run** state (composer above the full-width sessions table) and animates into the **cockpit** (rail · conversation pane with tabs · sessions panel) once a project conversation is open. One **unified composer** routes plain prose → prompt the active conversation, `/` → command palette, `key:value` → sessions filter. The cockpit ships the locked layout defaults and exposes a diff/review surface for the main worktree.

## Approach

Build the cockpit shell + the first-run↔cockpit state toggle/transition (driven by the foundation's open-conversation count); conversation tabs/pane/transcript; a unified composer that reuses `command-suggestions.ts` / `filter-tokens.ts` and the session `PromptComposer` affordances, with the chat mode-chip reflecting the selected agent (`› <agent>`, cyan Claude / violet Codex); a sessions panel with dedicated text search + filter popover sharing one token state with the composer; and mount the existing `DiffPanel` against the new main-worktree diff endpoint. Prototype in Storybook with `*.stories.tsx` before wiring.

## Scope

- **In**: first-run single column (PLC-21); first-run→cockpit transition (PLC-22); three-column cockpit + locked defaults + retained `New session`/`⌘N`/breadcrumb (PLC-23/24/25); conversation tabs incl. `+ New chat`, unread dot, close + fallback (PLC-26/27/28); unified composer + three modes + agent recolor + shared filter token state (PLC-14/16/18/19/20); session search + filter chip mechanics (PLC-60); main-worktree diff/review surface mount (PLC-44 consumer); voice/image in the project composer (PLC-52); DS/keyboard/perf (PLC-56/57/58/59/61).
- **Out**: the conversation data model + execution (foundation); spawn-card schema/flow (spawning spec); the rail's internal aggregation/grouping/routing (panel spec); the main diff **endpoint** itself (diff-viewer extension).

## Boundary Candidates

- Page shell + first-run/cockpit state machine + transition.
- Unified composer (mode router + reused parsers + PromptComposer affordances).
- Conversation pane: tabs + transcript host.
- Sessions panel: search + filter popover + chip mechanics.
- Diff/review surface mount.

## Out of Boundary

- Backend execution, persistence, lifecycle data (foundation).
- Inline spawn cards and initial-prompt dispatch (spawning spec).
- Rail row data/aggregation/cross-page routing (panel spec).

## Upstream / Downstream

- **Upstream**: project-level-conversations (#1) for conversation data/SSE/lifecycle; `project-detail` parsers; session `PromptComposer`; `DiffPanel` + the diff-viewer main endpoint; the unified global rail.
- **Downstream**: chat-session-spawning renders its cards inside this conversation pane/transcript.

## Existing Spec Touchpoints

- **Extends**: dashboard-ui (the project page surface this redesigns).
- **Adjacent**: diff-viewer (consumes its new main endpoint), image-attachments and voice-transcription-integration (reused composer affordances), command-autocomplete (optional additional embed, not required), unified-conversations-panel (the rail rendered as the cockpit's left column).

## Constraints

- Must follow the design system in `.claude/skills/cc-design-system/SKILL.md` — DS tokens only, no hard-coded hex; semantic color; Anybody/Manrope/Geist-Mono type rules; spacing/radii/motion rules (8px rise + fade `.2s ease`, no spring/bounce).
- `/ui-design` rule: present design proposals before implementing; prototype components + `*.stories.tsx` in Storybook for review before approval.
- Reuse `.v3-row` + row sub-components, `.convo-sidebar`/`.cc-badge`, `.cc-primary`; fold prototype `.pc-*` classes into production naming.
- Colocation under `src/features/`; React Query for server state, Zustand+Immer for client state; performance (virtualized message lists, focused selectors) per `PERFORMANCE.md`.
- No `vi.mock()` of internal modules; red-green TDD for composer mode-routing logic (extract as a pure function).
