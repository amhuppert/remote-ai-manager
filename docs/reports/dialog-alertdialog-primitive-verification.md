# Dialog & AlertDialog primitive — live verification record

Verification of the new Radix-backed `src/components/ui/Dialog.tsx`
(WAI-ARIA "Dialog (Modal)") and `src/components/ui/AlertDialog.tsx`
(WAI-ARIA "Alert Dialog"), per the UI primitive migration contract §1/§2 and the
`ui-primitive` skill Phase 6. Read this before migrating any modal/confirm
consumer onto these primitives.

## How it was verified

Live, in a **private Storybook started from this worktree** — `ensure_dev_server`
resolved Storybook to the prefix-sibling worktree (`radix-ui-migration-aba982`,
not `…-primitive-migration-contract`), which does not contain these new stories;
the documented prefix-sibling gotcha. A private `npx storybook dev` on a
verified-free port (6044) served this worktree's stories. Driven with Playwright
+ injected `axe-core@4` (`wcag2a/2aa/21a/21aa/22aa`).

## Dialog (`ui-dialog--default`)

- Trigger composes the `Button` primitive (`asChild`); on keyboard focus it shows
  the **canonical cyan `:focus-visible` ring** — computed `outline: rgb(0,229,255)
  solid 2px` (`--color-cyan`), `:focus-visible` matches.
- Enter opens; **focus moves into the dialog** (first focusable = the form input).
- `role="dialog"`, `aria-labelledby` → the `DialogTitle`, `aria-describedby` → the
  `DialogDescription`; accessible name resolves to "Edit session".
- Scrim overlay computes `background: rgba(6,9,15,0.8)` (`--cc-overlay-scrim`) +
  `backdrop-filter: blur(8px)`.
- **Tab is trapped**: input → Cancel → Save → wraps back to input, focus stays
  inside the dialog.
- **Escape closes and returns focus to the trigger** (`:focus-visible` true on the
  returned trigger).
- **axe: 0 violations** with the dialog open.
- Screenshot evidence was removed during repository artifact cleanup.

### Note on `aria-modal`

Radix's `Dialog.Content` does **not** emit `aria-modal="true"`; it enforces
modality by making the rest of the tree inert (`aria-hidden` on siblings via
`react-remove-scroll` + a focus scope). This is an APG-valid way to satisfy the
Dialog (Modal) pattern (the spec allows *either* `aria-modal` *or* an inert
background), it is Radix's deliberate design, and axe reports no violation. The
wrapper does not override it. If a future consumer specifically needs the
`aria-modal` attribute, set it on `DialogContent` via the forwarded rest props.

## AlertDialog (`ui-alertdialog--destructive`)

- `role="alertdialog"`, `aria-labelledby`/`aria-describedby` wired; name resolves
  to "Delete session?".
- **Default focus lands on the safe `Cancel` action, NOT the destructive
  `Delete`** — confirms migration contract §2 ("do not auto-focus a destructive
  confirm"). This is a deliberate divergence from the legacy `ConfirmDialog`/
  `BulkConfirmModal`, which `autoFocus` the confirm button and bind Enter→confirm.
  The legacy Enter→confirm shortcut is intentionally dropped; a consumer wanting
  the primary action focused on a *non-destructive* prompt can pass `autoFocus` to
  `AlertDialogAction`.
- `AlertDialogAction danger` computes the red danger Button — `color:
  rgb(255,61,90)` (`--red`), `border-color: rgba(255,61,90,0.3)`
  (`--cc-red-border`); `Cancel` is the neutral default Button, both with the
  canonical cyan focus ring.
- **Escape closes and returns focus to the trigger** (`:focus-visible` true).
- **axe: 0 violations** with the dialog open.
- Screenshot evidence was removed during repository artifact cleanup.

### Open-focus fallback for no-enabled-Cancel states (verified)

Radix's AlertDialog open-autofocus prevents default and focuses **only** the
registered `Cancel`. With no enabled Cancel — the contract-mandated
acknowledge-only (`hideCancel`) mode, or a disabled Cancel — that focus call is a
no-op and focus would stay outside the modal, breaking the APG focus trap.
`AlertDialogContent` adds an `onOpenAutoFocus` fallback (runs first via
`composeEventHandlers`): it defers to Radix when an enabled Cancel exists,
otherwise lands focus on the first enabled control, falling back to the content
element. Live Storybook + injected-axe results (private Storybook :6045,
chromium-1223):

- `ui-alertdialog--acknowledge-only` (no Cancel): on open **focus lands on the
  `Got it` action inside the dialog**; **Tab trap holds** (focus never leaves the
  alertdialog across repeated Tabs); **Escape closes and returns focus to the
  trigger** (`:focus-visible` true); **axe: 0 violations**.
- `ui-alertdialog--pending` (destructive action disabled, Cancel enabled): on open
  **focus lands on the enabled, safe `Cancel`** inside the dialog; the disabled
  `Deleting…` action is rendered; **Tab trap holds**; **axe: 0 violations**. The
  story keeps Cancel enabled during the in-flight state so a focusable target
  always remains inside the modal.
- `ui-alertdialog--confirm` and `ui-alertdialog--destructive`: on open focus lands
  on the safe `Cancel` (not the action); **axe: 0 violations**.

Colocated jsdom tests pin the same focus contract (`AlertDialog.test.tsx`):
default-focus on Cancel, focus-moves-to-action for acknowledge-only and
disabled-Cancel, and focus-stays-inside for the all-actions-disabled backstop.

## Stories

- `Dialog.stories.tsx`: `Default`, `WithCornerClose`, `MobileSheet`, `StaticOpen`.
- `AlertDialog.stories.tsx`: `Confirm`, `Destructive`, `AcknowledgeOnly`,
  `Pending`, `StaticOpen`. All set `parameters.a11y.test = "error"`.

## Gates

`bun run typecheck` clean · eslint clean on all 7 new files (no allowlist edits —
`src/components/ui/**` is pre-registered) · 20/20 colocated tests pass
(`Dialog.test.tsx` + `AlertDialog.test.tsx`).
