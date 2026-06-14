# Research & Design Decisions

## Summary

- **Feature**: `conversation-tabs-and-panes`
- **Discovery Scope**: Extension (new UI on the existing `/conversations` page)
- **Key Findings**:
  - Active conversation is **purely URL-driven** (`?c=`); there is no store-based "current conversation". `openConversation({conversationId})` in `use-conversations-page-selection.ts:107` mutates it via `history.pushState`. → The working set should *react* to the active id, not own it.
  - All reuse points exist and were located at file:line: `useConversationMessagesQuery` (`src/hooks/conversation/use-conversation-messages-query.ts:7`), `useActiveConversationsQuery` (`src/lib/active-conversations/queries.ts:6` — the sidebar's source; **not** the thin `useAllConversationsQuery`), layout infra (`LayoutMode` `src/lib/sessions/schemas.ts:10`; `validLayouts` + `switchLayout`/`hydrateLayout` in `src/stores/session-detail.store.ts:123,159`), `LayoutSwitcher.tsx`, `SessionContent.tsx` `data-layout` grid.
  - The composer (`PromptInputSlot`) is currently mounted **inside** `ConversationPanelContainer` (`:155`) → `ConversationPanel`. Lifting it to a shared pinned slot below `.session-content-area` is the only change touching the existing default/split/diff/conversation layouts.

## Research Log

### Active-conversation selection model
- **Context**: The working set needs an "active" concept; must not create a second source of truth.
- **Findings**: `parseConversationsPageParams` reads `?c=` → `conversationId`; `ConversationWorkspace` is keyed on it (`ConversationsPage.tsx` `key={...conversationId}`); `openConversation` is the only mutator (history.pushState). `ConversationWorkspaceProps` already accepts `onOpenConversation?`.
- **Implications**: Tabs/panes activation = call `onOpenConversation` (changes URL). The working-set hook observes the active id (from params) and adds/bumps on change. Unidirectional: URL → working set.

### Per-pane transcript tails
- **Context**: Up to 6 panes each show a recent-message tail; must work for non-active conversations.
- **Findings**: `useConversationMessagesQuery(projectName, sessionName, conversationId, { enabled })` returns `stampedTranscriptMessage[]` (full transcript). Already used by `PeekPopover` for a non-active conversation. No server-side tail/limit param — full transcript is fetched, tail sliced client-side. `TranscriptMessage` = `{ role: "user"|"assistant"|"notice"; content: MessageContentBlock[]; timestamp; ... }`; `MessageContentBlock` union covers `text`/`tool_use`/`tool_result`/`command`/`image*`.
- **Implications**: Reusable as-is. Six concurrent full-transcript fetches is the primary perf risk → mount only in panes mode (queries `enabled` gates), rely on React Query dedup + `staleTime`, slice tail client-side. Future optimization (out of scope): a server-side tail param.

### Layout persistence quirk
- **Context**: Adding `"panes"` as a 5th layout; how/where layout persists.
- **Findings**: `switchLayout(mode, storageKey)` writes `localStorage[cc-layout-${project}-${session}]`, validated against `validLayouts`. `storageKey` is built from the **active conversation's** project/session in `ConversationWorkspace.tsx:71`.
- **Implications**: Panes is a cross-conversation view but its layout value persists under the active conversation's session key — consistent with existing per-session layout behavior. Cross-session layout divergence is pre-existing; not addressed here.

### Existing cockpit tab component
- **Context**: A `ConversationTabs.tsx` already exists at the project cockpit.
- **Findings**: It is presentational but cockpit-specific (`.plc-tabs` classes, `onNewChat`, no hotkeys, no cap, server-authoritative model). Locked decision: cockpit stays a separate surface.
- **Implications**: Build a fresh `/conversations` tab strip (adopt the visual pattern, not the component) to keep surfaces decoupled.

## Design Decisions

### Decision: Working set reacts to the URL; it does not own "active"
- **Alternatives**: (A) a store holding both openTabs + activeId; (B) URL owns active, a persisted set reacts.
- **Selected**: B. A `useOpenTabs` hook persists the set (localStorage) and, via effect on the URL-derived active id, adds/bumps; reconciles against the live list.
- **Rationale**: Avoids a second source of truth; one unidirectional flow (URL → set). Activation everywhere (sidebar click, tab click, ⌘1–9, pane click) is just `onOpenConversation`.
- **Trade-offs**: The set is eventually-consistent with the URL via effect (one render). Acceptable.

### Decision: Pure reducer for the working set, with `{ tabs, lru }`
- **Selected**: `open-tabs-model.ts` pure functions over `{ tabs: string[]; lru: string[] }` — `tabs` is stable display order; `lru` is least→most-recently-active for eviction. `openInSet`, `closeTab`, `reconcile`, `MAX_TABS = 6`.
- **Rationale**: Display order stays stable (browser-tab behavior) while eviction uses recency. Pure + sequence-driven (no `Date`) → fully unit-testable per `engineering-principles`.
- **Trade-offs**: Two arrays to keep in sync; the reducer centralizes that invariant.

### Decision: Ship only the "shadow" pane separator
- **Selected**: Hard-code the three CSS variables + the single `:not(.active)` shadow rule; no `data-separator` attribute switch (the prototype's 4-variant tweak is dropped).
- **Rationale**: Locked decision + the handoff's own note that shipping just shadow means hard-coding the values. YAGNI.

### Decision: `composerFocused` as a focused store boolean
- **Selected**: Add `composerFocused` + `setComposerFocused` to `session-detail.store.ts` with a focused selector `useComposerFocused()`. The editor sets it on focus/blur; `PanesGrid` reads it to toggle `data-composer-focused`.
- **Rationale**: Composer (deep in `PromptEditor`) and `PanesGrid` (in `SessionContent`) are far apart in the tree; a focused store accessor avoids prop-drilling and follows `PERFORMANCE.md` focused-accessor/setter guidance. Ephemeral (not persisted).
- **Trade-offs**: A tiny bit of global state; justified by the cross-tree read.

### Decision: Lift the composer to a pinned sibling of `.session-content-area`
- **Selected**: `SessionContent` renders `promptInputSlot` as the last child of `.session-detail-layout`, below `.session-content-area`, for all layouts (incl. panes). `ConversationPanelContainer`/`ConversationPanel` stop rendering it.
- **Rationale**: In panes mode `.session-content-area` is replaced by the grid, so the composer must live outside it; a single shared mount serves every layout.
- **Trade-offs**: Touches all existing layouts (highest regression risk) and makes the composer span full width below the diff in default/split, and appear in diff-only/conversation where the in-panel composer differed. Requires live + visual verification (R7.5).

## Post-Validation Revisions (validate-design NO-GO, round 1)

A `/kiro-validate-design` pass (Codex) returned NO-GO with three integration mismatches; all three were verified against the code and the design was revised:

1. **Data source corrected** — `useAllConversationsQuery` returns `{ items: ConversationListItem[] }` (thin: no `pendingQuestion`/`lastActivitySummary`/scope). The rich source is `useActiveConversationsQuery` → `activeConversationsResponseSchema.conversations: ActiveConversation[]` (`src/lib/active-conversations/queries.ts:6`, `schemas.ts:164`), which `ConversationSidebar.tsx:241` already consumes. The working set/panes now depend on it, filtered to `scope === "session"` (`SessionActiveConversation`), which also guarantees the `sessionName` that `useConversationMessagesQuery` needs. `ActiveConversation` is a `session|project` discriminated union (`schemas.ts:72,78`); project-scoped rows are excluded (not workspace-openable).
2. **Active-selection restore relocated** — `useOpenTabs` moves from `ConversationWorkspace` (not mounted when `/conversations` has no `?c=`) up to the page/selection layer (`use-conversations-page-selection.ts`, mounted in the empty state). Restore target = the live `lru` tail (the persisted last-active id), opened before the existing auto-open fallback; no separate `activeId` field needed. Satisfies 1.2/1.8.
3. **Overlay/focus aligned with shipped systems** — Esc/`⌘1–9` register through `useAppHotkey` (`src/hooks/useAppHotkey.ts`) and Esc-exit participates in the `useOverlayScope` stack (`src/hooks/useOverlayScope.ts`) instead of a `defaultPrevented` guess. `composerFocused` is set from the session `PromptComposer` boundary, never from the shared `PromptEditor` (reused by `PeekPopover` and the cockpit `UnifiedComposer` — verified), so non-session editors can't trigger the pane fade.

## Post-Validation Revisions (validate-design NO-GO, round 2)

A second `/kiro-validate-design` pass returned NO-GO on three deeper integration gaps; all verified against code and revised:

1. **Panes collapse on cross-session activation** — `useSessionLifecycle.ts:68` re-runs `hydrateLayout(storageKey)` on `storageKey` change, and `storageKey = cc-layout-${project}-${session}` is built from the *active* conversation (`ConversationWorkspace.tsx:71`). Activating a pane from another session re-hydrated that session's layout and dropped out of panes (breaks 3.5/5.2). Fix: `/conversations` layout is now **page-level** — single key `cc-conversations-layout`, hydrated once at the page, not per active conversation. Trade-off (confirmed with Alex): drops per-session layout memory on `/conversations`.
2. **Restore-on-entry vs session-filter entry semantics** — `use-conversations-page-selection.ts` already seeds a session filter from `?project=&session=` and auto-opens a *session-scoped* candidate via `replaceState`. A blind LRU-restore via `pushState` would open an unrelated conversation and pollute history. Fix: explicit initial-selection precedence — (1) `?c=`, (2) session-filter entry params → existing session-scoped auto-open, (3) else LRU restore — and restore uses `replaceState`.
3. **Hotkeys need registry entries** — `useAppHotkey` only accepts ids from `HOTKEY_REGISTRY` (`src/lib/shared/hotkeys.ts:14`, closed `HotkeyId` union); no tab/panes ids exist. Fix: add `activateOpenTab` (`mod+1..9`) + `exitPanes` (`Escape`) to the registry. Bonus: `useAppHotkey` already suppresses page hotkeys when `useIsOverlayOpen()` (`overlay-scope.store`) is true, so overlay-first Escape (8.3) is automatic; `exitPanes` is gated to `layout === "panes"` and not `enableOnFormTags` so the composer's existing `clearInput` Escape still wins while typing.

## Post-Validation Revisions (validate-design NO-GO, round 3)

Third pass returned NO-GO on two refinements (the reviewer self-corrected a false "shared route" concern; no new architectural faults). Both addressed:

1. **Initial-selection precedence made explicit & pure** — the restore-vs-auto-open ordering was ambiguous. Added `selectInitialConversation` (pure, in `conversations-page-state.ts`, beside the existing `selectAutoOpenCandidate`): `?c=` → session-filter auto-open → live LRU restore → generic most-recent fallback → `none`. Returns an `auto` kind so the caller uses `replaceState`. Unit-tested per branch (1.2, 1.8).
2. **Composer focus model specified for all control paths** — naive editor blur would drop the pane fade when opening model/effort dropdowns, the capabilities drawer, or mobile sheets. Defined `composerFocused = editorHasFocus OR aComposerControlIsActive`, owned by a new `use-composer-focus.ts` hook: in-flow toolbar triggers use `onMouseDown→preventDefault` (the repo idiom — `ImageMarkerChip.tsx:66`, `SlashCommandChip.tsx:72`); overlay/focus-taking controls contribute active-state; `focusout` clears only when `relatedTarget` leaves the composer region + its overlays. Test per control path (5.6).

Both fixes reuse existing patterns (`selectAutoOpenCandidate`, the `onMouseDown` preventDefault idiom) rather than inventing new ones.

## Risks & Mitigations
- **6× full-transcript fetch in panes** — mount queries only in panes mode (`enabled`), React Query dedup + `staleTime`, client-side tail slice; validate re-renders with react-scan. Future: server tail param.
- **Composer-lift visual regression across default/split/diff/conversation** — explicit live + visual verification on every layout before GO; the composer now appears in diff-only/conversation (previously the in-panel composer was hidden in diff) — confirm with Alex at design review.
- **Sticky composer focus while adjusting model/effort/debug** — toolbar control buttons must use `onMouseDown` → `preventDefault` so focus (and the pane fade) does not flicker; audit existing toolbar buttons.
- **Working-set ↔ URL divergence on edge cases** (closing the active/last tab, conversation disappears mid-session) — covered by the reducer (`closeTab` neighbor navigation, `reconcile`) and unit tests.

## References
- Design handoff bundle: `./command-center-multi-tasking-ui-improvements/project/` (`Tabs & Panes - Handoff.html`, `SPEC.md`, prototype JSX) — UX source of truth only.
- `PERFORMANCE.md`, `.claude/skills/cc-design-system` — perf + DS conformance.
