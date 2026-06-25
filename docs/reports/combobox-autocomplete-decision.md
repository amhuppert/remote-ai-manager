# Combobox / Autocomplete — Decision Report

Resolves the "combobox/autocomplete is unresolved" gap recorded in
[`docs/reports/ui-primitive-migration-contract.md` §13](./ui-primitive-migration-contract.md)
and in `.cc/graph-workflow-docs/primitive-migration-contract-pointer.md`.

**Bottom line.** CC's type-to-filter autocompletes are, architecturally, already
WAI-ARIA **editable comboboxes with list autocomplete** — a focused text host
plus a filtered popup, with keyboard navigation forwarded to the popup. **Radix
UI has no Combobox primitive**, and `Select` (select-only) is the wrong APG
pattern, so the *behaviour* cannot be Radix-backed the way the other primitives
are. There **is** a safe, no-new-dependency path to centralize the *presentation
and the listbox/option ARIA semantics* into `src/components/ui/`, which this
report approves and the companion task implements. Adopting a third-party
combobox library (cmdk / downshift / react-aria / Ariakit) or building a full
managed-focus combobox/`Command` primitive is a **major behavioural decision that
requires Alex's explicit approval** and is **not** taken here.

---

## 1. APG requirements

### 1.1 Combobox (editable, type-to-filter) — the host contract

[APG Combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
(external, read-only — referenced, not fetched).

A combobox is an input paired with a popup. For "list autocomplete with manual
selection / automatic selection" (CC's model), conformance requires, **on the
text input element**:

- `role="combobox"`.
- `aria-expanded` — `true` while the popup is displayed, otherwise `false`.
- `aria-controls` — the `id` of the popup element.
- `aria-autocomplete="list"` (CC filters a list; it does not inline-complete text).
- `aria-activedescendant` — the `id` of the currently highlighted option **while
  one is highlighted**, cleared otherwise. **DOM focus stays in the input**
  ("managed focus"); the popup is not separately tab-focusable. This is the key
  difference from a menu/listbox-with-roving-`tabindex`.

Keyboard (owned by the host): `Down`/`Up` move the active option (and `Down` may
open the popup), `Enter` selects the active option, `Escape` closes (and/or
clears), `Home`/`End` optional. Focus never leaves the input.

### 1.2 Listbox — the popup contract

[APG Listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/).

The popup that lists suggestions requires:

- `role="listbox"` on the scrolling option container, with an accessible name
  (`aria-label` / `aria-labelledby`).
- `role="option"` on every selectable row, each with a **unique, stable `id`**
  (so the input's `aria-activedescendant` can reference it).
- `aria-selected="true"` on the active/highlighted option (single-select
  autocomplete marks the active option as selected); `false`/absent otherwise.

CC additionally renders non-option chrome (header counts, footer key hints,
group labels, loading/empty/error states). Those must **not** carry `option`
semantics — APG requires `listbox` children to be `option`/`group` only, so
chrome lives outside the `role="listbox"` element (or is `role="presentation"` /
`aria-hidden`).

---

## 2. Current autocomplete consumers (audit)

All consumers share one interaction model: a **text host keeps focus**, a
**popup lists filtered items**, and the host **forwards keydown** into the popup
(or owns the index directly). The active row is tracked by a `selectedIndex` /
`activeIndex` integer and rendered visually via `data-active`. Positioning is
either CSS (`absolute inset-x-0 bottom-full`, anchored to the prompt container)
or the Tiptap suggestion plugin's range tracking — **no `@floating-ui` call is
required by these surfaces today** (`@floating-ui/react` is only used by the
unrelated `PeekPopover`).

| Surface | File | Popup ARIA today | Host input ARIA today |
|---|---|---|---|
| Slash/skill commands | `src/components/CommandAutocompleteList.tsx` (+ host `src/features/session/prompt/PromptEditorSlashCommandPopup.tsx`) | **none** — `<div data-active>` rows | Tiptap editor; no `combobox`/`activedescendant` wiring |
| File mentions (prompt) | `src/components/FileAutocompleteList.tsx`, `src/components/FileAutocomplete.tsx` (+ host `PromptEditorFileMentionPopup.tsx`, hook `src/hooks/use-file-autocomplete.ts`) | **none** | Tiptap editor; not wired |
| Conversation mentions | `src/components/ConversationAutocompleteList.tsx` (+ host `PromptEditorConversationMentionPopup.tsx`) | **none** (custom two-line row recipe) | Tiptap editor; not wired |
| Composer command/filter | `src/features/project-detail/composer/ComposerSuggestions.tsx` | `role="listbox"` + `role="option"` + `aria-selected` ✅ (grouped `ul`/`li`) | composer textarea; no `activedescendant` |
| Command console filter bar | `src/features/project-detail/components/CommandConsole.tsx` | suggestion list has **no** `role="listbox"`/`option` ❌ | `<input role="combobox" aria-autocomplete="list" aria-controls aria-expanded>` ✅ (but no `activedescendant`, and the list it controls is not a `listbox`) |

Specs of record: `.kiro/specs/command-autocomplete`, `.kiro/specs/file-autocomplete`.

**Observations.**

1. The three big list components (`Command` / `File` / `Conversation`
   AutocompleteList, plus the duplicated-markup `FileAutocomplete`) expose **zero
   ARIA** — a sighted-only listbox. This is the largest accessibility gap.
2. ARIA that *does* exist is **split across two consumers** that each cover a
   different half: `CommandConsole` wires the input as a combobox but its popup
   isn't a listbox; `ComposerSuggestions` makes the popup a listbox but its input
   isn't wired and there is no `aria-activedescendant` bridge. Neither is fully
   conformant.
3. **Presentation is duplicated.** The popup/header/list/footer/empty/error/
   loading recipe is defined in `CommandAutocompleteList.tsx` and **imported by
   sibling components** (`FileAutocompleteList`, `FileAutocomplete`,
   `ConversationAutocompleteList`) — a `src/components/` cross-component import of
   styling constants, which belongs in `src/components/ui/` per the
   colocation/structure rules.
4. The match-highlight helper (`HighlightedName` / `HighlightedLabel` /
   per-char `FilePath`) is re-implemented in each file.

---

## 3. Why Radix alone does not satisfy this

- **Radix has no Combobox primitive.** The `radix-ui` package ships `Select`,
  `DropdownMenu`, `Popover`, etc., but no editable type-to-filter combobox. The
  `ui-primitive` skill's pattern map says so explicitly ("⚠️ no native Radix
  Combobox — escalate").
- **`Select` is the wrong APG pattern.** Radix `Select` (CC's
  `src/components/ui/Select.tsx`) implements **select-only** combobox/listbox
  semantics: you cannot type free text into it to filter; its trigger is a
  button, not a text input. Retrofitting it into an editable, text-filtered
  combobox would fight the primitive and produce the wrong roles. (Contract §12
  forbids this.)
- **`Popover` only solves anchoring**, not the combobox/listbox roles, the
  `aria-activedescendant` bridge, or filtering — and CC's autocompletes don't
  even need its anchoring today.

What Radix *cannot* give us here is exactly the behavioural core (filter +
managed focus + keyboard). That core already exists, bespoke, in the hosts. So
the migration question is **not** "wrap Radix" but "what can we safely
centralize without a new dependency, and what stays an escalation."

---

## 4. Viable approaches (existing dependencies only)

| # | Approach | New dep? | Verdict |
|---|---|---|---|
| A | **Centralize the presentational shell + listbox/option ARIA** into `src/components/ui/` (`AutocompleteListbox` + `AutocompleteOption` + match-highlight + the recipe constants). Hosts keep filtering/keyboard. | No | **Approved (this report).** Safe, additive, removes duplication, fixes the "zero ARIA" popups, honest about scope. |
| B | Wire each host input as a full combobox: add `role="combobox"`/`aria-expanded`/`aria-controls`/`aria-activedescendant` to the Tiptap editors + composer + finish CommandConsole. | No (uses existing code) | **Partial / deferred.** Per-host behavioural change (esp. `aria-activedescendant` into a Tiptap `contenteditable`). The shared primitive (A) makes this *possible* by exposing stable option `id`s, but each host is its own slice and needs live verification. Not done here; listed as remaining work. |
| C | Adopt a community combobox library (cmdk, downshift, react-aria `useComboBox`, Ariakit). | **Yes** | **Escalation — requires Alex's explicit approval.** Not taken. |
| D | Build a full CC `Command`/combobox primitive with managed focus + keyboard from `@floating-ui` + the listbox ARIA pattern. | No new dep, but **major behavioural redesign** | **Escalation — requires Alex's explicit approval.** Not taken. This is the "build on a `Command`-style primitive" option §13 flags as a decision. |

Approaches **C and D** are exactly the two escalation options the migration
contract §13 reserves for Alex. This report does **not** choose either and adds
**no dependency**.

---

## 5. Approved implementation path (no new dependency)

Implement **Approach A** — a presentational + ARIA primitive in
`src/components/ui/`, explicitly **not** claiming the Radix/managed-focus
behaviour that does not exist:

- **`src/components/ui/Autocomplete.tsx`**
  - Canonical recipe constants (moved here from `CommandAutocompleteList.tsx`, so
    `src/components/ui/` is the single source of truth and sibling components stop
    cross-importing styling).
  - **`AutocompleteListbox`** — the popup shell: floating container, optional
    `header`/`footer` slots (kept *outside* the listbox element), a scroll
    viewport holding the `role="listbox"` region (accessible name +
    `aria-busy` while loading) plus the loading/empty/error status chrome as
    *siblings* of the listbox — never children, so listbox children stay
    `option`-only per APG. Loading/empty announce via `role="status"`, errors via
    `role="alert"`. Includes active-row scroll-into-view. Renders option children.
  - **`AutocompleteOption`** — `role="option"` + `aria-selected={active}` +
    `data-active` + stable `id` + hover/click handlers, with the row recipe
    selected by a static `variant` (`"default"` for command/file rows,
    `"conversation"` for the taller two-line row) — no `className` escape hatch,
    static class maps only.
  - **`AutocompleteMatchText`** — the shared fuzzy match-highlight helper.
- **Honesty constraint (required by the task).** The primitive owns *appearance
  + listbox/option ARIA only*. It does **not** implement filtering, focus
  management, or keyboard navigation, and its header comment says so and links the
  APG Combobox + Listbox patterns. The editable-combobox *behaviour* stays in the
  hosts; nothing claims to be a drop-in Radix combobox.
- **Consumers migrated onto it (same pass):** `CommandAutocompleteList`,
  `FileAutocompleteList`, `FileAutocomplete`, `ConversationAutocompleteList` —
  removing the duplicated shell/markup and the cross-component recipe import, and
  gaining `role="listbox"`/`role="option"`/`aria-selected`. Their existing unit
  tests (which assert `data-active`, text, and the loading/empty/error/count
  slots) are the parity guard and stay green; new primitive tests assert the ARIA
  contract (TDD: written first).
- **Tokens/guardrails:** reuses existing tokens only; `src/components/ui/**` is
  already in all four guardrail allowlists, so no allowlist edits.

### Remaining consumer migration (explicitly out of this slice)

- **Host combobox-input wiring (Approach B)** for the Tiptap prompt editors, the
  composer textarea, and finishing `CommandConsole` (`role="combobox"` +
  `aria-controls` the new listbox + `aria-activedescendant` the active option's
  `id`). The primitive exposes the option `id`s to make this possible, but each
  host is a separate slice that needs live keyboard + screen-reader verification.
- **`ComposerSuggestions`** is already listbox-conformant with a *grouped*
  structure; folding it onto the shared shell (with a group slot) is an optional
  later consolidation, not required.
- **`CommandConsole`** suggestion list → `AutocompleteListbox` is a clean
  follow-up that also completes its already-present combobox input.

### Approval status

- **No new dependency is added.** Adopting a combobox library (C) or building a
  full managed-focus combobox/`Command` primitive (D) **requires Alex's explicit
  approval** per migration contract §13 and the Workflow Charter non-goal "Do not
  add backward-compatibility shims / dependencies without explicit approval." If
  CC later needs true type-ahead with managed `aria-activedescendant` as a
  reusable primitive, that is the moment to escalate C-vs-D — this report
  deliberately leaves that decision open and unblocked-but-unmade.

---

## 6. Consumer-migration outcome (`CommandConsole`, `ComposerSuggestions`)

The consumer-migration context applies §5 to the remaining two surfaces. Per the
acceptance criterion ("…use the shared contract **or have an explicit report
entry explaining why a consumer remains feature-specific**"), both are recorded
here as **feature-specific** and were **not** folded onto the shared
`AutocompleteListbox`/`AutocompleteOption` shell, because:

1. **Different visual family.** The shared shell hardcodes the cyan-accent,
   translucent **prompt popup anchored *above* the input** (`autocompletePopupClass`)
   and a single fixed option recipe with no `className` escape hatch (static class
   maps only, by design). Both console/composer surfaces are **dropdown/popover
   surfaces anchored *below*** (`bg-bg-elevated` + `shadow-popover` /
   `shadow-dropdown`, `rounded-md`), with their own row recipes
   (`bg-cyan-glow` active in the console; `rounded-sm` rows in the composer).
   Reusing the shell would regress their appearance.
2. **Grouped structure.** Both render **grouped** suggestions (`Actions` / `Filter`)
   with `role="group"` headings. The shared shell renders a **flat** list of
   options and has no group slot. Adding console/composer-only variants + a group
   mechanism to the primitive — used by no other consumer — would be speculative
   generality, the opposite of "centralize where safe."

What the migration **did** do (the genuinely-safe, mandatory part — APG/ARIA
conformance, which criterion (b) requires regardless of shell reuse):

- **`CommandConsole`** (`src/features/project-detail/components/CommandConsole.tsx`)
  — its input was already a conformant `role="combobox"` + `aria-autocomplete="list"`
  + `aria-controls` + `aria-expanded`, but the controlled list was **not** a
  listbox (`<button>` rows, no roles, no `aria-activedescendant`). Completed:
  the suggestion container is now `role="listbox"` (labelled), each group is a
  labelled `role="group"`, each row is a `role="option"` (non-focusable `<div>`,
  not `<button>`, so DOM focus stays on the input per managed-focus) with a
  **stable `id`** + `aria-selected`, and the input now wires
  **`aria-activedescendant`** to the active option (cleared when the list is
  closed). Grouped headings, kind badges, keyboard ownership (↑/↓/Enter/Esc on the
  input), hover, and selection callbacks are unchanged.
- **`ComposerSuggestions`** (`src/features/project-detail/composer/ComposerSuggestions.tsx`)
  — already a conformant grouped `role="listbox"` with `role="option"` +
  `aria-selected`; added **stable per-option `id`s** so a future composer host can
  wire `aria-activedescendant` (Approach B, still deferred). It is story-only today
  (the production composer uses `CommandConsole`), so no host wiring was required.

Tests: `CommandConsole.test.tsx` gained a "combobox / listbox ARIA" block and a
new `ComposerSuggestions.test.tsx` pins the listbox/option/`aria-selected`/stable-id
contract (red→green). The shared primitive `src/components/ui/Autocomplete.tsx`
was **not** modified, so the `ui-primitive` skill's build/change-a-primitive
workflow does not apply to this consumer-only slice.

### Live verification (private Storybook, own-worktree port)

`ensure_dev_server({ name: "storybook" })` resolves to the prefix-sibling
worktree (known gotcha), so a private Storybook was run on this worktree's own
port and driven with Playwright + injected axe-core (WCAG 2.0/2.1 A/AA):

- **`Projects/CommandConsole · FocusedWithFilterSuggestions`** — input is a
  `role="combobox"` with `aria-expanded=true`, `aria-controls` → the listbox id,
  `aria-autocomplete="list"`, and `aria-activedescendant` = the active option id.
  The popup is a `role="listbox"` (labelled) whose only direct children are
  `role="group"` (APG-clean); options are non-focusable `role="option"` `<div>`s
  with stable unique ids and `aria-selected`. **Keyboard:** ArrowDown moves
  `aria-selected` + `aria-activedescendant` to the next option and **DOM focus is
  retained on the combobox input** (managed focus). **Pointer:** hovering an
  option makes it the active/selected one and updates `aria-activedescendant`.
- **`Project Cockpit/Composer/Suggestions · FilterSuggestions`** — `role="listbox"`
  (labelled) with options carrying stable unique ids; `activeIndex` maps to the
  single `aria-selected="true"` option.

**axe:** the only violations on either surface are (1) the pre-existing global
empty `.tooltip-portal` (`aria-tooltip-name`) — out-of-scope legacy noise tracked
by the Tooltip verification record, reported not absorbed; and (2) `color-contrast`
on the `text-text-tertiary` group headings / muted right-aligned labels, which are
**byte-identical to `main`** (the existing CC group-label/secondary-text
convention) — pre-existing design-system contrast debt, not introduced by this
ARIA slice, and out of scope (changing it is a visual redesign per the charter
non-goal). No new violations were introduced.

---

## 6.1 Shared-shell consumers — stable option ids (completing §5)

§5 migrated the four shared-shell consumers onto `AutocompleteListbox` /
`AutocompleteOption` but did not yet pass `AutocompleteOption`'s `id` prop, so
their listbox options rendered with **no DOM id** — the active option could not be
targeted by a host's `aria-activedescendant`, leaving the stable-id half of the
acceptance criterion unmet for these four. That gap is now closed.

Each consumer passes a stable, unique, index-based id to every option, matching
the id idiom already used by `CommandConsole` (`command-console-option-${i}`) and
`ComposerSuggestions` (`composer-suggestion-option-${i}`) so a future host can
derive the active id from `selectedIndex`:

| Consumer | File | Option id pattern |
|---|---|---|
| Slash/skill commands | `src/components/CommandAutocompleteList.tsx` | `command-autocomplete-option-${i}` |
| File mentions (list) | `src/components/FileAutocompleteList.tsx` | `file-autocomplete-list-option-${i}` |
| File mentions (self-managed) | `src/components/FileAutocomplete.tsx` | `file-autocomplete-option-${i}` |
| Conversation mentions | `src/components/ConversationAutocompleteList.tsx` | `conversation-autocomplete-option-${i}` |

No shell/recipe changes were needed (centralized upstream); only the `id`
attribute was added (threaded through `ConversationRow` for the conversation
variant). Active-index behaviour, scroll-into-view, grouped headings, footer
hints, fuzzy-match highlighting, archived dim, status dots, and all
hover/selection callbacks are unchanged.

**Tests (red→green):** stable-id tests added to
`CommandAutocompleteList.test.tsx`, `FileAutocompleteList.test.tsx`,
`ConversationAutocompleteList.test.tsx`, and a new `FileAutocomplete.test.tsx`
(this component had no prior test). Each asserts one id per option, every id a
non-empty string, and all ids unique. Verified failing before the id additions
and passing after; the existing parity tests (data-active / count / loading /
empty / error / hover) stay green. `bun run typecheck` and `eslint` on all
changed files are clean.

### Live verification (private Storybook, own-worktree port)

`ensure_dev_server({ name: "storybook" })` again resolved to the prefix-sibling
worktree (the documented gotcha — it served the sibling branch *without* these
id changes), so a private Storybook was run on this worktree's own port (6021)
and driven with Playwright + injected `axe-core` (WCAG 2.0/2.1 A/AA). Existing
stories for all four in-scope consumers were checked:

- **`Components/CommandAutocompleteList · Default`** — `role="listbox"` (label
  "Commands"); its only direct children are 4 `role="option"`s (APG-clean) with
  stable unique ids `command-autocomplete-option-0..3` and `aria-selected="true"`
  on the active index (1), matching `data-active`.
- **`Components/FileAutocompleteList · Default`** — `role="listbox"` (label
  "Files"); 5 option-only children, ids `file-autocomplete-list-option-0..4`,
  `aria-selected` on the active row.
- **`Components/ConversationAutocompleteList · Default`** — `role="listbox"`
  (label "Conversations"); 4 option-only children, ids
  `conversation-autocomplete-option-0..3`, `aria-selected` on the active row
  (two-line conversation variant).
- **`Components/FileAutocomplete · Default`** — `role="listbox"` with 12 option
  rows, ids `file-autocomplete-option-0..11`, `aria-selected` on the active row.
- **`Components/FileAutocomplete · Interactive`** (this component owns its own
  active index + keyboard) — typing `@src` opens a 20-option listbox; **ArrowDown
  / ArrowUp** move `aria-selected` + the active id across options
  (`file-autocomplete-option-0 → 1 → 2 → 1`) while **DOM focus is retained on the
  `<textarea>`** (managed-focus model); **hovering** option index 4 makes it the
  active/selected one. Stable unique ids throughout.

**axe (reported, not absorbed — pre-existing, not introduced by this id-only
change):** (1) the pre-existing global empty `.tooltip-portal`
(`aria-tooltip-name`) on every story — out-of-scope legacy noise tracked by the
Tooltip verification record; (2) `color-contrast` on the
`ConversationAutocompleteList` header group label (`text-text-tertiary`) —
byte-identical to `main`, the existing CC group-label convention (same
pre-existing design-system debt recorded in §6); (3) `scrollable-region-focusable`
on the shared `AutocompleteListbox` scroll viewport (`.overflow-y-auto`), which
fires only when the list is long enough to scroll (the 12-row `FileAutocomplete`
story). This is a property of the **upstream shared shell**, untouched by this
id-only change, and is consistent with the combobox managed-focus model where the
text input — not the popup — owns keyboard scrolling (Arrow keys scroll the active
option into view). No **new** violations were introduced by adding the ids.

---

## 7. Source-of-truth conflict noted

Migration contract §13 (rank 5, "Existing UI Primitives"/report) says the
autocomplete consumers should be **"left as-is pending the decision."** The
execution-context task instructions + acceptance criteria (the workflow directive
for this context) instead authorize a **safe no-new-dependency centralization of
the presentational shell + ARIA**. These are reconciled, not in conflict: §13's
"leave as-is" governs the **dependency / full-combobox-behaviour** decision
(escalation reserved for Alex), which this report honours by adding **no
dependency** and building **no managed-focus behaviour**; the task's authorized
work is the **presentation + listbox/option ARIA** centralization, which §13 did
not address and which the `ui-primitive` skill (rank 2) supports as standard
primitive extraction. Where the two could still be read to conflict, the
higher-ranked sources (Session Agent Instructions → `ui-primitive` skill) prevail
and the resolution is recorded here per the charter's conflict rule.
