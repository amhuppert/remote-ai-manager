# Overlay consumer migration — verification record

Verification for the "Dialog, AlertDialog, Popover, and Tooltip Consumer
Migration" context. Covers the unit suite for every changed consumer and a live
Storybook + injected-`axe` pass (Playwright, this worktree's private Storybook on
`:6031` — the CC-adopted `storybook` server resolves to the prefix-sibling
worktree, so a private instance is required to see these changes). Chromium pinned
to the installed `chromium-1223` build via `executablePath` (the `playwright`
package resolves the absent `chromium-1208`).

## What was migrated (see `.cc/graph-workflow-docs/overlay-consumer-migration-dispositions.md`)

- **ConfirmDialog**, **BulkConfirmModal** → `ui/AlertDialog`
- **HotkeyHelpModal** → `ui/Dialog`
- **SessionsFilterPopover** → `ui/Popover`
- **GraphWorkflowCard** workflow selector → `ui/Select`

Deferred (bespoke box model / interaction not modelled by the shipped primitives'
fixed content recipe; inline reason in each file): McpServersModal,
ConversationAgentCapabilitiesConfig, DiffSlideover, McpConfigPopover,
DevServerDrawer, InfoDetailsPopover. PeekPopover stays the documented §3 exception.

## Unit tests (jsdom) — all green

`bun run test` over the changed consumers and every test that renders them:

- `ConfirmDialog.test.tsx` (11) — alertdialog role + label, Escape→onCancel,
  outside-press no-dismiss (alert-dialog semantics), confirm/cancel mutually
  exclusive, danger/primary classes, hideCancel acknowledge-only.
- `ConfirmDialog.stories.test.tsx` (4), `BulkConfirmModal.test.tsx` (11),
  `HotkeyHelpModal.test.tsx` (4) — role=dialog + label, closed→nothing, Escape→close,
  **and the preserved `id="hotkey-help-modal"` scroll-cap hook + `mobileSheet`
  bottom-sheet utility are pinned** (see remediation note below).
- `SessionsFilterPopover.test.tsx` (5) — closed-until-trigger, **labelled panel
  asserted by accessible name** (`getByRole("dialog", { name: "Session filters" })`),
  toggle-without-closing (multi-select), `aria-pressed` reflects active tokens,
  Escape closes.
- `GraphWorkflowCard.launch.test.tsx` (3) — combobox trigger, option selection,
  one-click vs launch-form paths, 400 rejection (jsdom Radix-Select shims added).
- Consumer regression: `SessionsPanel.test.tsx` (updated bulk-confirm + filter
  queries to the new roles), `project-cockpit-flows.test.tsx`,
  `ConversationWorkspaceView.test.tsx`, `PromptComposer.test.tsx`,
  `DiffSlideover.test.tsx`, `InfoDetailsPopover.test.tsx`,
  `ConversationAgentCapabilitiesConfig.test.tsx`, `tailwind-utility-collisions.test.ts`.

Result: **72 passed (14 files)**. `tsc --noEmit` and `eslint` clean on all changed
files (the layoutClassName guardrail enforced — a stray `max-h-[244px]` was dropped
in favour of the Select primitive's collision-height cap).

## Remediation (attempt 2) — preserved scroll/mobile behaviour + named popover

The first context-validation reopened two acceptance-level issues; both are fixed
and re-verified live below.

1. **HotkeyHelpModal lost the preserved scroll cap + mobile sheet.** The first
   migration rendered a bare `<DialogContent>`, dropping the `#hotkey-help-modal`
   id (the only hook for the preserved `max-height: 80vh; overflow-y: auto` scroll
   cap in `keyboard-shortcuts-modal.css` — `max-height`/`overflow` are not in the
   layoutClassName allowlist) and the ≤768px bottom-sheet docking. Restored via
   `<DialogContent id="hotkey-help-modal" mobileSheet>`: the id reattaches the
   scroll cap, and `mobileSheet` (the Dialog primitive's verified bottom-sheet
   prop) reproduces the legacy `.modal` mobile transform. The now-redundant mobile
   `@media` block in `keyboard-shortcuts-modal.css` — which keyed off
   `#hotkey-help-overlay`, an id the primitive's centring layer cannot carry — was
   removed in favour of `mobileSheet`; only the scroll cap remains in that file.

2. **SessionsFilterPopover rendered an unnamed `role="dialog"`.** Radix
   `PopoverContent` is `role="dialog"` but supplies no accessible name. Added
   `aria-label="Session filters"`; the red test now asserts the name via
   `getByRole("dialog", { name: "Session filters" })`.

## Live Storybook + injected axe (Playwright, 1440×900 unless noted)

### HotkeyHelpModal / Default (Dialog) — desktop + mobile 390×844
- `role="dialog"` named "Keyboard Shortcuts"; **`id="hotkey-help-modal"` present**.
- **Scroll cap live**: computed `max-height: 720px` (= 80vh of the 900px viewport)
  and `overflow-y: auto` — the preserved CSS is applied, confirming the scroll cap
  the first attempt had dropped is restored.
- **Mobile bottom-sheet live (390×844)**: overlay `align-items: flex-end`, card
  `max-width: 100%`, square bottom corners (`border-bottom-left-radius: 0`), and
  the card's bottom edge flush to the viewport (`cardBottomEdge = 0`) — the
  `mobileSheet` docking matches the legacy `.modal` mobile transform.
- axe: one hit — `scrollable-region-focusable` on `#hotkey-help-modal`. **Pre-existing,
  not introduced by this migration**: `main`'s pre-migration `HotkeyHelpModal`
  rendered the identical `id="hotkey-help-modal"` scroll cap over the same
  non-interactive shortcuts list (no focusable descendants), so the scrollable
  region triggers the same rule. It is a direct consequence of the scroll cap the
  validator required be preserved (the broken intermediate state avoided it only by
  dropping the cap — the regression itself). The dialog auto-focuses its content on
  open, so a keyboard user can scroll it; making the region tab-focusable would mean
  reworking the separately-verified Dialog primitive, which a consumer-migration
  context must not do (per `overlay-consumer-migration-dispositions.md`). Reported,
  not absorbed (same disposition as the global `.tooltip-portal`, contract §4).

### ConfirmDialog / Danger (AlertDialog)
- `role="alertdialog"` present and visible.
- **Focus lands on the safe `Cancel`, not the destructive `Delete`** — the
  deliberate behaviour change in migration-contract §2 (the legacy dialog
  autofocused the confirm). Verified via `document.activeElement` = "Cancel".
- Escape fires the cancel path (story keeps `open` controlled, so the static
  story stays mounted — expected).
- **axe: 0 violations.**

### BulkConfirmModal / Delete — mobile 390×844 (bottom-sheet)
- `role="alertdialog"` visible; the mobile bottom-sheet variant renders.
- **axe: 0 violations.**

### SessionsFilterPopover / Default (Popover)
- Filter trigger opens a `role="dialog"` panel **with the accessible name
  "Session filters"** (`aria-label`) — the unnamed-dialog issue is fixed and the
  name is verified live (`role="dialog"`, `aria-label="Session filters"`).
- Option `aria-pressed` flips `false`→`true` on click; **the panel stays open**
  after a toggle (multi-select preserved); Escape closes it.
- axe: hits, all **pre-existing / not introduced by this migration** —
  - `aria-tooltip-name` on the global legacy `.tooltip-portal` (migration-contract
    §4: report, do not absorb; it stays until the last tooltip consumer is converted).
  - `region` on the Storybook root wrapper (`#storybook-root > div > div`) — a
    Storybook-harness landmark artifact, not consumer markup.
  - `color-contrast` on the `Status`/`Target`/`Archived` group labels
    (`text-text-tertiary`) — identical colour + surface to the pre-migration
    `GROUP_LABEL_CLASS`; the documented design-system limitation that muted
    secondary/tertiary CC text fails AA on the lightest `bg-bg-elevated` surface
    (same note as the Popover primitive's own verification). Not regressed by the
    swap; out of scope to recolour here.

### GraphWorkflowLauncher / WithDefinitions (Select)
- `role="combobox"` trigger ("Select a workflow"), 4 `role="option"`s.
- **Keyboard nav works** — ArrowDown + Enter selects an option, the listbox
  closes, and the Run button becomes enabled. (The bespoke listbox had no
  keyboard nav at all — a net APG gain.)
- axe: two hits, both **owned by the shipped Select primitive, not this consumer** —
  - `aria-hidden-focus` on `#storybook-root` — Radix `Select` is modal by default,
    so while the listbox is open it `aria-hidden`s the surrounding card (which
    holds the Run button + links). Focus is managed into the listbox, so this is
    the Radix Select modal pattern (APG-valid); it occurs for **every** Select
    consumer rendered inside richer surrounding content, not just here, and is a
    property of the shipped primitive — out of this consumer-migration scope.
  - `color-contrast` on the option `rev N` descriptions — the Select primitive's
    own `itemDescriptionClass` (tertiary/cyan-dim); same design-system limitation.

## Conclusion

All in-scope migrations behave per the primitives' verified contracts
(AlertDialog focus-on-Cancel + outside-press immunity; Dialog/Popover Escape +
focus management; Popover multi-select; Select keyboard nav). The two
context-validation issues are fixed and re-verified live: **HotkeyHelpModal's
preserved scroll cap (`max-height: 80vh` measured live) and ≤768px bottom-sheet
docking are restored**, and **SessionsFilterPopover's panel now has the accessible
name "Session filters"**. No **new** axe violations are introduced by the consumer
markup — every live hit is pre-existing: the global `.tooltip-portal` (contract §4),
the design-system tertiary-on-elevated contrast case, the Storybook-root landmark
artifact, the Radix Select modal `aria-hidden-focus`, or the `scrollable-region-focusable`
that the preserved (parity-required) scroll cap carries identically on `main`. The
deferred consumers retain their existing behaviour unchanged.

### Follow-up queued

A primitive-context task to add an **additive, parity-safe unstyled /
edge-anchored content variant** to the Dialog and Popover primitives, which would
unblock the deferred bespoke-box consumers (McpServersModal, DiffSlideover,
ConversationAgentCapabilitiesConfig, McpConfigPopover, DevServerDrawer) without
changing their appearance.
