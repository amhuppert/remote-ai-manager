# UI Primitive Migration Contract

The shared API/pattern contract that every downstream primitive-migration agent
follows. It is the single source of truth for **which primitive owns which APG
pattern, which Radix part it wraps, the `src/components/ui/` API shape it exposes,
the files it owns, the consumers it migrates, and how it is verified.**

> **Mandatory workflow.** Every primitive implementation listed here MUST run the
> **`ui-primitive` skill** (`.agents/skills/ui-primitive/SKILL.md`) for its
> component **before editing any code** — design-first (Phase 0 confirms the APG
> pattern + API), then Radix wrap, stories, unit class-contract tests, and a real
> keyboard + injected-`axe` live pass in Storybook (obtain the URL via
> `ensure_dev_server`, never assume port 6006). This contract does **not** replace
> that workflow; it scopes it.

## Authoring rules that bind every entry (do not restate per-row)

These come from the source-of-truth hierarchy (Session Agent Instructions →
`ui-primitive` skill → `cc-design-system` skill → `docs/tailwind-conventions.md` →
existing `src/components/ui/`). They apply to **all** primitives below:

- **Behaviour from Radix, appearance from the wrapper.** Use the unified
  `radix-ui` package (`^1.6.0`, already installed): `import { X as RadixX } from "radix-ui"`.
  Do not add per-primitive `@radix-ui/react-*` packages.
- **Parts omit `className`/`style`.** Type as
  `Omit<React.ComponentProps<typeof RadixX>, "className" | "style"> & { layoutClassName?: string }`.
  `layoutClassName` is the only escape hatch — layout-only (margin / grid-flex
  placement / order / self-align / width-basis / responsive `hidden`), appended
  **last** via `cn()`, never appearance.
- **State via Radix `data-*` → Tailwind `data-*` variants** (`data-state`,
  `data-highlighted`, `data-disabled`, `data-side`, `data-orientation`). Static
  class maps only; never interpolate or concat a literal with a variable.
- **Tokens, not literals.** Semantic token utilities (`bg-bg-elevated`,
  `text-text-primary`); token-backed arbitrary utilities (`bg-[var(--cc-…)]`,
  `shadow-[…var(--…)…]`) for parity colours with no scale entry. **Reuse tokens;
  minting a new token is an escalation, not an in-primitive decision.**
- **Canonical cyan focus ring.** Interactive triggers get
  `focus-visible:[outline:2px_solid_var(--color-cyan)]` at `outline-offset:2px`
  (inset offset inside overlays); menu/listbox/menu-item rows use the
  `data-highlighted` roving-focus background, **not** an outline; inputs/textareas
  keep the cyan border + glow. Never `outline:none` without a replacement.
- **Overlays:** bake Radix `Portal` into the floating-content wrapper; set the
  z-index token (`z-menu`/`z-dropdown`/`z-popover`), `sideOffset`,
  `collisionPadding`; wire `onOpenChange` into **`useOverlayScope(open)`**
  (`@/hooks/useOverlayScope`) so CC's page-hotkey suppression keeps working;
  support controlled + uncontrolled. Default **`modal={false}`** for
  menus/popovers/tooltips (avoids the `aria-hidden-focus` axe failure); reserve
  `modal` for true blocking dialogs.
- **Motion** gated with `motion-safe:` (no global reduced-motion reset to lean on).
- **Allowlists:** `src/components/ui/**` is already in all four guardrail
  allowlists — a new primitive needs **no allowlist edits** (confirm with `lint`).
  New `*.stories.tsx` files on other surfaces may need the
  `UTILITY_FIRST_PATHS`/eslint/prettier registration; see each entry.
- **Ship the primitive first.** For a brand-new primitive, do **not** migrate
  call sites in the same pass unless explicitly asked — land the primitive +
  stories + tests for review, then migrate consumers as follow-up slices.

## Status legend

- **NEW** — primitive does not exist; build it Radix-backed.
- **REWRITE** — a presentational (non-Radix) primitive exists in
  `src/components/ui/`; re-back it with Radix without changing its visual contract.
- **EXISTS** — already Radix-backed; this contract only adds/maintains consumers.
- **CONSUMER-MIGRATION** — primitive exists; the work is swapping bespoke
  consumers onto it.

---

## 1. Dialog

| | |
|---|---|
| **APG pattern** | [Dialog (Modal)](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) |
| **Radix primitive** | `Dialog` |
| **Status** | REWRITE (CC has non-Radix `ModalShell`) |

`src/components/ui/ModalShell.tsx` is today a pure presentational overlay+card — it
has **no focus trap, no Escape handling, no `aria-modal`/labelledby wiring, no
inert background**; each consumer hand-rolls those (see ConfirmDialog's manual
`keydown` listener). Re-back the shell with Radix `Dialog` so behaviour is correct,
preserving the exact visual contract (overlay scrim + `fadeIn 0.15s`, card
`slideUp 0.2s`, `max-w-[480px]`/`confirm` 400px, mobile bottom-sheet for
CreateSessionModal).

- **Proposed API (composable styled parts):** `Dialog` (Root, wires
  `useOverlayScope`), `DialogTrigger` (structural re-export, `asChild`),
  `DialogContent` (wraps Overlay+Content+Portal; owns scrim/card appearance;
  `size?: "default" | "confirm"`; bakes Portal), `DialogTitle`/`DialogDescription`
  (wrap Radix parts for the aria labelling), `DialogClose` (structural re-export),
  plus a `DialogActions` layout part (the existing `ModalActions` recipe).
  Keep `ModalTitle`/`ModalActions` names or alias them — decide in Phase 0.
- **Owned files:** `src/components/ui/ModalShell.tsx` → `Dialog.tsx` (rename TBD in
  Phase 0; if renamed, update importers in the same slice — no barrel shim),
  `Dialog.stories.tsx`, `Dialog.test.tsx`.
- **Migration consumers:** `src/components/HotkeyHelpModal.tsx`,
  `src/components/mcp/McpServersModal.tsx`,
  `src/features/session/conversation/GraphWorkflowCard.tsx`,
  `src/features/project-detail/components/CreateSessionModal.tsx` (carries the
  legacy `.modal*` mobile bottom-sheet — the retained-recipe gap noted in
  `docs/tailwind-conventions.md §5.1`; the mobile-sheet variant must land on
  `DialogContent` so the `.modal*` recipe can finally be retired).
- **Verification:** focus moves into the dialog on open and **returns to the
  trigger** on close; Escape + overlay-click close; Tab is trapped; `aria-modal`,
  `aria-labelledby`/`describedby` resolve; mobile bottom-sheet renders at 390×844;
  axe clean on `bg-bg-surface`. Before/after parity screenshots at 1440×900 and
  390×844.
- **Non-goals:** do not redesign modal layout or copy; do not change the scrim/
  blur tokens; do not add a non-blocking variant here (that is Popover).

## 2. AlertDialog

| | |
|---|---|
| **APG pattern** | [Alert Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/) |
| **Radix primitive** | `AlertDialog` |
| **Status** | NEW |

`src/components/ConfirmDialog.tsx` is a hand-rolled confirm/acknowledge overlay
with a manual capture-phase `keydown` listener (Escape→cancel, Enter→confirm) and
its own `useOverlayScope`. Replace with Radix `AlertDialog` (role `alertdialog`,
focus trap, default-focused action, Escape). Visual contract: 400px card, scrim +
blur, `fadeIn`/`slideUp`, danger vs primary confirm `Button`, optional
acknowledge-only mode (`hideCancel`).

- **Proposed API:** `AlertDialog` (Root + overlay-scope), `AlertDialogContent`,
  `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`,
  `AlertDialogCancel`. Provide a thin `ConfirmDialog`-shaped convenience wrapper
  (`open`/`title`/`message`/`onConfirm`/`onCancel`/`danger`/`hideCancel`) over the
  parts so existing call sites migrate with minimal churn — confirm in Phase 0.
- **Owned files:** `src/components/ui/AlertDialog.tsx`, `AlertDialog.stories.tsx`,
  `AlertDialog.test.tsx`. (`src/components/ConfirmDialog.tsx` is replaced by the
  convenience wrapper; delete its bespoke keydown logic.)
- **Migration consumers:** every `ConfirmDialog` importer (grep
  `ConfirmDialog`) — includes destructive confirms across session/project flows.
- **Verification:** Enter triggers the **default** action, Escape the cancel/close;
  focus starts on the safest action for destructive prompts (do not auto-focus a
  destructive confirm — confirm the design-system stance in Phase 0); axe clean;
  parity screenshots.
- **Non-goals:** do not fold non-destructive informational modals into AlertDialog
  (those are Dialog); do not change confirm copy.

## 3. Popover

| | |
|---|---|
| **APG pattern** | Non-modal floating panel (compose Dialog/Disclosure semantics — APG has no standalone "popover"); index: [patterns](https://www.w3.org/WAI/ARIA/apg/patterns/) |
| **Radix primitive** | `Popover` |
| **Status** | NEW |

Several bespoke floating panels exist. `src/features/session/sidebar/PeekPopover.tsx`
uses **`@floating-ui/react`** directly and renders preserved `.ProseMirror`/
`.peek-backdrop` CSS (`PeekPopover.css`); `InfoDetailsPopover` and
`SessionsFilterPopover` are bespoke disclosure panels. Provide a Radix `Popover`
primitive (collision-aware positioning, focus management, outside-click) for the
generic cases.

- **Proposed API:** `Popover` (Root + overlay-scope), `PopoverTrigger`
  (`asChild`), `PopoverContent` (bakes Portal, `z-popover`, `sideOffset`,
  `collisionPadding`, `modal={false}` default), `PopoverClose`, optional
  `PopoverArrow`.
- **Owned files:** `src/components/ui/Popover.tsx`, `Popover.stories.tsx`,
  `Popover.test.tsx`.
- **Migration consumers:** `src/features/session/conversation/InfoDetailsPopover.tsx`,
  `src/features/project-detail/cockpit/SessionsFilterPopover.tsx`, and other
  bespoke disclosure popovers found via the Collapsible/`aria-expanded` sweep.
- **Documented exception — PeekPopover:** `PeekPopover` keeps `@floating-ui/react`
  **for now**. It hosts a Tiptap `.ProseMirror` editor and a preserved backdrop/
  keyframe set (`PeekPopover.css`, in the §5 preserved catalog) and has bespoke
  reference-tracking/peek positioning that Radix `Popover` does not cover cleanly.
  Migrating it is **out of scope** for the generic Popover primitive; record it as
  deferred, do not force-fit it. Re-evaluate only if a later slice owns that
  surface.
- **Verification:** opens on trigger, closes on outside-click/Escape, focus
  returns to trigger; `modal={false}` (no `aria-hidden-focus`); collision flip at
  viewport edges; axe clean; parity screenshots.
- **Non-goals:** do not migrate PeekPopover; do not turn Popover into a Dialog
  (no scrim, non-blocking).

## 4. Tooltip

| | |
|---|---|
| **APG pattern** | [Tooltip](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/) |
| **Radix primitive** | `Tooltip` (+ `Tooltip.Provider`) |
| **Status** | NEW (replaces a bespoke global system) |

CC has a **global singleton** `src/components/TooltipProvider.tsx`: a document-level
`mouseenter`/`mouseleave`/touch listener that reads `data-tooltip` off any element
and renders one portalled `.tooltip-portal` (preserved positioning CSS in
`globals.css`). Radix `Tooltip` is **per-trigger** (`Tooltip.Provider` once near
the root, then `Tooltip.Root`/`Trigger`/`Content` per control) — a different
model. This is the highest-churn candidate (~92 `title=` + many `data-tooltip`
consumers), so **scope is deliberately narrow.**

- **Proposed API:** `TooltipProvider` (re-export of Radix `Tooltip.Provider` with
  CC `delayDuration`), `Tooltip` (Root), `TooltipTrigger` (`asChild`),
  `TooltipContent` (bakes Portal, `z`-tier, `sideOffset`, `collisionPadding`; owns
  the `.tooltip-portal` appearance as utilities). Keep keyboard-focus reveal +
  touch long-press parity.
- **Owned files:** `src/components/ui/Tooltip.tsx`, `Tooltip.stories.tsx`,
  `Tooltip.test.tsx`. The existing `src/components/TooltipProvider.tsx` + the
  `.tooltip-portal` preserved CSS stay until consumers are converted; do not delete
  the global provider in the primitive PR.
- **Migration consumers (scoped):** **only** the controls a primitive-migration
  slice already touches. Do **not** sweep all 92 `title=`/`data-tooltip` sites in
  this workflow — that is an explicit **non-goal** (Workflow Charter "Non-goals").
  Representative in-scope consumers when their surface is migrated: `IconButton`
  triggers, `CopyableId`, `CopyMessageButton`, `MessageActions`, `TddToggle`,
  `DebugModeToggle`, `LayoutSwitcher`.
- **Verification:** appears on hover **and keyboard focus**, dismisses on
  Escape/blur, does not trap focus, `role="tooltip"` + `aria-describedby` wiring,
  touch long-press parity, `modal={false}`; axe clean; the bespoke
  `.tooltip-portal` global remains for unconverted sites (report it, don't absorb).
- **Non-goals:** **do not migrate every `data-tooltip`/`title=` consumer** —
  per-surface only. Do not delete `TooltipProvider`/`.tooltip-portal` until the
  last consumer is converted (a separate, later effort).

## 5. Switch

| | |
|---|---|
| **APG pattern** | [Switch](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) |
| **Radix primitive** | `Switch` |
| **Status** | NEW |

`TddToggle` (`aria-pressed` button with a track+knob), `BackendToggle`, and
`DebugModeToggle` are on/off controls hand-rolled as buttons. A Radix `Switch`
provides `role="switch"` + `aria-checked` + keyboard semantics. The CC visual
contract is the track+knob slider already in `TddToggle` (16/22px track, sliding
knob, green-on glow), plus a label.

- **Proposed API:** `Switch` (Root + Thumb wrapped; owns track/knob appearance;
  `checked`/`onCheckedChange`, `disabled`); optionally a labelled convenience that
  pairs `Switch` with a mono label. A `compact` variant reproduces TddToggle's
  small inline form.
- **Owned files:** `src/components/ui/Switch.tsx`, `Switch.stories.tsx`,
  `Switch.test.tsx`.
- **Migration consumers:** `src/components/TddToggle.tsx`,
  `src/components/BackendToggle.tsx`,
  `src/features/session/debug/DebugModeToggle.tsx`, and other binary on/off
  toggles surfaced in the switch sweep. **Caveat:** confirm each is genuinely
  binary on/off — some "toggle" components are actually two-option **segmented**
  controls and belong in §7, not here.
- **Verification:** Space toggles, `role="switch"`/`aria-checked` correct, label
  association, focus ring, `motion-safe` knob slide, green-on glow parity; axe
  clean; parity screenshots.
- **Non-goals:** do not absorb segmented/either-or pickers (§7); do not change the
  track/knob dimensions or the green-on token.

## 6. Checkbox

| | |
|---|---|
| **APG pattern** | [Checkbox](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/) |
| **Radix primitive** | `Checkbox` |
| **Status** | NEW (CC's `.cc-checkbox` recipe was already deleted) |

`src/features/project-detail/components/CCCheckbox.tsx` and
`ParameterDeclarationEditor` use native `<input type="checkbox">`/bespoke markup.
Provide a Radix `Checkbox` with the CC check-indicator appearance (cyan check on
the elevated surface), supporting `checked`/`indeterminate`/`disabled`.

- **Proposed API:** `Checkbox` (Root + Indicator wrapped, `CheckIcon`),
  `checked` (incl. `"indeterminate"`), `onCheckedChange`, `disabled`; optional
  labelled convenience.
- **Owned files:** `src/components/ui/Checkbox.tsx`, `Checkbox.stories.tsx`,
  `Checkbox.test.tsx`.
- **Migration consumers:** `src/features/project-detail/components/CCCheckbox.tsx`,
  `src/features/workflows-builder/components/ParameterDeclarationEditor.tsx`, and
  other `type="checkbox"` consumers.
- **Verification:** Space toggles, `aria-checked` incl. `mixed` for
  indeterminate, label association, focus ring; axe clean; parity.
- **Non-goals:** do not handle single-select (that is RadioGroup §7) or
  menu-checkbox-items (those stay in DropdownMenu).

## 7. RadioGroup & segmented / exclusive-choice controls

| | |
|---|---|
| **APG pattern** | [Radio Group](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) |
| **Radix primitive** | `RadioGroup` (Radix `Toggle Group` is an acceptable styled variant for button-segmented presentation — confirm in Phase 0) |
| **Status** | NEW |

This row deliberately covers **two presentations of one semantic** (pick exactly
one of N), and the contract draws the line explicitly:

- **RadioGroup** — classic radio list (one selected value, arrow-key roving).
  Consumers: `CollabConfigRow`, `ConversationSidebarFilters`,
  `BranchSelector` (radio-style sections), `InspectorFieldEditors`,
  `MobilePromptToolbar`.
- **Segmented / exclusive-choice** — a row of buttons where exactly one is active
  (the legacy `.btn-toggle` pattern, now deleted). Consumers:
  `AgentCapabilityPanel`, `McpCapabilityPanelContainer`,
  `McpServerCard`, `CreateSessionModal` mode pickers, `TemplateLibrary` tier
  picker. These are **single-select**, so they are `RadioGroup`/`Toggle Group`
  (`type="single"`), **not** a Switch and **not** Tabs.

- **Proposed API:** `RadioGroup` (Root), `RadioGroupItem` (wraps Indicator). For
  the button-segmented look, either style `RadioGroupItem` as a segment or expose
  a `SegmentedControl`/`ToggleGroup` (Radix `ToggleGroup type="single"`) — pick
  one in Phase 0 and document which consumers use which. Do **not** ship two
  parallel exclusive-choice primitives without a clear split.
- **Owned files:** `src/components/ui/RadioGroup.tsx` (+ stories/test); if a
  segmented variant is separate, `SegmentedControl.tsx` (+ stories/test).
- **Verification:** arrow keys move selection within the group (roving tabindex),
  `role="radiogroup"`/`radio` + `aria-checked`, single-selection invariant, focus
  ring; axe clean; parity.
- **The Tabs distinction (required):** a **segmented/exclusive-choice control
  selects a value** (a filter, a mode, a backend). **True Tabs select which of
  several panels is visible** (`role="tablist"`/`tab`/`tabpanel`, with
  `aria-controls`). Do not migrate value-pickers to Tabs, and do not migrate
  panel-switchers to RadioGroup. See §10.
- **Non-goals:** do not collapse RadioGroup and Tabs into one primitive; do not
  convert multi-select rows here (Checkbox §6).

## 8. Collapsible (Disclosure)

| | |
|---|---|
| **APG pattern** | [Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) |
| **Radix primitive** | `Collapsible` |
| **Status** | NEW |

Many show/hide-one-region controls are hand-rolled with `aria-expanded` +
conditional render: `CollabCollapsibleCard`, `DevServersButton`,
`SessionActionsMenu`, `InspectorConfigBlock`, `CommandConsole`,
agent-capabilities config blocks. Provide a Radix `Collapsible` (one trigger, one
region, `data-state` open/closed for the chevron + `motion-safe` height/opacity).

- **Proposed API:** `Collapsible` (Root, `open`/`onOpenChange`,
  `defaultOpen`), `CollapsibleTrigger` (`asChild`), `CollapsibleContent`.
- **Owned files:** `src/components/ui/Collapsible.tsx`, `Collapsible.stories.tsx`,
  `Collapsible.test.tsx`.
- **Migration consumers:** the single-region disclosure consumers above (the
  multi-section ones go to Accordion §9).
- **Verification:** Enter/Space toggles, `aria-expanded`/`aria-controls`,
  `data-state` drives the chevron, `motion-safe` reveal; axe clean; parity.
- **Non-goals:** do not use Collapsible for stacked multi-section UIs (Accordion
  §9); do not use it as a Popover (it is in-flow, not floating).

## 9. Accordion

| | |
|---|---|
| **APG pattern** | [Accordion](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/) |
| **Radix primitive** | `Accordion` |
| **Status** | NEW |

`src/features/session/conversation/SpecBrowser.tsx` is the clearest stacked-
expandable-sections surface. Provide a Radix `Accordion` (`type="single"` or
`"multiple"`, header buttons, roving focus, `data-state`).

- **Proposed API:** `Accordion` (Root, `type`, `collapsible`),
  `AccordionItem`, `AccordionTrigger` (header button), `AccordionContent`.
- **Owned files:** `src/components/ui/Accordion.tsx`, `Accordion.stories.tsx`,
  `Accordion.test.tsx`.
- **Migration consumers:** `src/features/session/conversation/SpecBrowser.tsx` and
  any other multi-section expandable lists surfaced during migration.
- **Verification:** Up/Down move between headers, Home/End jump, `aria-expanded`
  + `aria-controls` + `region` wiring, single vs multiple semantics, `motion-safe`
  reveal; axe clean; parity.
- **Non-goals:** do not use Accordion for a single region (Collapsible §8).

## 10. Tabs (true tablist) — Radix-backed

| | |
|---|---|
| **APG pattern** | [Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) |
| **Radix primitive** | `Tabs` |
| **Status** | REWRITE (CC's `Tabs.tsx` is a presentational `<button>` recipe) |

`src/components/ui/Tabs.tsx` is **not** Radix-backed — it is a styled
`<div>`/`<button>` recipe with no roving focus, no `tabpanel` wiring, no
arrow-key navigation. `ConversationTabs` hand-rolls `role="tablist"`/`tab` and its
own keyboard handling. Re-back a true-Tabs primitive with Radix `Tabs` so
panel-switching tab sets get correct roving focus + `aria-controls`/`tabpanel`,
**without changing the visual recipe** (the `cc-tabs`/`cc-tab`/`TabCount` look,
cyan active treatment).

- **The split this row enforces:** keep the presentational `Tabs`/`Tab`/`TabCount`
  recipe available for the cases that are visually tabs but not panel-switchers, OR
  fully re-back. Decide in Phase 0 which existing `Tabs` consumers are **true
  panel-switching tablists** (→ Radix `Tabs`) vs **exclusive-choice value pickers
  mislabelled as tabs** (→ RadioGroup/segmented §7). Document the disposition per
  consumer; do not blindly Radix-wrap a value-picker.
- **Proposed API:** `Tabs` (Root, `value`/`onValueChange`), `TabsList`,
  `TabsTrigger`, `TabsContent` — wrapping Radix and preserving the
  `cc-tab` appearance + `TabCount`. Keep `layoutClassName`/`fill` parity from the
  current recipe.
- **Owned files:** `src/components/ui/Tabs.tsx` (+ stories/test). The legacy
  `.cc-tab*` recipe in `globals.css` stays (MobileBottomBar descendant overrides —
  `docs/tailwind-conventions.md §5.1`) until that consumer is re-homed.
- **Migration consumers:** `src/features/project-detail/cockpit/ConversationTabs.tsx`
  (true tablist) and other genuine panel-switchers; `.cc-tab` recipe consumers as
  the §5.1 backlog allows.
- **Verification:** Arrow keys move between tabs (manual vs automatic activation —
  confirm CC's choice), Home/End, `aria-controls`/`tabpanel`/`aria-selected`,
  focus ring, cyan active parity; axe clean; parity screenshots.
- **Non-goals:** do not migrate value-pickers (filters/modes) to Tabs — they are
  §7. Do not change the active-tab cyan treatment or the strip geometry.

## 11. Progress

| | |
|---|---|
| **APG pattern** | No interactive APG pattern — `role="progressbar"` ([ARIA `progressbar` role](https://www.w3.org/WAI/ARIA/apg/patterns/), `aria-valuenow`/`min`/`max`) |
| **Radix primitive** | `Progress` |
| **Status** | NEW |

`src/components/AskQuestionPanel.tsx` renders a bespoke progress bar. Provide a
Radix `Progress` (`role="progressbar"`, `data-state`/`data-value`, indeterminate
support) with the CC fill appearance.

- **Proposed API:** `Progress` (Root + Indicator wrapped; `value`, `max`;
  indeterminate when `value == null`).
- **Owned files:** `src/components/ui/Progress.tsx`, `Progress.stories.tsx`,
  `Progress.test.tsx`.
- **Migration consumers:** `src/components/AskQuestionPanel.tsx` and other
  determinate/indeterminate bars surfaced during migration.
- **Verification:** `aria-valuenow`/`valuemin`/`valuemax` correct, indeterminate
  state has no false `valuenow`, `motion-safe` fill; axe clean; parity.
- **Non-goals:** do not build a spinner here; do not make it interactive (that is a
  Slider, out of scope).

## 12. Select — existing consumers

| | |
|---|---|
| **APG pattern** | [Combobox (select-only)](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) / [Listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) |
| **Radix primitive** | `Select` |
| **Status** | EXISTS — CONSUMER-MIGRATION |

`src/components/ui/Select.tsx` is **already Radix-backed and complete** (trigger,
content, item with check indicator + description, label, separator, scroll
buttons, overlay-scope wiring, `asChild` trigger for the rainbow effort variant).
No primitive rebuild — the work is migrating bespoke single-value pickers onto it.

- **Owned files:** none new (the primitive exists). Each consumer slice owns its
  own swap + parity evidence.
- **Migration consumers:** bespoke `<select>`/custom listbox pickers, e.g.
  `BranchSelector` (the select-style branch list), model/reasoning selectors not
  yet on the primitive, and other single-value dropdowns surfaced in migration.
  Each consumer slice runs the `ui-primitive` skill only if it needs a **new
  Select feature**; a pure swap onto the existing API does not rebuild the
  primitive.
- **Verification:** type-ahead, arrow/Home/End/Escape, value selection,
  `role="combobox"`/`listbox`/`option`, focus ring, parity per consumer.
- **Non-goals:** do not migrate type-to-filter comboboxes to Select (§13); do not
  fork a second select primitive.

## 13. Combobox / Autocomplete — documented ambiguity (no unapproved dependency)

| | |
|---|---|
| **APG pattern** | [Combobox (editable, type-to-filter)](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) |
| **Radix primitive** | **None — Radix has no Combobox primitive** |
| **Status** | UNRESOLVED — escalate, do not adopt a dependency |

Type-to-filter-then-pick surfaces exist: `ConversationAutocompleteList`
(mention/slash autocomplete), parts of `BranchSelector`'s filterable list, and
similar. The `ui-primitive` skill's pattern map is explicit: **there is no native
Radix Combobox**; the options are a community library or building on a `Command`-
style primitive — **both are escalations.**

This contract **does not authorize** adding any new dependency (e.g.
`cmdk`, `downshift`, `react-aria` combobox, Ariakit) for this. Per the Workflow
Charter Non-goals ("Do not add backward-compatibility shims without explicit
approval from Alex") and the engineering principle that new dependencies are
decisions, not defaults:

- **Required action for any combobox work:** STOP and escalate to Alex (via
  `AskUserQuestion` / `request_collaboration`) with the options —
  (a) keep the bespoke `@floating-ui`-based autocomplete as-is (no primitive),
  (b) adopt an approved community combobox library,
  (c) build a CC `Command`/combobox primitive from `@floating-ui` + the listbox
  ARIA pattern. **Do not pick one unilaterally.**
- **Owned files:** none until a direction is approved.
- **Migration consumers:** `src/components/ConversationAutocompleteList.tsx`,
  `BranchSelector` filter — **left as-is** pending the decision.
- **Non-goals:** **do not install any new combobox/autocomplete dependency**, do
  not retrofit `Select` into an editable combobox (different ARIA pattern), do not
  silently keep building bespoke autocompletes as if a primitive existed.

---

## Cross-cutting verification requirements (every primitive)

Per the `ui-primitive` skill, each implementation must show, before review:

1. **Gates green:** `bun run typecheck`, `bun run lint`, colocated
   `*.test.tsx` (class contract + new logic, no `vi.mock` of internal modules).
2. **Stories:** `*.stories.tsx` (`@storybook/nextjs-vite`, `fn` from
   `storybook/test`, `parameters.a11y.test = "error"`) covering every state/variant
   + a `StaticOpen`/`defaultOpen` story for floating surfaces.
3. **Live pass:** drive the running Storybook (URL from
   `ensure_dev_server({ name: "storybook" })`) with Playwright — real keyboard
   walkthrough, `:focus-visible` introspection, and an **injected `axe`** run;
   triage each hit (yours vs pre-existing/global vs iframe artifact).
4. **Parity:** before/after screenshots at **1440×900** and **390×844** for any
   surface with an existing appearance, committed under
   `docs/reports/visual/<slice>/`.
5. **APG link in the header comment** naming the pattern + what Radix owns vs the
   wrapper.

## Global non-goals (Workflow Charter)

- Do **not** redesign CC's visual language or introduce a new palette.
- Do **not** migrate every `data-tooltip`/`title=` consumer app-wide — only those
  a primitive-migration slice touches (§4).
- Do **not** add backward-compatibility shims without explicit approval from Alex.
- Do **not** add an unapproved combobox/autocomplete dependency (§13).
- Do **not** start downstream primitive work automatically — each runs its own
  `ui-primitive` skill pass, design-first.

## Source-of-truth conflicts noted

None encountered while authoring this report. Where this contract's acceptance
criteria could conflict with a higher-ranked source during implementation (e.g. a
proposed API name vs the `ui-primitive` skill's composable-parts default, or a
parity colour vs the token-minting rule), the higher-ranked source prevails and
the implementer must record the conflict (criterion, prevailing source,
resolution) in its `complete_task` summary rather than silently diverging.
