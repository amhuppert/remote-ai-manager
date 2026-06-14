# Brief: conversation-tabs-and-panes

## Problem

The operator on the `/conversations` page can only see and work with **one conversation at a time** (selected via the `?c=` URL param). Juggling several active agents means repeatedly returning to the sidebar and re-selecting — every context switch costs a navigation. The user is the bottleneck, not the agents, so the cost of switching between and watching multiple conversations needs to drop to near-zero.

## Current State

`/conversations` (`src/features/session/ConversationsPage.tsx`) renders a `ConversationSidebar` plus exactly **one** `ConversationWorkspace`, keyed to the `?c=` conversation. Selection is shallow URL state (`src/lib/conversations/hrefs.ts`, `use-conversations-page-selection.ts` via `history.pushState`). There is **no concept of an "open set"** and no multi-conversation view on this page.

Already shipped and reusable (verified during reconciliation):
- Status enum `new | running | awaiting | waiting_for_input` + `pendingQuestion` in `src/lib/active-conversations/schemas.ts`.
- `useConversationMessagesQuery(project, session, id, { enabled })` — already used by `PeekPopover` to load a non-active conversation's transcript tail.
- `LayoutMode` TS union (`src/lib/sessions/schemas.ts:10`), validated by an array in `src/stores/session-detail.store.ts:123`, persisted to localStorage (`cc-layout-${project}-${session}`).
- `LayoutSwitcher.tsx` (rendered inside `SessionInfoStrip`, not the topbar) with 4 layouts + `.layout-switcher`/`.layout-btn` classes.
- `SessionContent.tsx` renders `<div className="session-content-area" data-layout={layout}>`; layout switching is CSS-grid-driven.
- Single composer (`PromptInputSlot` → `PromptComposer` + `PromptDesktopToolbar`), currently mounted **inside** `ConversationPanelContainer`, keyed to the active conversation.
- DS tokens in `src/features/_root/styles/tokens.css` (Anybody / Manrope / Geist Mono). Status dots use the `[data-status="…"]` convention.

A separate conversation-tab system already exists at the **project cockpit** (`src/features/project-detail/cockpit/`: `ConversationTabs.tsx`, `use-cockpit-view-state.ts`, `reconcile-open-tabs.ts`). It is server-authoritative (open-set decided by the server) and incompatible with this design's curated client-owned model. It stays a separate surface; only its *pattern* (reconcile against the live list) is borrowed, not its code.

## Desired Outcome

On `/conversations`, the operator can:
1. Keep a small **working set of open conversations** as a browser-style **tab strip** above the conversation pane, switching with a click or `⌘1–9`.
2. Switch into a **Panes (split-screen) layout** that lays the same working set out as 2–6 live mini-cockpits, watching and triaging the fleet without leaving the page.
3. Reply to any of them through **one shared composer** whose destination conversation is unmistakable.

Tabs and panes are **two presentations of one underlying set** — they never diverge.

## Approach

A single cohesive spec built on one shared state spine, the `openTabs` working set:

- **`openTabs`** — ordered array of conversation ids, hard cap **6**, persisted to **localStorage**. The active tab/pane is the `?c=` URL param (URL stays the source of truth for *active*; `openTabs` is the working set).
- **Open-on-navigate** — opening any conversation from the sidebar adds it to `openTabs` and makes it active. Linking to a `?c=` not in the stored set opens it and makes it active. At the cap, opening always succeeds and **evicts the least-recently-active inactive tab** (browser-like).
- **Reconcile** `openTabs` against the live conversation feed (drop ids whose conversation disappeared) — pattern borrowed from the cockpit's `reconcile-open-tabs.ts`, not its code.
- **Tab strip** — new presentational components mounted above `.session-content-area` in `SessionContent`, gated on `openTabs.length > 0`.
- **Panes layout** — add `"panes"` as the 5th `LayoutMode` (after `split`, before `diff`): extend the union (`schemas.ts:10`), the validator array (`session-detail.store.ts:123`), and the `LayoutSwitcher` list + a new `layoutPanes` icon. In `SessionContent`, `layout === "panes"` renders a full-width panes grid instead of `ConversationPanelContainer + RightPane`. Each pane is a mini-cockpit (head, meta, awaiting-banner or status line, transcript tail via `useConversationMessagesQuery`). Active pane = `?c=`; cyan ring + composer-focus fade via `data-composer-focused`. Grid shapes per pane count (1–6), incl. the asymmetric 5 case.
- **Composer lift** — move the single composer out of `ConversationPanelContainer` to a **shared pinned slot below the content area**, shared across default + panes layouts, targeting the active conversation/pane. Wire textarea focus → `data-composer-focused`.

Field mapping (prototype → prod schema): title → `summary`/`name`; statusLine → `lastActivitySummary`; awaitingQuestion → `pendingQuestion`; time → `lastActivityAt`. `currentTool` is **not** in the schema → drop the pane tool-chip unless later derived.

DS: follow the handoff doc's token names (which match production); **do not** copy the prototype `styles.css` verbatim — it uses non-existent tokens (`--bg-deep`, `--border-faint`, `--tabs-h`, `--rightpane-w`) and the `.row__dot--{status}` class convention instead of prod's `[data-status]`.

## Scope

- **In**:
  - Shared `openTabs` working-set model (localStorage, cap 6, LRU eviction, reconcile against live feed).
  - Tab strip above the conversation pane (status dot, title, `⌘N` hint, close ×, `+` add-picker).
  - Panes (split-screen) layout: 5th layout mode, grid shapes for 1–6, per-pane mini-cockpit, panes toolbar (count `N/6`, focus hint, Add-pane dropdown, Exit), per-pane transcript tails.
  - Active-pane indicator (cyan ring) + composer-focus fade (`data-composer-focused`).
  - Lifting the single composer to a shared pinned slot below the content area.
  - Keyboard: `⌘1–9` activate tab/pane; `Esc` resolution (peek → context menu → exit panes).
  - CSS for tab strip + panes using production DS tokens/conventions.

- **Out**:
  - The enriched sidebar, peek popover, row context menu, status dots/enum, and composer toolbar (all already shipped).
  - The project-cockpit surface and its tab system (separate, untouched).
  - Sparklines / activity histograms, fleet event ticker, sticky/PiP peek, bulk row actions, saved views (deferred per SPEC §10).
  - Per-pane composers (explicitly removed in favor of the single shared composer).
  - Any change to how agents execute, merge, or run.

## Boundary Candidates

- **`openTabs` state model + persistence + reconcile** (pure logic + localStorage hook).
- **Tab strip presentation** (tab strip + tab + add-picker).
- **Panes layout** (layout-mode plumbing + grid + pane + panes toolbar + transcript tails).
- **Composer lift + focus wiring** (relocate the shared composer, `data-composer-focused`).
- **Keyboard wiring** (`⌘1–9`, `Esc` resolution) integrated with existing handlers.

## Out of Boundary

- The cockpit's `openTabIds`/`reconcile-open-tabs`/`use-cockpit-view-state` — not reused, not modified.
- The conversation status schema and the sidebar/peek/context-menu (consumed read-only; not changed).
- Server/persistence layers (this is client UI over existing state).

## Upstream / Downstream

- **Upstream**: `unified-conversations-panel` (status enum + active-conversations data), `project-level-conversations` / `/conversations` routing rework (`?c=` selection, `ConversationWorkspace`), `active-conversations/schemas.ts`, `useConversationMessagesQuery`, `LayoutMode` + `LayoutSwitcher` + `SessionContent`, the prompt composer stack.
- **Downstream**: future multi-conversation features (fleet ticker, bulk actions, sticky peek) would build on the shared `openTabs` set and the panes grid.

## Existing Spec Touchpoints

- **Extends**: none (net-new boundary).
- **Adjacent (avoid overlap)**: `unified-conversations-panel` (sidebar Session/Active switcher + status enum — read-only consumer here); `project-conversation-cockpit` (separate cockpit tab surface — do not touch); `project-level-conversations` (the `/conversations` page this builds on).

## Constraints

- TypeScript strict; no `any`/unsafe casts; Zod-derived types where schemas apply.
- Red-green TDD: pure functions first (`gridShape`, the `openTabs` reducer add/close/evict/reconcile, field mapping, truncate), then localStorage round-trip, then integration. No `vi.mock` of internal modules — use DI.
- Follow `PERFORMANCE.md`: up to 6 concurrent `useConversationMessagesQuery` + SSE in panes mode → focused selectors, capped tail length, queries unmount when leaving panes mode; validate with react-scan.
- DS conformance per `.claude/skills/cc-design-system` — production tokens only; `[data-status]` status-dot convention; Anybody/Manrope/Geist Mono; do not copy prototype CSS.
- Composer lift must not visually regress the existing default/split/diff/conversation layouts → live + visual verification on every layout.
- Design bundle (`./command-center-multi-tasking-ui-improvements/project/`) is the source of truth for look/feel/UX **only**, not implementation. Where SPEC.md and the handoff HTML conflict (e.g. "panes replaces Split" vs "panes is a 5th layout"), the handoff HTML + prototype win: keep Split, add Panes.
