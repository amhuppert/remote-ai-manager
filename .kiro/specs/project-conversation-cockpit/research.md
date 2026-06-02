# Research & Design Decisions — project-conversation-cockpit

## Summary

- **Feature**: `project-conversation-cockpit`
- **Discovery Scope**: Extension (redesigns the existing project page; reuses many production components; consumes the project-level-conversations foundation's data/SSE/lifecycle contracts).
- **Key Findings**:
  1. The transcript host has a ready-made mount seam: the session conversation page already renders a **virtualized** transcript (`ConversationPanel` → `ConversationVirtuosoList`, react-virtuoso) fed `rows: ConversationRow[]` from `buildConversationRows`, with `renderMessageRow` + `renderCollabRow` callbacks. `ConversationRow` is a discriminated union (`message | collab`). Adding a `spawn-card` variant and a `renderSpawnCardRow` callback is the natural, low-risk mount contract for chat-session-spawning — no new transcript engine.
  2. The unified composer's parsers already exist and already hardcode the exact `/new`·`/capabilities`·`/workflow-builder` palette and the `key:value` token model: `command-suggestions.ts` (`computeSuggestions`) + `filter-tokens.ts` (`FilterToken`, `searchParamsToTokens`/`tokensToSearchParams`). The shared token state is the URL-backed `useSessionFilters` hook. The composer reuses these verbatim; what is genuinely new is the **mode router** (prose/`/`/`key:value`) and the **agent-recoloring mode-chip**, which the legacy `CommandConsole` lacks.
  3. The page stays live without subscribing to SSE directly: one global `NotificationListener` holds the single `/api/events` EventSource and invalidates React Query keys (`conversationKeys.active()`, `conversationKeys.messages(...)`, `conversationKeys.list(...)`) on conversation events. The foundation generalizes those events with `scope` and adds project-conversation keys; the cockpit is a declarative consumer of those keys.

## Research Log

### Transcript host & spawn-card mount contract

- **Context**: The brief requires the transcript to host chat-session-spawning's inline cards and to "define that mount contract." Need to avoid building a parallel transcript engine (steering: composable primitives, not feature silos).
- **Sources Consulted**: `src/features/session/conversation/ConversationList.tsx`, `conversation-rows.ts` (`buildConversationRows`, `ConversationRow`, `computeRowKey`), `ConversationPanelContainer.tsx`, `use-session-page-conversation.ts`, `src/components/conversation/ConversationPanel.tsx` (props), `ConversationVirtuosoList`.
- **Findings**:
  - `ConversationRow = { kind: "message"; messageIndex; msg } | { kind: "collab"; workflowId }`. `buildConversationRows` interleaves non-message rows at an anchor index. `ConversationPanel` takes `rows`, `renderMessageRow`, `renderCollabRow`, `renderTypingIndicator`, a `virtuosoRef`, and follow-bottom/range handlers.
  - The session page builds this stack from many hooks (`useSessionPageConversation`, `useConversationPanelProps`, renderers). The cockpit needs the same virtualized panel but for a **project** conversation, and a third row kind for spawn cards.
- **Implications**: Define a cockpit-local transcript host that (a) reuses `ConversationPanel`/`ConversationVirtuosoList` for virtualization, (b) extends the row union with a `spawn-card` variant carrying an opaque `proposalId`/payload owned by chat-session-spawning, and (c) exposes a `renderSpawnCardRow(row)` slot prop. This spec renders whatever node chat-session-spawning supplies; it does not parse/validate proposals. The mount contract is the documented seam in Components & Interfaces.

### Unified composer: reuse vs. new

- **Context**: PLC-14/15/16/18/19/20 require one composer with three modes, the recoloring chip, the existing palette, and session-composer affordances, sharing one filter-token state with the sessions panel.
- **Sources Consulted**: `command-suggestions.ts`, `filter-tokens.ts`, `use-session-filters.ts`, `CommandConsole.tsx`, `PromptComposer.tsx`, `use-prompt-composer-props.ts`, the prototype `UnifiedInput.jsx` (`detectMode`).
- **Findings**:
  - `computeSuggestions` already returns the `/new`·`/capabilities`·`/workflow-builder` actions plus filter suggestions; `CommandConsole` already does ↑↓/⏎ keyboard handling and chip rendering, but its primary action is filter/navigate — it cannot prompt and has no mode-chip.
  - The prototype's `detectMode(draft)` is the routing core: `/`→command, `^key\b` or `:`→filter, else chat. This is a **pure function** — ideal for red-green TDD per the brief.
  - `PromptComposer` already bundles Claude/Codex toggle, model/effort (rainbow at xhigh/max), image attach, voice, send, and backend-lock — driven by `usePromptComposerProps`. It is session-keyed (`sessionName`, session mutations).
- **Implications**: Extract `detectComposerMode` as a tested pure function. Build a `UnifiedComposer` that wraps the chat affordances (reuse `PromptComposer`'s toolbar pieces / model+effort+voice+attach components) and overlays the mode-chip + command/filter suggestion dropdown (reuse `computeSuggestions` + the `CommandConsole` suggestion-list rendering). The chat send path targets a **project** conversation (foundation route), not a session. Filter mode writes to the shared `useSessionFilters` token state; the sessions panel popover reads/writes the same state. Plain-text session search stays in the sessions panel header (separate `search` state), never the composer.

### First-run ↔ cockpit state machine

- **Context**: PLC-9/21/22/28 require deterministic switching driven by the foundation's open-count, with the locked entry animation and a return-to-first-run when the last tab closes.
- **Sources Consulted**: `ProjectDetailView.tsx` (current single-column page), prototype `Cockpit.jsx` (`isEmpty = conversations.length === 0` toggle, `pc-firstrun` vs `pc-cockpit`).
- **Findings**: The prototype keys the whole screen on `conversations.length === 0`. Production must derive "open" from the foundation's open-conversation list/count (open = has a tab; closed/archived excluded), not from a local array. The transition is a CSS entry animation (`.2s ease`, 8px rise + fade) already idiomatic in the DS (`stagger-in`).
- **Implications**: A small client view-state (which PLCs have open tabs, active tab id) layered over the foundation's server truth. The server is authoritative for which conversations are open; the client tracks tab order + active selection + transient transitions. Use Zustand+Immer for the cockpit's tab/active/rail-collapsed view-state; React Query for the server lists (open PLCs, messages, sessions, active-conversations, main diff). Respect `prefers-reduced-motion`.

### Diff/review surface mount

- **Context**: PLC-44 consumer — mount a read-only main-worktree diff comparable to the per-session diff, against an endpoint produced as a direct item outside this spec.
- **Sources Consulted**: `DiffPanel.tsx` (props: `diff: SessionDiff`, `commits?`, `targetBranch`, `hotkeysEnabled`), `src/lib/git/diff.ts` (`computeDiff(worktreePath)`), `git/queries.ts`, `git/query-keys.ts`.
- **Findings**: `DiffPanel` is already a self-contained read-only renderer (uncommitted + commits tabs). It is keyed on a `SessionDiff` shape and a `targetBranch` label, plus optional `projectName`/`sessionName` used only for commit-history links. No git-mutation controls live inside `DiffPanel` itself (commit/merge live in `SessionGitPanel`/dialogs, which this spec does not mount).
- **Implications**: The cockpit consumes the **main-worktree diff endpoint** (upstream direct item) via a small React Query hook keyed by project, then mounts `DiffPanel` with the returned `SessionDiff`, a `main` label, and `hotkeysEnabled` scoped to when the surface is focused. No commit/merge affordances. The endpoint contract is treated as upstream; if it deviates from `SessionDiff`, that is a revalidation trigger.

### Global rail mount

- **Context**: PLC-23/37 — the cockpit's left column is the existing global rail; its grouping/routing/Needs-you is owned by the unified-conversations-panel extension.
- **Sources Consulted**: `ConversationSidebar.tsx` (mounts `useActiveConversationsQuery`, owns its own collapse, filters, sections, context menu, peek), `NotificationListener.tsx` (global SSE invalidation of `conversationKeys.active()`).
- **Findings**: `ConversationSidebar` is already a self-contained global rail fed by `/api/conversations/active`. It currently takes `projectName`/`sessionName`/`activeConversationId` for its session-page context. The foundation makes the active source return PLCs; the extension adds `<project> / main` grouping and PLC click-routing.
- **Implications**: The cockpit mounts `ConversationSidebar` as the left column and supplies the project context. It does **not** modify the rail's internals. The one consumer-side behavior the cockpit owns (PLC-50 consumer): when the rail asks to focus a PLC in the current project, the cockpit reopens/activates that tab. The mechanism (a callback/route param the extension exposes) is an integration seam to confirm with the panel extension; default: the cockpit reads the focus intent from the route/query and reconciles its tab state.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Compose existing primitives (chosen) | Reuse `ConversationPanel` (virtualized transcript), `computeSuggestions`/`filter-tokens`/`useSessionFilters` (composer parsing + shared token state), `PromptComposer` affordances, `DiffPanel`, `ConversationSidebar`; add only the cockpit shell, mode router, mode-chip, tabs, and the spawn-card row variant. | Minimal new surface; honors "composable primitives, not feature silos"; inherits virtualization, keyboard, DS. | Must respect existing component contracts; some props are session-shaped and need project-conversation analogues. | Aligns with steering + brief. |
| Fork a project-specific transcript/composer | Build parallel project transcript + project composer from scratch. | Full control of project semantics. | Duplicates virtualization, keyboard, DS, image/voice; high regression surface; violates YAGNI + anti-duplication. | Rejected. |
| Mega-component cockpit | One `ProjectCockpit` component holding all logic. | Fewer files. | Unreviewable; violates ~600-line module rule; no parallel-safe boundaries. | Rejected in favor of bounded sub-features. |

## Design Decisions

### Decision: Cockpit owns project-conversation client query layer; foundation owns the data/route/SSE

- **Context**: The page must render and live-update project-conversation lists, messages, the open-count, and per-turn status, but must not redefine the foundation's data/SSE/lifecycle contracts.
- **Alternatives Considered**:
  1. Cockpit reaches into foundation internals / re-derives open-count locally.
  2. Cockpit defines thin React Query hooks + query keys against the foundation's documented routes and consumes the foundation's `scope`-discriminated active-conversation shape.
- **Selected Approach**: (2). The cockpit adds `projectConversationKeys` + query/mutation hooks (list open PLCs, messages for a PLC, create/close/reopen/rename, send project prompt) that call the foundation's routes (`/api/projects/[name]/conversations*`, `/api/projects/[name]/prompt`). Open-count is derived from the foundation's list/count, never invented. Live updates ride the existing global SSE→invalidation path; the cockpit registers the project-conversation message/list keys so the global listener's `scope: project` invalidations reach them (integration seam with the foundation/notifications wiring).
- **Rationale**: Keeps the data contract single-owned (foundation), the UI a pure consumer; matches the existing `conversations`/`active-conversations` query-layer pattern.
- **Trade-offs**: The cockpit depends on the foundation's route/event shape; changes there are revalidation triggers. Acceptable and explicit.
- **Follow-up**: Confirm the global `NotificationListener` invalidates the cockpit's project-conversation message/list keys for `scope: project` events (or that the cockpit subscribes via the same mechanism). If the listener belongs to the notifications extension, coordinate the key registration there.

### Decision: `detectComposerMode` is a pure, unit-tested function; the composer is presentational over it

- **Context**: The brief mandates red-green TDD for composer mode-routing extracted as a pure function; no `vi.mock` of internal modules.
- **Selected Approach**: `detectComposerMode(draft): "chat" | "command" | "filter"` (and a companion that yields the active suggestion set by delegating to `computeSuggestions`) live as pure functions with colocated tests. `UnifiedComposer` calls them and renders; send/command/filter side-effects are injected callbacks (`onSendPrompt`, `onRunCommand`, `onAddToken`).
- **Rationale**: Pure core is trivially testable without mocks; matches engineering-principles DI guidance.
- **Trade-offs**: Slight indirection. Worth it.
- **Follow-up**: Mirror the prototype's `detectMode` semantics exactly (`/`→command; leading filter key or trailing `:` → filter; else chat), then refine to the production filter keys (`is`/`status` alias, `target`, `branch`, `archived:true`).

### Decision: Cockpit view-state in Zustand+Immer; server lists in React Query

- **Context**: Tabs (order, active id), rail-collapsed, and the diff-surface visibility are client view-state; the set of open PLCs and their content are server truth.
- **Selected Approach**: A `projectCockpit` Zustand+Immer store holds `openTabIds` (ordering/active selection layered on server "open" truth), `activeTabId`, `railCollapsed`, and transient transition flags. React Query owns open-PLC list, messages, sessions, active-conversations, and main diff. The store reconciles with server truth (a PLC closed server-side drops from tabs; a focus intent reopens).
- **Rationale**: Matches the repo's split (`src/stores/*` for client, per-domain queries for server) and PERFORMANCE.md focused-selector guidance.
- **Trade-offs**: Reconciliation logic between store and server; kept small and pure where possible.

## Risks & Mitigations

- **Foundation not yet implemented** — This spec consumes routes/shapes the foundation defines. *Mitigation*: program against the foundation's design.md contracts (project prompt/lifecycle routes, `scope`-discriminated `ActiveConversation`/events, open-count); treat any deviation as a revalidation trigger; Storybook-prototype against mock data so UI work proceeds in parallel.
- **Spawn-card mount coupling** — The transcript row variant must be stable for chat-session-spawning. *Mitigation*: define the `spawn-card` row contract (opaque payload + `renderSpawnCardRow` slot) early and keep it agnostic of proposal internals.
- **Rail double-ownership** — The cockpit must not fork rail behavior. *Mitigation*: mount the existing `ConversationSidebar`; restrict cockpit ownership to the PLC-focus-intent reconciliation (PLC-50 consumer).
- **Performance regression with two live surfaces (rail global + sessions + transcript)** — *Mitigation*: virtualized transcript (reuse), focused Zustand selectors, memoized derived lists, and no new whole-state reads; verify per PLC-61 against current pages.
- **Diff endpoint shape drift** — *Mitigation*: consume via a typed hook validating the `SessionDiff` schema; deviation is a revalidation trigger.

## References

- `memory-bank/project-level-conversations/REQUIREMENTS.md` — PLC-n source of truth.
- `memory-bank/project-level-conversations/project/Two-pane Cockpit.html` + `components/` (`Cockpit.jsx`, `UnifiedInput.jsx`, `ProjectChat.jsx`, `Cockpit.jsx`'s `GlobalConvSidebar` usage) — interaction source of truth.
- `.kiro/specs/project-level-conversations/design.md` + `requirements.md` — upstream foundation contracts.
- `.claude/skills/cc-design-system/SKILL.md` (+ `references/`) — DS tokens, components, motion.
- Existing code: `ConversationPanel`/`ConversationVirtuosoList`, `conversation-rows.ts`, `command-suggestions.ts`, `filter-tokens.ts`, `use-session-filters.ts`, `PromptComposer.tsx`, `DiffPanel.tsx`, `ConversationSidebar.tsx`, `NotificationListener.tsx`.
