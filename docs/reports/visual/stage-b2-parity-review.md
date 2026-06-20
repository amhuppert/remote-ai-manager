# Stage B-2 Tailwind migration — parity review artifact

**Purpose:** single review surface for the Stage B-2 migrations — the confined
feature waves (session-tabs, merge-conflicts dialog, session-diff, projects-index,
hotkey-help) and the shared components migrated out of globals.css
(mcp/**, notifications, approval-gate, topbar, model/effort selectors group:
tdd-toggle, branch-selector, card-context-menu, context-fill). This is the human
visual sign-off gate: the workflow pauses here until a reviewer confirms **zero
visual change**. Chromatic is deferred → parity is human-judged.

All before/after captures use the conventions-doc fixed viewports
(`docs/tailwind-conventions.md` §4.3):

- **Desktop:** 1440 × 900
- **Mobile:** 390 × 844

`before-*` = legacy CSS rendering; `after-*` = migrated build (Tailwind utilities
+ shared `src/components/ui` primitives + any wave-local utilities). **IDENTICAL**
= byte-for-byte equal PNGs (strongest possible parity proof). **DIFFERS** = not
byte-equal; a byte delta is not necessarily a visual regression (sub-pixel
anti-aliasing, PNG-encoding noise, or dynamic on-screen content — relative
timestamps, session names — all produce byte deltas at pixel parity). Each DIFFERS
pair below is annotated with why.

---

## Byte-parity summary (this context re-verified all pairs via `cmp`)

| Surface / component | Dir | Pairs | IDENTICAL | DIFFERS (reason) |
|---|---|---|---|---|
| session-tabs | `src/features/session/tabs/visual-parity/` | 2 | 2 | — |
| merge-conflicts dialog | `merge-conflicts-dialog/` | 4 | 0 | 4 — composite page captures with dynamic file lists / relative dates |
| session-diff | `session-diff/` | 2 | 2 | — |
| projects-index | `projects-index/` | 2 | 2 | — |
| hotkey-help | `hotkey-help/` | 2 | 2 | — |
| mcp/** | `mcp/` | 14 | 14 | — |
| notifications-panel | `notifications-panel/` | 10 | 10 | — |
| approval-gate-panel | `approval-gate-panel/` | 10 | 10 | — |
| topbar | `topbar/` | 8 | 7 | 1 — `detail-mobile` breadcrumb carries the live session name |
| tdd-toggle | `tdd-toggle/` | 16 | 15 | 1 — `session-infostrip--claude-session` composite (dynamic session row) |
| branch-selector | `branch-selector/` | 10 | 10 | — |
| card-context-menu | `card-context-menu/` | 6 | 6 | — |
| context-fill | `context-fill/` | 18 | 17 | 1 — `session-infostrip--high-context-usage` composite (dynamic infostrip) |
| **Total** | | **104** | **97** | **7 (all dynamic-content composites)** |

Every isolated component/story pair is byte-IDENTICAL. The 7 DIFFERS are all
full-surface composites whose content (session names, relative timestamps, file
lists) is non-deterministic: merge-conflicts-dialog ×4, topbar ×1, tdd-toggle ×1,
context-fill ×1. Spot-check confirms pixel parity of the chrome.

---

## Value-identical token extraction performed in THIS context

Six already-migrated shared components kept inline parity literals (their waves
deferred token extraction to this single serialization point). This context
extracted them to `--cc-*` tokens and swapped the literals to `var(--…)`. Each
token value is **character-for-character identical** to the literal it replaced,
so the generated CSS resolves to the same computed value — the wave-captured
`after-*` screenshots above remain accurate (a Tailwind `[var(--x)]` arbitrary
value and a `[<literal>]` arbitrary value emit the same property when `--x`
equals the literal; same layer, same specificity → no cascade change).

| Component | Literal (before) | Token (after) — value in `tokens.css` |
|---|---|---|
| NotificationsPanel | `rgba(99,179,237,0.04)` / `#63b3ed` / `rgba(99,179,237,0.08)` / `rgba(0,0,0,0.4)` | `--cc-accent-blue-bg-subtle` / `--cc-accent-blue` (#63b3ed) / `--cc-accent-blue-bg-hover` / `--cc-notifications-backdrop` |
| TddToggle | `rgba(0,230,118,{0.25,0.4,0.06})` / `0 0 6px rgba(0,230,118,0.5)` | `--cc-tdd-border` / `-border-hover` / `-bg-hover` / `--cc-tdd-knob-glow` |
| CardContextMenu | `0 8px 24px rgba(0,0,0,0.35),0 2px 8px rgba(0,0,0,0.2)` | `--cc-shadow-card-dropdown` |
| Topbar | `rgba(11,16,25,0.85)` / `rgba(255,179,0,0.2)` | `--cc-topbar-bg` / `--cc-topbar-needs-hover-bg` |
| McpConfigPopover | `0 12px 32px rgba(0,0,0,0.5)` / `#ffb000` / `rgba(255,175,0,0.25)` / `rgba(255,175,0,0.08)` | `--cc-shadow-popover` / `--cc-accent-amber` / `--cc-amber-border-subtle` / `--cc-amber-bg-subtle` |
| McpServersModal | `rgba(6,9,15,0.8)` | reused existing `--cc-overlay-scrim` |

Topbar's one residual dynamic className `unified-panel-toggle${panelOpen?' active':''}`
was converted to `cn("unified-panel-toggle", panelOpen && "active")` — identical
classes emitted.

---

## Per-owner CSS status (current / floor from `css:progress`)

GENUINELY PRESERVED (declared non-zero floor in `OWNER_FLOORS`, per
`css-inventory.md`) — retained by design, NOT migration debt:
- **globals.css** — 851 / **66**. The shared **leaf recipes** (`cc-tab*`,
  `cc-badge*`, `btn-*`, `empty-*`, `form-*`) still consumed by un-migrated
  surfaces + preserved keyframes referenced via `animate-[]`. Retired only at the
  end-state cleanup gate. **No leaf recipe was deleted.**
- **dialogs.css** — 4 / **3**. The `.cr-*` conflict-resolution rules.
- **keyboard-shortcuts-modal.css** — 4 / **2**. Portal residual.
- **topbar.css** — 10 / **10** (floor corrected 0 → 10). `.topbar-status-*` /
  `.topbar-sep` and `.topbar`/`.topbar-brand`/`.topbar-logo`/`.topbar-divider`/
  `.topbar-breadcrumb` are SHARED descendant anchors styling externally-injected
  content (TddToggle, session.css, ConversationList, SessionInfoStrip) and are
  hand-rolled by the B-3 `MobileSessionView`. Topbar's OWN styling (incl. the
  formerly-globals.css `.unified-panel-toggle*`) is fully migrated; the residual
  preserved until those B-3 consumers migrate (see `stage-b2-topbar-followups.md`).

NOW AT FLOOR 0 (fully migrated this retry):
- **projects-index.css → 0**, **approval-gate.css → 0**, **session-diff.css → 0**.

STILL > 0 (floor 0 target; shared anchors consumed by B-3 surfaces — preserved
until those consumers migrate, recorded in `stage-b2-deferred-followups.md`):
- **conversation-tabs.css** — 12 / 0. `.add-conversation-menu*` (anchored by the
  deferred conversation-panes surface; see `session-tabs-deferred-menu.md`).

---

## Retry: seven components fully migrated, with real before/after screenshots

All seven were migrated to the shared `src/components/ui` PRIMITIVES (not direct
consumption of legacy global leaf recipes) and registered. Parity is evidenced by
REAL before/after captures at the conventions breakpoints, animations frozen for
deterministic capture — `_b2-retry/` (Storybook) + `_b2-retry-app/` (dev app):

| Component | Migration (→ primitives) | Screenshot evidence (frozen) |
|---|---|---|
| **ConfirmDialog** | modal chrome hand-rolled (desktop `.modal` + ≤768px sheet); actions → `<Button variant=danger/primary/default size=sm>`; ref→autoFocus | desktop **byte-IDENTICAL**; mobile sub-pixel AA (visually identical) |
| **ModelSelector** | fully utility; upward shadow → `--cc-shadow-dropdown-up`; private `.model-selector*` deleted from globals.css; 4 test files → `data-testid` | **byte-IDENTICAL** desktop+mobile |
| **Topbar** | `.unified-panel-toggle*` → utilities, deleted from globals.css | **byte-IDENTICAL** desktop+mobile |
| **ApprovalGatePanel** | root + `::before` amber edge → `before:` utilities; approval-gate.css → 0 | **byte-IDENTICAL** desktop+mobile |
| **ReasoningLevelSelector** | fully utility incl. rainbow border (3-layer gradient + text-clip); effort-selector* deleted from globals.css; tests → `data-testid` | plain trigger sub-pixel AA; rainbow trigger frozen-gradient phase — both visually identical (verified) |
| **ProjectsIndexPage** | `<Tabs>`/`<Tab>`/`<TabCount>`, `<EmptyState*>`, `<StatusDot>`, `<SectionHeader*>`; archived toggle = utility button (Button+layoutClassName hits the appearance guardrail); projects-index.css → 0 | **byte-IDENTICAL** desktop+mobile |
| **SessionDiffViewer** | `<Tabs>`/`<Tab>`/`<TabCount>`, `<Button variant=ghost>`, `<EmptyState*>` (+ commit/diff utilities, 9 minted tints); session.css/conversation.css left for the sidebar DiffPanel; session-diff.css → 0 | **byte-IDENTICAL** desktop+mobile |

globals.css: 900 → **851** (model-selector, unified-panel-toggle, effort-selector
regions removed); approval-gate.css / projects-index.css / session-diff.css → 0.
**Frozen-capture parity: Storybook 10/16 byte-identical + 6 sub-pixel-AA (visually
identical); dev-app (ProjectsIndexPage, SessionDiffViewer) 4/4 byte-identical.** No
layout/appearance regression in any pair.

## Still deferred to Stage B-3 (charter non-goals — not regressions)

- Dense surfaces (conversation/session/sidebar/prompt/conversation-panes) + the
  workflow graph/builder. The session.css/conversation.css diff rules stay (still
  used by the sidebar DiffPanel).
- **topbar.css (floor corrected 0 → 10, now PRESERVED):** every class
  (`.topbar*`/`.topbar-status-*`/`.topbar-sep`) is consumed by the B-3
  `MobileSessionView` (verified MobileSessionView.stories) + injected session
  controls (SessionInfoStrip/ConversationList/TddToggle) via descendant anchors.
  Desktop Topbar.tsx itself is utility-first. Migrates with MobileSessionView (B-3).
  The earlier "fully migratable" inventory note was an error (omitted that consumer)
  — corrected in css-inventory.md + OWNER_FLOORS.
- conversation-tabs' `.add-conversation-menu*` (anchored by deferred panes).
- Cleanup gate (delete shared leaf recipes, drop aliases, Preflight).

---

## Gate verification snapshot (this context, after the retry migrations)

`bun run build` ✓ · `bun run build-storybook` ✓ · `bun run lint` 0 errors
(93 pre-existing unused-var warnings in unrelated lib/workflows tests) ·
`bun run typecheck` ✓ · targeted + cross-feature tests green (incl. the retest of
ConfigPage/PromptComposer/PromptDesktopToolbar/ConversationWorkspace/ReasoningLevelSelector
after the data-testid repointing) · `bun run css:progress --check` ✓ (globals.css
851) · `tailwind-utility-collisions` ✓ · shared leaf recipes intact · no mixed
ownership on any registered element.

**→ Awaiting human parity sign-off.**
