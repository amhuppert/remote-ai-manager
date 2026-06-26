# UI Primitive Migration — Final Summary

Final, whole-migration verification of the Radix-UI primitive program on
`csm/radix-ui-migration-aba982`. Scopes every audited candidate from
[`ui-primitive-migration-contract.md`](./ui-primitive-migration-contract.md) to one
of: **implemented/migrated** or **documented, technically-justified deferral**.

> Verification status (this context): all deterministic gates green — see
> [§4 Gates](#4-deterministic-gates). Each primitive and consumer context was
> additionally live-verified (Storybook + injected `axe`) in its own context; those
> records are linked per row.

## 1. Primitives implemented

All thirteen contract rows are satisfied. Every primitive: links its APG pattern in
a header comment (Radix-owns vs wrapper-owns split), wraps the unified `radix-ui`
package (`^1.6.0` — **no** per-primitive `@radix-ui/react-*` packages, **no** new
combobox dependency), types its parts
`Omit<…, "className" | "style"> & { layoutClassName?: string }` (no appearance
escape hatch), carries the canonical cyan focus ring, uses tokens (not literals)
with `motion-safe:`-gated motion and static `data-*` class maps, and ships
colocated `*.test.tsx` + `*.stories.tsx`.

| # | Primitive | APG pattern | Radix | Status | Verification |
|---|---|---|---|---|---|
| 1 | `Dialog` (+ `dialog-recipe.ts`) | Dialog (Modal) | `Dialog` | NEW Radix primitive — **replaced** the non-Radix `ModalShell`, now **retired/deleted** (see §3.0) | [dialog-alertdialog](./dialog-alertdialog-primitive-verification.md) |
| 2 | `AlertDialog` | Alert Dialog | `AlertDialog` | NEW (replaces hand-rolled `ConfirmDialog` keydown) | [dialog-alertdialog](./dialog-alertdialog-primitive-verification.md) |
| 3 | `Popover` | non-modal floating panel | `Popover` | NEW | [overlay-consumer](./overlay-consumer-verification.md) |
| 4 | `Tooltip` | Tooltip | `Tooltip` | NEW | [tooltip-primitive](./tooltip-primitive-verification.md) |
| 5 | `Switch` | Switch | `Switch` | NEW | [switch-choice](./switch-choice-consumer-verification.md) |
| 6 | `Checkbox` | Checkbox | `Checkbox` | NEW | (unit + stories) |
| 7a | `RadioGroup` | Radio Group | `RadioGroup` | NEW | (unit + stories) |
| 7b | `SegmentedControl` | Radio Group (single-select) | `RadioGroup` (NOT Tabs/ToggleGroup) | NEW | [switch-choice](./switch-choice-consumer-verification.md) |
| 8 | `Collapsible` (+ `disclosure-recipe.ts`) | Disclosure | `Collapsible` | NEW | [disclosure-primitives](./disclosure-primitives-verification.md) |
| 9 | `Accordion` | Accordion | `Accordion` | NEW | [disclosure-primitives](./disclosure-primitives-verification.md) |
| 10 | `Tabs` | Tabs | `Tabs` | REWRITE (was presentational recipe) | [tabs-disclosure](./tabs-disclosure-consumer-verification.md) |
| 11 | `Progress` | `role="progressbar"` | `Progress` | NEW | (live axe via `ContextFillIndicator`) |
| 12 | `Select` | Combobox (select-only) / Listbox | `Select` | EXISTS (consumer-migration only) | (pre-existing) |
| 13 | `Autocomplete` | Combobox (editable) | **none** — presentational | NEW, §13 approved no-dependency path | [combobox decision](./combobox-autocomplete-decision.md) |

Parallel-primitive check (criterion: "no new parallel primitive where an existing
primitive should have been updated"):

- **`Tabs`** — the presentational `Tabs` recipe was rewritten on Radix `Tabs`; the
  legacy `Tabs`/`Tab`/`TabCount` recipe is deliberately retained for
  non-panel-switching segmented uses per contract §10 and carries no
  `tab`/`tablist` ARIA. No fork.
- **`Select`** — reused, not forked.
- **`Dialog` vs `ModalShell` — resolved, no fork remains (§3.0).** Contract §1's
  intent was to re-back `ModalShell` as `Dialog`. `Dialog.tsx` shipped as a new
  Radix primitive (sharing `dialog-recipe.ts` for appearance); its last consumer
  (`CreateSessionModal`) has now been migrated onto it and the non-Radix
  `src/components/ui/ModalShell.tsx` (+ its `ModalTitle`/`ModalActions` exports and
  stories) is **deleted**. No parallel modal primitive exists.

### Sanctioned, in-file-documented divergences

- **Tooltip omits `useOverlayScope`** — a tooltip never traps focus or blocks the
  page, and its trigger keeps focus while shown; suppressing page hotkeys would
  break keyboard use. Rationale in `Tooltip.tsx` header.
- **Overlay triggers delegate the focus ring** via `asChild` to `Button`/
  `IconButton` (which carry the cyan ring), the correct composition pattern.
- **`Tabs`/`Collapsible`/`Accordion` expose an additive `asChild` unstyled escape
  hatch** ([unstyled-trigger-variants](./unstyled-trigger-variants-verification.md))
  that drops the baked recipe but still forwards `layoutClassName` and preserves
  Radix roving focus / ARIA / `data-state` / mount-unmount.
- **Combobox §13** — Radix has no Combobox primitive. Adopting a dependency
  (`cmdk`/`downshift`/`react-aria`/`ariakit`) was escalated and **not** taken;
  the approved Approach A ships `Autocomplete.tsx` as a presentational shell with
  listbox/option ARIA while each host keeps managed focus
  (`role="combobox"`/`aria-activedescendant`). See the decision doc.
- **`Autocomplete`'s `AutocompleteMatchText` accepts `className`/`matchClassName`** —
  the one part in the suite that exposes a className. It composes the *matched-substring
  highlight* (which characters get the cyan run), not the part's own box appearance, and
  defaults to the token-backed `text-cyan`. Permissible under the §13 presentational
  (no-Radix) allowance; every other primitive part omits `className`/`style` entirely.

## 2. Consumers migrated

Migrations preserve accessible names, focus behaviour, keyboard operation, mobile
behaviour, and token-based appearance (verified per context). Representative set:

- **Dialog / AlertDialog / Popover / Tooltip** — `ConfirmDialog`→AlertDialog parts
  (bespoke capture-phase keydown removed; default focus on the **safe** action per
  §2), `HotkeyHelpModal`→Dialog (mobile sheet + scroll cap preserved),
  `GraphWorkflowCard`'s workflow-launch modal→Dialog (replaced `ModalShell` —
  **gains** the focus trap + Escape + focus-return it previously lacked; accessible
  name `"Launch workflow"` preserved; closes guarded while a launch is in flight via
  `onInteractOutside`/`onEscapeKeyDown`), `CreateSessionModal`→Dialog
  (`DialogContent mobileSheet`; retired the last `ModalShell`/legacy-`.modal`
  consumer — see §3.0), `SessionsFilterPopover`→Popover, plus the
  tooltip/overlay consumers in
  [overlay-consumer-verification](./overlay-consumer-verification.md).
- **Switch / Checkbox / RadioGroup / SegmentedControl** — `TddToggle`→Switch,
  `AgentCapabilityPanel` + `McpCapabilityPanelContainer` filters→SegmentedControl
  (radiogroup-backed) with item toggles→Switch, `CCCheckbox`→Checkbox,
  `ParameterDeclarationEditor` checkbox→Checkbox. See
  [switch-choice-consumer-verification](./switch-choice-consumer-verification.md).
- **Tabs / Collapsible / Accordion** — `WorkflowInspectorPanel`/`DiffPanel`/
  `SessionDiffViewer`/`RightPane`→Radix Tabs (`TabsRoot` with
  `[display:contents]` to keep host layout byte-identical), `InspectorConfigBlock`
  + `CollabCollapsibleCard`→Collapsible (controlled; closed body unmounts),
  `SpecBrowser`→Accordion where applicable. See
  [tabs-disclosure dispositions](./tabs-disclosure-consumer-dispositions.md) +
  [verification](./tabs-disclosure-consumer-verification.md).
- **Select (§12)** — consumed by `ModelSelector`, `ReasoningLevelSelector`,
  `WorkflowLaunchForm`, `SpawnCardEditForm`, `GraphWorkflowCard`,
  `ParameterDeclarationEditor`.
- **Autocomplete (§13)** — `CommandAutocompleteList`, `ConversationAutocompleteList`,
  `FileAutocompleteList`, `FileAutocomplete` adopt the listbox-ARIA parts.
- **Progress (§11)** — `ContextFillIndicator` consumes the `Progress` primitive
  (live axe verified); the primitive is **not** orphaned.

## 3. Deferred / out-of-scope consumers (with rationale)

### 3.0 `Dialog` vs `ModalShell` — replacement complete (per-consumer disposition)

`Dialog` shipped as a new Radix primitive; the non-Radix
`src/components/ui/ModalShell.tsx` (+ `ModalShell.stories.tsx` and the
`primitives.test.tsx` block) is now **deleted** — `grep -rn ModalShell src`
returns nothing. Status of every Dialog-scope consumer:

| Consumer | Uses today | Disposition |
|---|---|---|
| `HotkeyHelpModal` | `Dialog` | **Migrated.** |
| `GraphWorkflowCard` launch modal | `Dialog` | **Migrated** (was `<ModalShell>`; gains focus-trap/Escape/focus-return; accessible name preserved). |
| `ConfirmDialog` / `BulkConfirmModal` | `AlertDialog` | **Migrated** (§2). |
| `CreateSessionModal` | `Dialog` (`DialogContent mobileSheet` + `DialogTitle`/`DialogActions`) | **Migrated** (closes the §3.0 gap; `ModalShell` retired). Preserves the bespoke behaviour: custom open-focus on the name/objective field via `onOpenAutoFocus`-prevent-then-focus; **no** dismiss on overlay click via `onInteractOutside`-prevent; Escape closes via Radix DismissableLayer; the legacy `.modal`/`.modal-overlay`/`.modal-title`/`.modal-actions` globals (`globals.css`, desktop + ≤768px sheet) are **deleted** as dead. Because the modal opens from the sessions store (not a `DialogTrigger`), the trigger blurs to `<body>` before Radix's FocusScope captures its restore target, so focus-return is wired explicitly: `onOpenAutoFocus` records `document.activeElement` and `onCloseAutoFocus` restores it. Live-verified (below). |
| `McpServersModal` | bespoke hand-rolled overlay (**does not** use `ModalShell`) | **Deferred** — a 720px sticky-header/scroll-body box the fixed `DialogContent` recipe can't host; blocked on the queued additive unstyled/edge-anchored `DialogContent` variant (§6.1). |

**`CreateSessionModal` verification.** Unit: 32/32 green (`CreateSessionModal.test.tsx`,
including reworked Escape/outside-click assertions — there is no `#modal-overlay`
anymore) + `CreateSessionModal.stories.test.tsx`. Live (Storybook `:6007` +
Next.js `:3001`, injected `axe`): focus lands on the name input on open; Tab is
trapped inside the dialog; an outside click does **not** dismiss; the mobile
bottom-sheet is full-width and docked to the viewport bottom at 390×844; **axe
returns 0 violations** on the dialog. Real app (`/projects/plc-test-lab`): the
dialog exposes the accessible name "New Session" via `aria-labelledby`, Escape
closes it, and focus returns to the "New session" trigger button. Before/after
parity was verified at 1440×900 and 390×844; the screenshot artifacts were removed
during repository artifact cleanup.

No parallel modal primitive remains.

Every other deferral rests on the workflow's governing constraint, repeatedly verified
across the consumer contexts: **the closed-appearance primitives (parts omit
`className`; fixed sizes/tones; no per-item accent or Switch label slot) can host a
consumer only without a redesign or semantic loss.** Where a criterion names a
consumer that cannot be migrated without an appearance/semantic change, the
higher-ranked sources prevail — Session Agent Instructions / Workflow Charter
non-goals ("do not redesign CC's visual language or introduce a new palette") and
the `ui-primitive` skill's parity requirement outrank the contract's per-consumer
acceptance criterion. The conflict is recorded, not force-fit.

### 3.1 Recorded source-of-truth conflicts (criterion vs prevailing source)

| Consumer | Contract | Conflict | Prevailing source | Resolution |
|---|---|---|---|---|
| `AskQuestionPanel` progress bar | §11 | The bar is an **agent-accent linear-gradient** (`bg-[linear-gradient(90deg,var(--aq-accent-dim),var(--aq-accent))]` + accent glow); the `Progress` primitive's fixed static tone map cannot reproduce it without an appearance change or an additive agent-gradient tone. | Charter non-goal (no redesign) + ui-primitive parity | **Deferred.** Migrating would either redesign the bar or require reworking the separately-verified `Progress` primitive from this context (no-mixed-ownership). Progress is already live via `ContextFillIndicator`. Follow-up: additive agent-gradient `Progress` tone. |
| MCP tool toggles, `DebugModeToggle`, `BackendToggle`, `MobilePromptToolbar` backend | §5 / §7 | Need a `Switch` `xs` size + amber tone, or per-item agent-identity violet accent, that the closed primitives don't expose. | ui-primitive parity + no-palette-change | **Deferred** with queued additive follow-ups (Switch `xs`+amber; SegmentedControl per-item accent). See [switch-choice dispositions](./switch-choice-consumer-verification.md). |
| `CollapsibleText` | §8 | It truncates text; it is **not** a disclosure (no show/hide of a region). | ui-primitive APG correctness | **Deferred** — out of pattern scope (truncation ≠ Disclosure). |

### 3.2 Deferred on bespoke-appearance / structural grounds (no conflict — simply out of reach of a closed-appearance primitive)

- **Overlays (bespoke boxes):** `McpServersModal`, `ConversationAgentCapabilitiesConfig`,
  `DiffSlideover`, `McpConfigPopover`, `DevServerDrawer`, `InfoDetailsPopover`, and
  **`DevServersButton`** (§8 listed it as Collapsible, but it is a floating
  trigger+panel — a Popover shape with a bespoke panel appearance). All blocked on
  the queued additive **unstyled/edge-anchored `DialogContent`/`PopoverContent`
  variant**. See [overlay dispositions](./overlay-consumer-verification.md).
- **Value-pickers mislabelled as tabs (§7/§10):** `ProjectCockpit` mobile-pane
  switch, `AgentCapabilitiesConfigurator`, `ConfigPage` nav, `MachineDetail`
  mode-switch, `SpecBrowser` segment/file tabs — single-select value-pickers that
  belong to the segmented primitive, deferred where the segmented look can't be
  reproduced or where the surface is presentational.
- **`BranchSelector` (§7):** already hand-rolls correct `role="radiogroup"`/`radio`
  + `aria-checked` in a bespoke selectable-card layout; the `RadioGroup` primitive
  parts omit `className` and cannot reproduce the card appearance → deferred on
  parity. (Keyboard arrow-roving is a pre-existing follow-up.)
- **`TemplateLibrary` (§7 "tier picker"):** is in fact a selectable template-**card
  list** (`<button aria-pressed>` per item with tier badges), not a 2–3-option
  segment; deferred on the same bespoke-card parity grounds.
- **Native `<select>` left in place (§12):** `ParameterDeclarationEditor` enum-default
  select and `AgentCapabilityPanel` sr-only select (empty-value / accessibility
  selects the Radix `Select` value model doesn't fit), plus story/test fixtures
  (`InspectorConfigBlock.stories.tsx`, `SpawnCardEditForm.test.tsx`) — out of scope.
- **`PeekPopover` (§3 documented exception):** keeps `@floating-ui/react` — hosts a
  Tiptap `.ProseMirror` editor with bespoke reference-tracking that Radix `Popover`
  does not cover; explicitly out of scope.
- **`CommitHistory`:** timeline rail + lazy diff, not a tab/disclosure shape.
- **Tooltip / `title=` sweep:** per-surface only; the app-wide
  `data-tooltip`/`title=` sweep and deletion of the global `TooltipProvider` /
  `.tooltip-portal` are an explicit **non-goal** and remain for a later effort.

## 4. Deterministic gates

Run in this context against `merge-base(main, HEAD)`:

| Gate | Scope | Result |
|---|---|---|
| `tsc --noEmit` | full project | **0 errors** |
| `eslint --quiet` | changed `.ts/.tsx/.js/.mjs` (validator scope) | **0 errors** |
| `prettier --check` | changed `.ts/.tsx/.mjs` (126 files) | **clean** |
| `vitest run --project unit src/components/ui` | 17 files | **201/201 pass** (`ModalShell` block removed with the primitive) |
| `vitest run --changed <merge-base>` | validator scope | **pass (exit 0)** |
| Dependency audit | `package.json` | only `radix-ui ^1.6.0`; **no** combobox lib; `@floating-ui` pre-existing |

The context script validator runs the project's `preMergeCommand`
(`scripts/pre-merge-validate.sh`) — prettier + eslint + full `tsc` + `vitest
--changed`; the runs above mirror it.

> Pre-existing `prettier --check` warnings exist in ~27 files **outside this
> branch's changeset** (`src/lib/workflows/collaboration/*`, `workflow-graph/*`);
> the validator only formats changed files, so they do not affect this merge.

## 5. axe findings (whole migration)

Across all live Storybook + injected-`axe` passes, every reported violation was
triaged as **pre-existing / out-of-scope**, not introduced by this migration:

- The legacy global empty `.tooltip-portal` element (contract §4 — reported, not
  absorbed; it stays until the last `data-tooltip` consumer is converted).
- A pre-existing design-system tertiary-on-elevated/raised contrast delta on a few
  deferred surfaces.
- Radix `Select`'s modal `aria-hidden`-focus pattern (Radix-internal, APG-valid).
- A pre-existing nameless disclosure chevron (flagged for the Collapsible follow-up).

No axe violation originates in the migrated primitive wiring.

## 6. Deferred follow-ups (carried forward, out of this migration's scope)

1. (§6.1) Additive **unstyled / edge-anchored `DialogContent` / `PopoverContent`**
   variant to unblock the bespoke-box overlay consumers (`McpServersModal`,
   `DiffSlideover`, `McpConfigPopover`, `DevServerDrawer`, `InfoDetailsPopover`,
   `DevServersButton`).
2. **`Switch` `xs` size + amber tone**, and **`SegmentedControl` per-item agent
   accent**, to unblock the MCP tool toggles, `DebugModeToggle`, `BackendToggle`,
   and `MobilePromptToolbar` backend.
3. Additive **agent-gradient `Progress` tone** for `AskQuestionPanel` (§11).
4. Per-host **combobox-input wiring** (`role="combobox"` + `aria-activedescendant`)
   for the remaining Autocomplete hosts.
5. The app-wide **`data-tooltip`/`title=` sweep** and retirement of the global
   `TooltipProvider` + `.tooltip-portal` (explicit non-goal here).
6. `BranchSelector` keyboard arrow-roving; `RadioGroup`/segmented migration of the
   deferred value-pickers once an unstyled segmented variant lands.

> **Documentation note.** The `.cc/graph-workflow-docs/*` pointer documents and the
> `progress-and-select-migration-notes.md` shared document were registered as
> workflow shared documents but were not materialized as files in this worktree
> (only `.cc/graph-workflow-docs/charter.md` is on disk). Their decisions —
> notably the §11 `AskQuestionPanel` deferral and the §12 empty-value/sr-only
> `<select>` exclusions — are consolidated here so they survive on disk
> independently of the workflow registration.
