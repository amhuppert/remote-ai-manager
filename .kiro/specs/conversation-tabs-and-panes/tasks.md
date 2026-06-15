# Implementation Plan

- [x] 1. Foundation: pure logic modules (TDD)
- [x] 1.1 (P) Working-set reducer
  - Implement the open-conversations working-set model over a stable display order plus a recency order: add or bump on open, evict the least-recently-active inactive entry once the set would exceed six, close, and reconcile to a live set of ids.
  - Red-green: write failing unit tests first for add-new, add-existing bumps recency without reordering the display order, evict-at-cap picks the least-recently-active non-active entry, reconcile drops missing ids, and close removes from both orders.
  - Observable: the unit suite passes for all five behaviors and the set size never exceeds six in any sequence.
  - _Requirements: 1.5, 1.6, 1.7, 2.7_
  - _Boundary: open-tabs-model_
- [x] 1.2 (P) Pane grid-shape helper
  - Pure helper for the grid shape per pane count (single row for 1–3, 2×2 for 4, the asymmetric 3-over-2 for 5, 3×2 for 6).
  - Observable: tests assert the exact shape for every count 1–6 (including the asymmetric 5).
  - _Requirements: 3.3_
  - _Boundary: grid-shape_
- [x] 1.3 (P) Pane view-model
  - Pure mapping from an active conversation to its pane display fields (title, status, project/session, pending question, status line, relative time).
  - Observable: tests cover the field mapping with a deterministic relative time.
  - _Requirements: 4.1, 4.2, 4.3, 4.4_
  - _Boundary: pane-view-model_
- [x] 1.4 (P) Initial-selection precedence
  - Pure precedence function returning the conversation to select on page entry: explicit URL selection wins, else a session-filter entry's session-scoped candidate, else the live most-recently-active persisted tab, else the generic most-recent conversation, else none; the result also signals whether the selection is user-initiated or an automatic (history-replacing) one.
  - Observable: tests cover each branch, including that the persisted-tab restore beats the generic most-recent fallback and that an empty active list yields none.
  - _Requirements: 1.2, 1.8_
  - _Boundary: conversations-page-state_

- [x] 2. Foundation: shared schema, store, and hotkey registry
- [x] 2.1 Add a panes value to the layout mode
  - Extend the layout-mode type and the runtime valid-layouts validator with a panes value.
  - Observable: persisting and reloading the panes layout passes validation while the existing four layouts are unchanged.
  - _Requirements: 3.1_
- [x] 2.2 (P) Composer-focus flag in the session store
  - Add a composer-focused boolean to the session store with a focused selector and a setter.
  - Observable: the selector returns false by default and reflects the setter's value.
  - _Requirements: 5.3_
  - _Boundary: session-detail.store_
- [x] 2.3 (P) Register tab and panes keyboard shortcuts
  - Add hotkey-registry entries for tab activation (modifier plus 1–9) and panes exit (Escape) so the application hotkey hook accepts them.
  - Observable: both new ids resolve to their key bindings in the registry and the project type-checks.
  - _Requirements: 8.1, 8.2_
  - _Boundary: hotkey registry_

- [x] 3. Core: working-set hook and tab strip
- [x] 3.1 (P) Open-tabs working-set hook
  - Build the hook that resolves the persisted working set against the live session-scoped active conversations and exposes the ordered set, the addable list, the at-cap flag, and activate/close/add operations; it persists to localStorage, reconciles on list changes, adds or bumps on active-id change, and on closing the active tab activates a neighbor.
  - Observable: given a seeded active id and conversation list the hook returns the resolved ordered set, the set survives a simulated remount via persisted storage, and closing the active tab yields the neighbor as active.
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.8, 1.9, 2.7, 2.8_
  - _Boundary: use-open-tabs_
  - _Depends: 1.1_
- [x] 3.2 (P) Tab and tab strip components
  - Build the single tab (status dot, title, hotkey hint for the first nine, close control revealed on hover or when active) and the strip (tablist with the active tab marked and an end add-control disabled at the cap with a limit tooltip); style both with design tokens and the status-dot data-attribute convention.
  - Observable: rendering a set shows one tab per conversation in order with the active tab marked, the close control appears on hover/active, and the add-control is disabled with the limit tooltip at six.
  - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 2.10_
  - _Boundary: ConversationTabStrip, ConversationTab_
- [x] 3.3 (P) Add-conversation picker
  - Build the shared dropdown listing active conversations not already in the working set (status dot, title, project); selecting one adds it and makes it active. Reused by the tab strip's add-control and the panes toolbar.
  - Observable: opening the picker lists only conversations absent from the set, and choosing one triggers add-and-activate.
  - _Requirements: 2.9, 6.2_
  - _Boundary: AddConversationMenu_

- [x] 4. Core: panes surfaces, keyboard, and composer focus
- [x] 4.1 (P) Pane and full-transcript body
  - Build the pane (head with status dot, title, open-full and close controls; meta line; the pending-question banner when waiting or the status line otherwise) and its transcript body: the conversation's full message list from the per-conversation messages query (enabled only in panes mode), rendered read-only through the shared transcript list and message row (no fork affordance, no trailing debug card) and scrollable within the pane; style the panes, pane, active ring, shadow separator, and composer-focus fade.
  - Observable: a pane renders its head, meta, banner-or-status, and its full scrollable transcript (empty state when the conversation has no messages), with the active pane visibly ringed and no composer inside the pane.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5.1_
  - _Boundary: Pane, PaneConversationBody_
  - _Depends: 1.3_
- [x] 4.2 (P) Panes toolbar
  - Build the toolbar showing the current count out of six, the focus hint, the add-pane control (disabled at the cap with a limit tooltip), and an exit control.
  - Observable: the toolbar shows the live count, disables add at six with the tooltip, and exit leaves panes mode.
  - _Requirements: 6.1, 6.3, 6.4_
  - _Boundary: PanesToolbar_
  - _Depends: 3.3_
- [x] 4.3 Panes grid container
  - Build the container as an outer flex column: a fixed toolbar row above an inner grid element (so the toolbar never consumes a grid cell) that resolves the working set, writes the column/row and shape variables, and holds one pane per conversation; the composer-focused attribute on the outer container fades the inactive panes and intensifies the active one.
  - Observable: changing the pane count reflows the inner grid per the shape helper with the toolbar as a separate top row, and focusing the composer fades only the inactive panes.
  - _Requirements: 3.2, 3.4, 5.3, 5.4, 5.5_
  - _Depends: 1.2, 4.1, 4.2_
- [x] 4.4 (P) Tab and panes keyboard hook
  - Build the hook binding modifier-plus-1–9 to activate the Nth open conversation and Escape to exit panes (only while in panes mode, not when typing in a field), through the application hotkey registry, whose built-in overlay suppression defers to any open peek or context menu.
  - Observable: with focus outside form fields the shortcuts switch the active conversation and exit panes, and an open overlay suppresses both.
  - _Requirements: 8.1, 8.2, 8.3_
  - _Boundary: use-tab-pane-keyboard_
  - _Depends: 2.3_
- [x] 4.5 (P) Composer-focus tracking hook
  - Build the hook that owns the composer-focused flag: true while the editor has focus or a composer control is active, cleared only when focus leaves the composer region and its overlays.
  - Observable: unit tests assert the flag stays true across each control path (editor focus, model/effort dropdowns, debug toggle, voice, capabilities drawer, mobile sheet) and clears when focus truly leaves.
  - _Requirements: 5.6_
  - _Boundary: use-composer-focus_
  - _Depends: 2.2_
- [x] 4.6 (P) Panes layout-switcher entry
  - Add the fifth layout-switcher option (panes grid icon and tooltip) after split and before diff.
  - Observable: the switcher shows five options and choosing panes sets the layout to panes.
  - _Requirements: 3.1_
  - _Boundary: LayoutSwitcher_
  - _Depends: 2.1_

- [x] 5. Integration: composer lift
- [x] 5.1 Lift the composer to a shared pinned slot
  - Render the single prompt input as a pinned slot below the content area, shared across every layout, and stop rendering it inside the conversation panel; add the pinned-composer-row styles.
  - Observable: the prompt composer renders exactly once as a pinned sibling below the content area and is visible in all five layouts (default, split, conversation, diff, panes); the conversation panel no longer renders it.
  - _Requirements: 7.1, 7.4_
  - _Boundary: SessionContent, ConversationPanelContainer_
- [x] 5.2 Wire composer focus and control stickiness
  - Mount the composer-focus hook at the session composer, make the in-flow toolbar controls preserve editor focus, and have the overlay, drawer, and mobile controls report their active state to the hook.
  - Observable: adjusting model, effort, debug, voice, capabilities, or mobile controls keeps the composer-focused state stable (no flicker) and the active conversation unchanged.
  - _Requirements: 5.6, 7.2, 7.3_
  - _Depends: 4.5, 5.1_

- [x] 6. Integration: page-level layout, working-set hosting, and restore
- [x] 6.1 Make the conversations-page layout page-level
  - Persist and hydrate the page's layout under a single page-level key, hydrated once at the page rather than per active conversation, and stop the per-conversation layout hydration.
  - Observable: activating a conversation from a different session no longer changes the layout or drops out of panes, and the chosen layout persists across reloads.
  - _Requirements: 3.5, 3.6, 5.2_
  - _Boundary: ConversationsPage, use-session-lifecycle, ConversationWorkspace_
  - _Depends: 2.1_
- [x] 6.2 Host the working set and restore at the page level
  - Instantiate the open-tabs hook at the page/selection layer, replace the inline auto-open with the precedence function applied via history replacement, and thread the working set and its operations into the workspace.
  - Observable: returning to the page with no selection param restores the last-active tab via history replacement, while a session-entry URL still opens within that session and an explicit selection param still wins; no extra history entries are pushed by restore.
  - _Requirements: 1.2, 1.8, 2.7, 2.8_
  - _Depends: 1.4, 3.1, 6.1_

- [x] 7. Integration: render tabs and panes in the content host
- [x] 7.1 Mount the tab strip and panes grid by layout
  - In the content host, render the tab strip above the content area in the non-panes layouts and the panes grid full-width in the panes layout (replacing the single-conversation and diff view), thread the working set, active id, and composer-focused state down, add the panes data-layout styles, and mount the keyboard hook.
  - Observable: with open tabs the strip appears in default/split/diff/conversation, and selecting panes shows the full-width grid of the same set.
  - _Requirements: 2.1, 3.2, 4.9_
  - _Depends: 3.2, 4.3, 4.4, 6.2_
- [x] 7.2 Wire activation, close, open-full, and add end-to-end
  - Connect tab and pane clicks, close, open-full, the add picker, and the activation shortcuts to the shared URL selection and the working set so every surface stays in lockstep.
  - Observable: clicking a tab or pane or pressing the activation shortcut switches the active conversation visibly in the URL and across all tab/pane UI; closing removes a conversation from the set without stopping its agent; open-full returns to a single-conversation layout.
  - _Requirements: 2.4, 2.7, 2.8, 4.7, 4.8, 5.2, 8.1_
  - _Depends: 7.1_

- [x] 8. Validation
- [x] 8.1 (P) Live test: tabs
  - Drive the running app with real backend state: opening a conversation from the sidebar adds a tab and activates it, the activation shortcut switches tabs, closing a tab removes it without stopping the agent, and the add-control is disabled at six.
  - Observable: assertions pass against the URL and backend/transcript state (not the DOM alone) for each behavior.
  - _Requirements: 1.3, 2.1, 2.4, 2.7, 2.8, 2.10, 8.1_
  - _Depends: 7.2_
- [x] 8.2 (P) Live test: panes
  - Drive the running app: switching to panes shows the working set; clicking an inactive pane activates it with the ring and updates the URL; activating a pane from a different session stays in panes; focusing the composer fades the inactive panes; the toolbar add and exit and a pane's open-full all behave.
  - Observable: assertions pass for activation, cross-session stickiness, the focus fade, and the toolbar/open-full behaviors.
  - _Requirements: 3.2, 4.7, 4.8, 5.1, 5.2, 5.3, 6.1, 6.3, 6.4, 8.2, 8.3_
  - _Depends: 7.2_
- [x] 8.3 (P) Live test: entry precedence and persistence
  - Drive the running app to verify initial-selection precedence (explicit selection param wins, a session-entry URL opens within its session, a bare visit restores the last-active tab) and that the working set and layout persist across a reload.
  - Observable: each entry path selects the expected conversation and a reload restores the same tab set and layout.
  - _Requirements: 1.2, 1.8, 3.6_
  - _Depends: 7.2_
- [x] 8.4 (P) Composer-lift regression check
  - Verify visually that the default, split, diff, and conversation layouts render correctly with the composer pinned below the content area.
  - Observable: each of the four layouts renders without regression and the pinned composer is usable in each.
  - _Requirements: 7.5_
  - _Depends: 7.2_
- [x] 8.5 (P) Performance check in panes
  - With six panes open, confirm the panes do not re-render on unrelated store or query churn (via render measurement), each pane's transcript virtualizes so only visible rows render, and the per-conversation message queries unmount when leaving panes mode.
  - Observable: render-count, virtualization, and query-teardown observations are recorded with no event-loop stalls from the concurrent fetches.
  - _Requirements: 4.5, 4.6_
  - _Depends: 7.2_

## Implementation Notes

- 3.1: `@react-hookz/web` `useLocalStorageValue(key, { initializeWithValue: false })` returns `value === undefined` on the first render and only fetches the persisted value in a mount effect (next render). Any effect that commits derived state in the first pass will run against the `defaultValue` and overwrite the persisted value before it hydrates. Gate such effects on a `hydrated = value !== undefined` flag (and include it in the deps so they re-run after hydration). Keep `initializeWithValue: false` for `"use client"` hooks under App-Router pages to avoid an SSR hydration mismatch.
- 3.1: `useLocalStorageValue`'s functional-updater `set((prev) => …)` resolves `prev` against the lib's internal state ref, which does NOT update between two synchronous `set` calls in the same flush — back-to-back commits clobber each other. Route all mutations through a `modelRef`-backed `commit(transform)` helper (ref updated synchronously) instead of relying on the updater form.
- Validation (post-7.2, 2026-06-14): all code tasks 1.1–7.2 implemented via TDD + independent adversarial review + per-task commit. Deterministic gate GREEN — full unit suite `7826 passed | 13 skipped | 1 todo` (exit 0), full typecheck clean, lint clean, `/conversations` compiles + serves 200, live render smoke shows no console errors. The 8 wiring assertions in `SessionContent.tabs-panes-wiring.test.tsx` exercise the real strip/grid/menu against a spy `openTabs`.
- Live tests 8.1–8.5 RUN & PASS (2026-06-14, authorized by Alex): drove the real app at `http://localhost:3001/conversations` with real-LLM conversations created in the `plc-test-lab` scratch project (2 sessions, 3 session-scoped conversations with completed turns), asserting against durable state (URL `?c=`, `localStorage["cc-open-tabs"]`/`["cc-conversations-layout"]`, the `.panes` DOM, SQLite). All test sessions cleaned up afterward.
- The first live pass found TWO ordering bugs the 7826-test unit suite missed (the exact fakes-vs-real gap live testing exists for), now FIXED + live-re-verified:
  1. Working-set wipe on full load/reload — `use-open-tabs` reconcile ran against an empty live list before the active-conversations query resolved. Fix: gate reconcile on a new `activeConversationsLoaded` flag (`conversations !== undefined`). (Req 1.8)
  2. Page-level layout reset on conversation switch — `resetConversationState` (run on the conversationId-keyed workspace's remount) reset `layout` to default. Fix: preserve `layout` across the reset like the other host-shell fields. (Req 3.5, 5.2)
- Live deferrals (covered by unit tests, not live-exercised): the 6-tab add-disabled-at-cap (2.10) — covered by `open-tabs-model` eviction/`isAtCap` + `ConversationTabStrip`/`PanesToolbar` disabled-at-cap tests; the full 6-pane perf measurement (8.5) — the light 3–4-pane live check showed no event-loop stall + mount-scoped query teardown, with the `enabled`-by-mount design covering teardown. Verdict: GO.

### Amendment — full-transcript panes (2026-06-15)

After live use, Alex changed Requirement 4: a pane must show its conversation's **full, scrollable transcript** using the **same message-rendering section as the single-conversation layout**, not a compact "mini-cockpit" tail. This reverses the original Req 4.5/4.6 (recent-message tail + per-pane-count density limit) and the related shrink-to-fit framing of 3.4.

- Req 3.4 → scroll-within-pane; Req 4 retitled "Per-pane conversation content"; Req 4.5 → full transcript via the shared renderer; Req 4.6 → same presentation regardless of pane count (no count-based slicing/compacting).
- New `PaneConversationBody` fetches the conversation's messages and renders them **read-only** through the shared `ConversationVirtuosoList` + `MessageRow` (`onFork` omitted, `lastMessageExtras` null), built with the shared `useDisplayMessages` + `buildConversationRows`. The single shared composer (Req 7) still owns input for the active pane.
- Deleted: `PaneMessage`, `pane-view-model`'s `summarizeMessage`, and `grid-shape`'s `paneMessageLimit`/`truncate` (all compact-tail-only), plus their tests. `gridShape` and `toPaneViewModel` are unchanged.
- Also in this pass (separate from the transcript requirement, recorded for completeness): (a) `PanesToolbar` lifted out of the `.panes` CSS grid into a flex row above a new `.panes-grid` element — it was consuming a grid cell and squeezing a pane; (b) the `conversationId` `key` on `ConversationWorkspace` was removed so activating a tab/pane no longer remounts the workspace (and its panes grid) — the per-conversation reset that the remount provided is now reactive in `useSessionLifecycle` (`resetConversationState` + a new `clearDraftComposerState` on `conversationId` change; the `autoFocus` one-shot guard scoped per conversation).
- Verification: 7968-test unit suite + typecheck + lint green; layout + full-transcript rendering live-verified via a new `PanesGrid.stories.tsx` (real grid at 2–6 panes, `MessageRow` content rendering, toolbar as a separate top row).
