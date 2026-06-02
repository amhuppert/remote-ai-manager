# Implementation Plan

> Boundary note (applies to every task): this spec owns the project-page UI under `src/features/project-detail/` (the `cockpit/` and `composer/` subtrees) plus the consumer query layer at `src/lib/project-conversations-client/` and a thin main-diff consumer hook. It does NOT modify the project-level-conversations foundation (data model, persistence, lifecycle/open-count derivation, main-worktree execution, `scope`-discriminated `ActiveConversation`/SSE schemas, project routes), chat-session-spawning (spawn-proposal schema/validator, multi-session card body, auto-dispatch), the unified-conversations-panel rail internals, or the main-worktree diff endpoint. Those are consumed as upstream contracts. Per the `/ui-design` rule, each new component ships a `*.stories.tsx` for review before it is wired into the live page.

- [ ] 1. Foundation: client query layer and shared parsers

- [ ] 1.1 Build the project-conversation client query layer (keys + read queries)
  - Add `projectConversationKeys` (list, openCount, messages) and React Query hooks `useProjectConversationsQuery`, `useProjectOpenCountQuery`, `useProjectConversationMessagesQuery` that call the foundation's project routes and `safeParse` responses against the foundation schemas
  - Derive open-count from the open-PLC list; never invent lifecycle state
  - Observable: hooks return typed data validated against foundation schemas; a unit test with injected fetch shows each hook hits the documented route and rejects malformed payloads
  - _Requirements: 1.5, 12.3, 12.4_
  - _Boundary: project-conversations-client_

- [ ] 1.2 Build the project-conversation client mutations (lifecycle + send)
  - Add `useCreateProjectConversation`, `useCloseProjectConversation`, `useReopenProjectConversation`, `useRenameProjectConversation`, and `useSendProjectPrompt` (with `conversationId: null` => create-and-send) that call the foundation routes and invalidate the relevant `projectConversationKeys`
  - Surface prompt errors (busy / backend-mismatch / model-effort validation) through the send envelope without redefining them
  - Observable: a unit test with injected fetch shows create/close/reopen/rename invalidate the right keys and `useSendProjectPrompt` posts to the project prompt route with and without a conversation id
  - _Requirements: 4.4, 4.6, 5.7, 7.3, 7.4, 7.5_
  - _Boundary: project-conversations-client_
  - _Depends: 1.1_

- [ ] 1.3 (P) Add the main-worktree diff consumer hook
  - Add (or consume, if the direct item already ships one) `useMainWorktreeDiffQuery(projectName)` that calls the main-worktree diff endpoint and `safeParse`s `SessionDiff`
  - Observable: a unit test with injected fetch shows the hook validates `SessionDiff` and exposes loading/error/empty states
  - _Requirements: 11.2, 11.4_
  - _Boundary: main diff consumer hook_

- [ ] 1.4 (P) Extract and test the composer mode router
  - Implement `detectComposerMode(draft)` as a pure function: `/...` => command; a leading filter key (`is`/`status`/`target`/`branch`/`archived`) or a trailing `:` => filter; otherwise chat
  - Write the failing test first (red-green): cover prose, each filter key, the `status:`→`is:` alias, `archived:true`, trailing-`:`, and whitespace edges
  - Observable: `detect-composer-mode.test.ts` passes for all three modes and the alias/edge cases
  - _Requirements: 5.1, 5.2, 5.4, 5.5, 5.6_
  - _Boundary: composer/detect-composer-mode_

- [ ] 1.5 (P) Build the cockpit view-state store and tab reconciler
  - Add the Zustand+Immer `use-cockpit-view-state` store (`openTabIds`, `activeTabId`, `railCollapsed`, `entering`) with focused selectors, and `reconcile-open-tabs` (pure) that drops closed tabs, appends newly-open ids, picks a fallback active tab, and signals first-run when none remain
  - Observable: `reconcile-open-tabs.test.ts` proves closed-active picks a fallback, all-closed signals first-run, ordering is preserved; store selectors are referenced (not whole-store reads)
  - _Requirements: 2.4, 4.6, 4.7_
  - _Boundary: cockpit/use-cockpit-view-state, cockpit/reconcile-open-tabs_

- [ ] 1.6 (P) Build the transcript row builder and spawn-card mount contract
  - Add `spawn-card-slot` types (`SpawnCardRowData` with `proposalId`/`anchorMessageIndex`, `RenderSpawnCardRow`) and `buildProjectTranscriptRows` + `projectRowKey` (pure) that interleave spawn-card rows at their anchor among message rows
  - Keep the spawn-card payload opaque (no inspection of card internals beyond `proposalId`/`anchorMessageIndex`)
  - Observable: `project-transcript-rows.test.ts` proves cards interleave at `anchorMessageIndex`, message order is preserved, keys are stable, and empty `spawnCards` yields messages-only
  - _Requirements: 10.2, 10.3, 10.5_
  - _Boundary: cockpit/project-transcript-rows, cockpit/spawn-card-slot_

- [ ] 2. Core: cockpit components (each with a Storybook story)

- [ ] 2.1 (P) Build the unified composer mode-chip and suggestion surface
  - Implement `ComposerModeChip` (recolors via `data-mode`/`data-agent`: `› <agent>` cyan Claude / violet Codex, `/` violet, `⊟` amber) and `ComposerSuggestions` (renders `computeSuggestions` output with ↑↓ navigation and ⏎ apply), reusing the existing suggestion-list semantics
  - Add `ComposerModeChip.stories.tsx` and `ComposerSuggestions.stories.tsx`
  - Observable: stories render all three mode-chip states and the command + filter suggestion groups; keyboard navigation moves the highlight and Enter applies
  - _Requirements: 5.2, 5.4, 6.1, 6.2, 9.5_
  - _Boundary: composer/ComposerModeChip, composer/ComposerSuggestions_
  - _Depends: 1.4_

- [ ] 2.2 Assemble the UnifiedComposer
  - Compose the mode-chip, field, suggestion surface, and the reused `PromptComposer` affordance pieces (Claude/Codex toggle, model/effort with rainbow at xhigh/max, image attach, voice, send) into `UnifiedComposer`; route prose→`onSendPrompt` (Enter sends, Shift+Enter newline), command→`onRunCommand`, filter→`onTokensChange`
  - Present the backend control as selectable pre-init and fixed post-init; recolor composer + assistant accent violet for Codex; expose exactly `/new`·`/capabilities`·`/workflow-builder`
  - Add `UnifiedComposer.stories.tsx` (chat/command/filter, Claude/Codex, pre-init/post-init)
  - Observable: in the story, chat Enter fires `onSendPrompt`, command Enter fires `onRunCommand` with the highlighted id and clears, filter selection fires `onTokensChange`; backend control is disabled when the conversation is initialized
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 8.4_
  - _Boundary: composer/UnifiedComposer_
  - _Depends: 1.4, 2.1_

- [ ] 2.3 (P) Build the conversation tabs
  - Implement `ConversationTabs`: one tab per open PLC, active tab cyan top-edge, non-active unread amber dot, `+ New chat` affordance, per-tab close; selection sets `activeTabId`, New chat creates+focuses, close drives the reconciler
  - Add `ConversationTabs.stories.tsx`
  - Observable: the story shows the active cyan edge, an amber unread dot on a non-active tab, New chat adding a focused tab, and closing the active tab selecting a fallback
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.8_
  - _Boundary: cockpit/ConversationTabs_
  - _Depends: 1.5_

- [ ] 2.4 (P) Build the transcript host
  - Implement `ProjectTranscriptHost`: fetch the active PLC's messages, build rows via `buildProjectTranscriptRows`, and render through the reused virtualized `ConversationPanel`/`ConversationVirtuosoList` with `renderMessageRow` and a `renderSpawnCardRow` slot (default no-op); present an empty transcript state when there are no messages
  - Add `ProjectTranscriptHost.stories.tsx` (messages only, messages + spawn-card slot stub, empty)
  - Observable: the story renders messages virtualized (not eagerly), invokes the spawn-card slot for spawn rows, and shows the empty state
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 14.6_
  - _Boundary: cockpit/ProjectTranscriptHost_
  - _Depends: 1.1, 1.6_

- [ ] 2.5 (P) Build the sessions panel and filter popover
  - Implement `SessionsPanel` (dedicated name/branch search header + filter popover + token chips with per-chip remove + clear-all + `SessionRows` + empty-results distinguishing search vs filter) and `SessionsFilterPopover` (status/target/include-archived toggles), both bound to the shared `useSessionFilters` token state
  - Add `SessionsPanel.stories.tsx` and `SessionsFilterPopover.stories.tsx`
  - Observable: in the story, a popover toggle and a composer-style token edit mutate the same chips; search filters by name/branch; clear-all empties tokens; the empty state names search vs filter
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3, 9.4, 9.5, 3.6_
  - _Boundary: cockpit/SessionsPanel, cockpit/SessionsFilterPopover_

- [ ] 2.6 (P) Build the main diff surface
  - Implement `MainDiffSurface`: mount the reused read-only `DiffPanel` with the main-diff hook result, a `main` target label, scoped diff hotkeys, and a no-changes empty state; mount no commit/discard/reset controls
  - Add `MainDiffSurface.stories.tsx` (changes present, no changes)
  - Observable: the story renders the diff read-only with the `main` label and the no-changes empty state; no git-mutation buttons exist
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - _Boundary: cockpit/MainDiffSurface_
  - _Depends: 1.3_

- [ ] 2.7 Build the conversation pane
  - Implement `ConversationPane`: header showing `main · worktree`, the transcript host, a bottom-docked composer slot, and a diff/review toggle that reveals `MainDiffSurface`
  - Add `ConversationPane.stories.tsx`
  - Observable: the story shows the `main · worktree` header, the transcript, the docked composer, and toggling the diff surface
  - _Requirements: 3.2, 3.4, 11.1_
  - _Boundary: cockpit/ConversationPane_
  - _Depends: 2.2, 2.4, 2.6_

- [ ] 3. Integration: assemble the page

- [ ] 3.1 Assemble the cockpit shell and first-run layout
  - Implement `ProjectCockpit` (three-column grid: rail · pane · sessions, with the locked defaults — composer bottom, tabs switcher, comfy density, ~60% pane width; collapsible rail; no tweak controls) mounting the existing `ConversationSidebar`, `ConversationPane`, `ConversationTabs`, and `SessionsPanel`; implement `ProjectFirstRun` (composer above the full-width sessions table, no hero/starters)
  - Apply the entry animation (8px rise + fade `.2s ease`) gated by `prefers-reduced-motion`; fold the prototype `.pc-*` classes into production naming in `cockpit.css`/`composer.css` using DS tokens only
  - Add `ProjectCockpit.stories.tsx` and `ProjectFirstRun.stories.tsx`
  - Observable: stories render the three-column cockpit with locked defaults and the single-column first-run; the rail collapses to a slim strip; no tweak controls are present
  - _Requirements: 1.1, 1.2, 1.3, 2.2, 2.6, 3.1, 3.3, 3.5, 3.7, 13.1, 13.2, 14.1, 14.2, 14.3, 14.4_
  - _Boundary: cockpit/ProjectCockpit, cockpit/ProjectFirstRun, cockpit/styles_
  - _Depends: 2.3, 2.5, 2.7_

- [ ] 3.2 Wire the page entry to open-count and replace the legacy console
  - Modify `ProjectDetailView` to read the open-conversation count and render `ProjectFirstRun` (count 0) or `ProjectCockpit` (count ≥ 1), retaining the topbar breadcrumb, connection status, project header summary, `New session` primary action, and `⌘N`; remove the legacy `CommandConsole` from the page while keeping `command-suggestions.ts`/`filter-tokens.ts`/`use-session-filters` reused
  - Wire `/new`→New Session flow, `/capabilities`→capabilities flow, `/workflow-builder`→workflow builder through the composer's `onRunCommand`
  - Observable: opening a project with zero open PLCs shows first-run; with ≥1 it shows the cockpit; `New session`/`⌘N`/breadcrumb still work; running each command opens its existing flow
  - _Requirements: 1.4, 1.5, 2.1, 2.3, 2.5, 3.5, 6.3, 6.4, 6.5_
  - _Boundary: ProjectDetailView_
  - _Depends: 1.1, 1.2, 3.1_

- [ ] 3.3 Wire tab lifecycle and shared filter state end-to-end
  - Connect `ConversationTabs` to the create/close/reopen mutations and the reconciler so opening, closing (with fallback), and reopening update tabs and the first-run↔cockpit boundary; connect `UnifiedComposer` filter mode and `SessionsPanel`/`SessionsFilterPopover` to one shared `useSessionFilters` token state instance
  - Observable: creating/closing tabs flips the layout at the zero/non-zero boundary; a filter set in the composer appears in the sessions popover and chips, and vice versa
  - _Requirements: 2.5, 4.4, 4.6, 4.7, 8.1, 8.2_
  - _Boundary: cockpit/ProjectCockpit, composer/UnifiedComposer, cockpit/SessionsPanel_
  - _Depends: 3.2_

- [ ] 3.4 Wire real-time consistency and the rail PLC-focus intent
  - Expose `projectConversationKeys` so the global conversation-event handler can invalidate the cockpit's list/messages/open-count keys on `scope: project` events (the invalidation registration is owned by the **notifications** extension, which holds the global listener — coordinate, do not fork it). The `scope: project` set that invalidates `projectConversationKeys.list`/`openCount` MUST include the foundation's project-scoped `conversation-open` lifecycle event, since the first-run↔cockpit transition (Req 2.5 / 12.3) depends on close/reopen propagating promptly. Reconcile the rail's PLC-focus intent for the current project into `activeTabId`, reopening a closed PLC as a tab
  - Until the notifications extension covers `scope: project`, fall back to the cockpit's own query refetch-on-focus so the page stays correct, and record the coordination as a follow-up
  - Observable: a project-conversation status/message/lifecycle event (including `conversation-open` close/reopen) updates the active tab, transcript, and sessions panel without a manual refresh; selecting a current-project PLC from the rail focuses (and if needed reopens) its tab
  - _Requirements: 12.1, 12.2, 12.3, 13.3, 13.4_
  - _Boundary: cockpit/use-cockpit-view-state, project-conversations-client_
  - _Depends: 3.3_

- [ ] 4. Validation

- [ ] 4.1 (P) Component and integration tests for the cockpit surfaces
  - Add DI-based tests (no `vi.mock` of internal modules) for `UnifiedComposer` (mode routing + send/command/filter + backend lock), `ConversationTabs` (indicators + New chat + close fallback), `SessionsPanel`/`SessionsFilterPopover` (shared token sync + search + chips + empty states + keyboard), `ProjectTranscriptHost` (virtualized render + spawn-card slot), and `MainDiffSurface` (read-only + empty state)
  - Observable: the test suite passes and asserts the observable behaviors above against production components with injected dependencies
  - _Requirements: 4.1, 4.2, 4.3, 4.5, 5.3, 6.6, 8.3, 8.4, 8.5, 9.1, 9.2, 9.4, 10.1, 10.4, 11.1, 11.3, 11.5_
  - _Boundary: cockpit, composer_
  - _Depends: 3.1_

- [ ] 4.2 (P) Query-layer tests (consumer contracts)
  - Add tests (injected fetch) proving `projectConversationKeys` hooks call the documented foundation routes and `safeParse`, `useSendProjectPrompt` create-and-sends when `conversationId` is null, mutations invalidate the right keys, and the main-diff hook validates `SessionDiff`
  - Observable: the suite passes and pins the route/shape consumer contract so a foundation-shape change fails a test
  - _Requirements: 1.5, 4.4, 4.6, 5.7, 11.2, 12.3, 12.4_
  - _Boundary: project-conversations-client, main diff consumer hook_
  - _Depends: 1.1, 1.2, 1.3_

- [ ] 4.3 End-to-end project-page flows
  - Add Playwright coverage (against the foundation, live or mocked): first-run → cockpit on first prompt with the new tab focused and the entry animation; closing the last tab returns to first-run; `/` opens the palette and runs a command; `is:running` adds a chip visible in both the composer and the sessions popover
  - Observable: the E2E run demonstrates the transition, the command palette, and shared filtering end-to-end on the project page
  - _Requirements: 2.1, 2.2, 2.3, 2.5, 4.7, 5.4, 6.2, 8.1, 8.2_
  - _Depends: 3.4_

- [ ] 4.4 (P) Performance and design-system verification
  - Verify the transcript stays virtualized at large message counts (no eager full render), the cockpit uses focused Zustand selectors and memoized derived lists with no whole-store reads on hot paths, and all visuals reference DS tokens with semantic color and the motion rules (`.15s`/`.2s ease`, no spring/bounce)
  - Observable: a render/perf check shows no perceptible regression versus the current project/session/Conversations pages, and a DS review confirms tokens-only styling and the locked motion rules
  - _Requirements: 14.1, 14.2, 14.3, 14.5, 14.6_
  - _Boundary: cockpit, composer_
  - _Depends: 3.1_
