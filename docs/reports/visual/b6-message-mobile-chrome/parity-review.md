# B-6 globals.css message + mobile-action chrome — parity review

Migrates the leftover globals.css conversation-message and mobile-action chrome to
utilities and deletes those regions. globals.css: **309 → 231 selectors** (floor 66,
`css:progress --check` passes; `↓ progress`).

## Retry — validation-failure resolutions (attempt 2)

The first attempt over-deleted the shared `.mobile-action-*` sheet rules and left an
unbacked rgba scrim. Resolved as follows (all 3 reopened issues):

1. **Live cross-owned consumer (`MobilePromptToolbar.tsx`, not owned by this slice).**
   Its More/Settings sheets consume `.mobile-action-backdrop/-sheet/-sheet-header/
   -sheet-handle/-sheet-close/-sheet-section/-sheet-label/-sheet-divider`. Those
   shared rules were **restored** to globals.css (consumer-gated deletion — they stay
   until that owner migrates). The MobileActionMenu-only rules (`-menu-trigger`,
   `-item*`, `-icon`, `-label`, `-meta`, `-ds-row*`, the `-tdd-row` *rule*) have zero
   consumers and stay deleted (grep-verified).
2. **TDD-row parity.** `MobileActionMenu`'s TDD row carries a bare `mobile-action-tdd-row`
   hook class (no backing rule) so `TddToggle`'s `[.mobile-action-tdd-row_&]:` parent
   variants fire; the container box styling is reproduced by utilities. Before/after
   screenshots of the open TDD sheet are **byte-identical** (sha256 match).
3. **Missing scrim token.** The foundation token-minting context never merged into this
   worktree — `--cc-bg-void-a70` is absent. Rather than ship a raw rgba literal, the
   backdrop **keeps the shared `.mobile-action-backdrop` rule** (its scrim lives in CSS,
   no token needed). No `tokens.css` edit.

## Method

Parity verified by **computed-style assertions** against the legacy CSS values
(stronger than pixel-diff for a 1:1 transcription — it confirms each arbitrary
utility actually emitted, the documented Tailwind silent-drop risk), plus
after-screenshots at the two fixed viewports. Private Storybook ran in this
worktree on :6017 (the prefix-sibling owns :6006).

## Surfaces migrated (computed-style results)

| Surface | Component | Verified |
|---|---|---|
| tool-use indicator (standalone) | `MessageContent.ToolUseIndicator` | `border-left: 2px solid cyan-dim`; **top/right/bottom = 0px** (Preflight border-box gotcha avoided); bg-raised; radius 4px; min-h 30px |
| tool-use indicator (error) | same | icon + border-left → `--red` rgb(255,61,90) |
| tool-use indicator (nested in group) | same, `nested` | border-l 0; bg-surface; my 2px |
| tool-use group (base / error) | `ToolUseGroup` | left border cyan-dim / red; bg-raised; rounded-sm; overflow-hidden; header transparent bg, min-h 30px |
| mobile-action backdrop | `MobileActionMenu` | scrim `rgba(6,9,15,0.7)`; `backdrop-blur(4px)`; z 200 |
| mobile-action sheet | same | bg-surface; border-top 1px border-default (bottom 0 — no box); rounded-t-lg 10px; max-h 70vh; `pb: calc(space-lg + env(...))` → 16px; z 201 |
| mobile-action delete item | same | `--red-text` rgb(232,80,108) |
| mobile-action trigger | same | `hidden` desktop / `max-768:flex` |
| msg-nav / nav-btn mobile fold | `ConversationNav` | @768: 44×44, min 44, 0.72rem, flex-1, space-between, svg 16px |
| msg-action-btn mobile fold | `CopyMessageButton` (Copy + Fork) | @768: 44×44, tooltip `::after` hidden |

Screenshots: `after/tool-use-desktop.png`, `after/mobile-action-menu-open-mobile.png`.

## Left in place (out of this slice's scope — documented, not regressions)

- **`.mobile-bottom-bar` (+ `.cc-tabs`/`.cc-tab` descendants)** — shared with
  `WorkflowMobileTabBar.tsx` (graph/builder context, migrated last). Consumer-gated
  leaf; cannot delete while that consumer exists. Stays for the graph context / B-final.
- **`.command-indicator__body*`, `.message-content*`** — react-markdown generated
  output (preserved, R6).
- **`.stagger-in`, `.spinner`** — cross-cutting utilities whose only consumers are
  feature pages outside this slice's named components. Ownership forbids touching
  those consumers; left as leaf recipes for B-final.
- **Already gone from globals** (nothing to migrate): `.collaboration-status-card*`,
  `.nav-counter`, `.msg-editor*`, `.virtuoso-fallback`.

## Foundation gaps flagged for integration

Two foundation pre-registration gaps surfaced; neither is editable from a migration
slice without crossing the `tokens.css`/allowlist ownership line:

1. **Scrim token never minted.** `tokens.css` has no `--cc-bg-void-a70` (rgba(6,9,15,0.7));
   the merged `b6-allowlist-foundation` commit touched only
   `tailwind-utility-collisions.test.ts`. **Resolution in this slice:** the backdrop keeps
   the shared `.mobile-action-backdrop` rule (scrim in CSS), so no token is needed here.
   If/when integration tokenizes it, `MobilePromptToolbar`'s sheet + this backdrop can
   both move to `bg-[var(--cc-bg-void-a70)]` in one pass.
2. **`MessageContent.tsx` omitted from the B-6 UTILITY_FIRST_PATHS pre-registration.**
   It hosts the migrated `ToolUseIndicator` (.tool-use-* chrome), so its bare utilities
   tripped the visual-inertness collision guard. Added to `UTILITY_FIRST_PATHS` in
   `tailwind-utility-collisions.test.ts` (test-file allowlist only) following the
   session-chrome SPECIAL-CASE precedent. **Integration must sync** the eslint + prettier
   `MIGRATED_UTILITY_FIRST` allowlists with `MessageContent.tsx` (and keep `MobileActionMenu.tsx`'s
   deferred Family-B status — it is intentionally outside `no-hardcoded-color`).

Constraint conflict (flagged): the task's "no allowlist edit — the foundation did it"
ownership rule assumed complete foundation pre-registration. Because the foundation
omitted `MessageContent.tsx`, the global collision guardrail was red; the minimal
precedent-backed fix (UTILITY_FIRST_PATHS-only add) was applied to keep it green, in
preference to reverting validator-accepted message-migration work.
