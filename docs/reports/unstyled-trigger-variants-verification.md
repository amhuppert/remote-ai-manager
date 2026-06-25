# Unstyled / `asChild` trigger variants — primitive verification

Verification record for the additive **`asChild` (unstyled) escape hatch** added to
the `Tabs`, `Collapsible`, and `Accordion` primitives in `src/components/ui/`. This
unblocks the consumer migrations that the Tabs/Disclosure consumer-migration
context deferred because the shipped styled parts baked a fixed appearance with no
`className` escape hatch (see
`docs/reports/tabs-disclosure-consumer-dispositions.md`, follow-ups #1 and #4).

## What was added (additive only — existing styled behaviour/appearance unchanged)

The decision (Phase 0): **`asChild` pass-through (Radix Slot)** — the task's
preferred option. When a part is given `asChild`, the wrapper:

- omits its baked recipe (`tabsTriggerClass` / `tabsListClass` /
  `disclosureTriggerBase` / `accordionRoot` / `accordionItem` /
  `disclosureContentMotion`) so it cannot pollute the consumer's element, and
- omits the injected chevron (which would also break Slot's single-child rule),
- still forwards the layout-only `layoutClassName` escape hatch (merged onto the
  child by Slot).

Radix continues to own all behaviour on the consumer's own element: roving focus,
`aria-selected`/`aria-controls`/`aria-expanded`, `data-state`/`data-orientation`,
single-vs-multiple semantics, and panel/region mount-unmount.

| Part | `asChild` added | Unblocks |
|---|---|---|
| `TabsList` | ✅ | bespoke tab strips / vertical nav containers (AgentCapabilitiesConfigurator, ConfigPage) |
| `TabsTrigger` | ✅ | underline / vertical-nav tab buttons |
| `CollapsibleTrigger` | ✅ | header rows hosting a sibling control (McpServerCard) |
| `CollapsibleContent` | ✅ | bespoke regions without the fade recipe |
| `Accordion` (root) | ✅ | flat / timeline-rail containers (SpecBrowser groups, CommitHistory) |
| `AccordionItem` | ✅ | timeline-rail rows |
| `AccordionTrigger` | ✅ | CSS-grid headers (CommitHistory) |
| `AccordionContent` | ✅ | bespoke panels |

`TabsRoot` already forwarded `orientation` to Radix — confirmed, not changed.
`TabsContent` / `Collapsible`/`Accordion` roots carry no appearance beyond a focus
ring, so they need no `asChild` and got none (YAGNI).

## Gates

- `bun run typecheck` — clean.
- `bun run lint` on all changed primitives + stories + tests — 0 errors. (The
  `no-appearance-in-layout-classname` guardrail correctly rejected `gap-4`/`pt-4`
  in a story's `layoutClassName`; fixed to margin / the consumer's own element.)
- Unit suite — 36 tests across the 3 primitive suites green; the new `asChild`
  blocks were written **red first** (chevron broke Slot's single-child rule + the
  baked recipe polluted the child) then green.

## Live verification (private Storybook :6055, prefix-sibling gotcha)

`ensure_dev_server` resolved to the **prefix-sibling** worktree
(`radix-ui-migration-aba982`, not `…-disclosure-primitives`), so a private
Storybook was run from this worktree on :6055. Playwright + injected
axe-core 4 (`wcag2a/2aa/21a/21aa/22aa`):

- **`UI/Tabs › VerticalNav`** — `asChild` adopted the consumer's `<nav>` as the
  `role=tablist`; `data-orientation=vertical` on tablist + triggers; ArrowDown =
  automatic activation (panel swapped); canonical cyan focus ring
  `2px solid rgb(0,229,255)` on the consumer's button; only the active panel
  visible (inactive `hidden`/`display:none`, children unmounted).
- **`UI/Tabs › GroupedUnderlineTabs`** — 4 `role=tab` + 2 non-interactive group
  label spans; ArrowRight roving focus **skips the labels** (Files→Search→Claude);
  cyan underline active accent + focus ring.
- **`UI/Accordion › BespokeGridHeader`** — trigger `display:grid` (2 columns), no
  injected chevron; `asChild` content adopted the consumer's `<div>` as
  `role=region` with `aria-controls` wired; lazy-diff placeholder text present.
- **`UI/Accordion › FlatGroupList`** — root/item/trigger/content all `asChild`;
  **no baked card border** present; single-open. **Live-axe caught a real defect:**
  with the `<ul>` itself as the `AccordionContent asChild` element, Radix put
  `role="region"` on the `<ul>`, which **overrides its implicit `list` role and
  orphans its `<li>` children** (axe `listitem`, serious). Fixed by nesting the
  `<ul>` inside a generic `<div>` content element (the `<div>` takes `role=region`;
  the `<ul>` keeps its list role) — re-ran axe clean. The story comment now records
  this as the canonical guidance for any list-bearing `asChild` content (it is why
  the CommitHistory + SpecBrowser migrations wrap their lists in a `<div>`).
- **`UI/Collapsible › HeaderWithSiblingControl`** — the `role=switch` is a
  **sibling** of the trigger (`trigger.contains(switch) === false`), not nested
  inside the trigger `<button>` (which would be invalid ARIA); trigger uses the
  consumer's own ▸ indicator, no injected chevron.

Every story's axe run returned **only** the pre-existing global `.tooltip-portal`
`aria-tooltip-name` violation (migration-contract §4 — report, don't absorb; it is
not part of these primitives and stays until the Tooltip consumers convert). No
violations originate in the new `asChild` wiring.

## Consumer migrations — MIGRATED in this follow-up

The escape hatch unblocked four deferred consumers, and they were **migrated and
verified in this same context** (the per-consumer disposition rows in
`docs/reports/tabs-disclosure-consumer-dispositions.md` are flipped to MIGRATED).
Gates over the whole set: `bun run typecheck` clean; `eslint .` holds at the
documented **40-error** pre-existing baseline (zero added); the guardrail
RuleTester is **54 green**; **66 unit tests** pass across the 3 primitive suites +
the 4 migrated consumers' suites (CommitHistory / SpecBrowser / AgentCapabilities /
ConfigPage), each migration written **red-first** (no roving focus / no
`aria-expanded` pre-migration → green after).

| Consumer | Primitive | A11y change | Live verification (private Storybook :6061, axe-core 4) |
|---|---|---|---|
| **AgentCapabilitiesConfigurator** | Tabs `asChild` grouped underline | gains roving focus / automatic activation | 6 `role=tab`; ArrowRight = focus+selection→"Skills" skipping group-label spans, `:focus-visible` cyan ring, active `role=tabpanel` swaps. Before/after parity screenshots **byte-identical** (1440×900 + 390×844). |
| **ConfigPage** settings nav | Tabs `asChild` + `orientation="vertical"` | gains Up/Down roving focus | `data-orientation=vertical`; ArrowDown→"Agent defaults" with `aria-selected` + inset cyan `box-shadow` active accent preserved; 1 visible panel. Parity screenshots **byte-identical**. |
| **CommitHistory** | Accordion `asChild` grid header | **fixes pre-existing gap** (clickable `<div>`, no aria/keyboard) | 4 commit triggers; Enter toggles `aria-expanded` false→true, region mounts via `aria-controls`, single-open (opening 2nd closes 1st). Timeline rail re-keyed `has-[[data-expanded=true]]`→`has-[[data-state=open]]`. **Lazy `useCommitDiffQuery` preserved** (`isExpanded = expandedHash === commit.fullHash`). |
| **SpecBrowser feature groups** | Accordion `asChild` flat list | **fixes pre-existing gap** (same) | feature-group headers are `<button aria-expanded>` with `▸` chevron; Enter toggles to expanded; single-open. File list wrapped in a `<div>` content (not `<ul>`) per the listitem fix above. Segment + file tabs left presentational (untouched). |

Every consumer story's axe run returned only pre-existing / out-of-scope hits — the
global `.tooltip-portal` (§4), and design-system tertiary-text / `.bg-bg-raised`
badge `color-contrast` inside **section/panel content** (DefaultsSection,
capability panels), not in the migrated tab/disclosure wiring. No violation
originates in the new Radix wiring.

## Still deferred (dependency cited — NOT force-fit)

**Absent primitive (escalation):** the §7 segmented / exclusive-choice primitive
(`SegmentedControl`/`RadioGroup`) and `Switch` live in the sibling
`radix-choice-primitives` context and are **not merged into this branch**. They
block the value-picker / toggle consumers — ProjectsIndexPage status filter,
SpecBrowser **segment + file tabs**, MachineDetail mobile pane switch, ProjectCockpit
mobile-pane switch, and **McpServerCard** (its nested enable/disable toggle needs
`Switch`; the trigger/sibling-control structure itself is now unblocked by
`CollapsibleTrigger asChild`). Queued with the dependency cited.

**Needs a structural decision (not an appearance blocker):** ConversationTabs
(split-pane cross-region model) and ProjectCockpit's desktop view switch
(grid-template-areas — the conversations view is two grid-area children, not one
`TabsContent` element).
