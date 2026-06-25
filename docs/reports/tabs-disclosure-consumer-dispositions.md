# Tabs / Segmented / Collapsible / Accordion — consumer-migration dispositions

Per-consumer disposition for the "Tabs, Segmented, Collapsible, and Accordion
Consumer Migration" context. Records which audited consumers were **MIGRATED**
onto the CC primitives available in this worktree vs **DEFERRED**, each with the
cited governing source.

## Primitives actually available in this worktree

This branch (`disclosure-primitives`, merged with `tabs-primitive`) ships only:

- `src/components/ui/Tabs.tsx` — Radix `TabsRoot/TabsList/TabsTrigger/TabsContent`
  (+ `TabsTriggerCount`) carrying the **cc-tab pill** appearance, plus the legacy
  presentational `Tabs/Tab/TabCount` recipe (unchanged, for value-pickers).
- `src/components/ui/Collapsible.tsx` — Radix Collapsible (APG Disclosure).
- `src/components/ui/Accordion.tsx` — Radix Accordion (APG Accordion).

**`SegmentedControl` / `RadioGroup` / `Switch` are NOT present here** — they live
in the separate `radix-choice-primitives` context, not merged into this worktree.
Any consumer whose correct target is a segmented/exclusive-choice control (a
*mode switch*, not a panel-switcher) therefore **cannot** be converted in this
context; it is deferred with that dependency cited (migration contract §7/§10).

## Governing constraint (why some named consumers are deferred)

The CC `Tabs`/`Collapsible`/`Accordion` parts deliberately **omit `className`**
and bake a fixed appearance (cc-tab pill strip; `disclosureTriggerBase` header;
`accordionRoot` bordered card), exposing only the layout-only `layoutClassName`
escape hatch. A consumer can adopt a primitive only when that baked appearance
reproduces it without a redesign. Where it cannot, the higher-ranked
**"do not redesign CC visual language / introduce no new palette" non-goal**
(Workflow Charter) and the **ui-primitive parity requirement** (source rank 2)
prevail over the acceptance criterion that names the consumer. Per the charter's
conflict rule, the mismatch is **flagged and recorded here**, not force-fit — the
same disposition pattern used by the overlay-consumer and switch-choice contexts.

---

## TABS / SEGMENTED (task: migrate-tabs-consumers)

| Consumer | Disposition | Rationale (cited) |
|---|---|---|
| **WorkflowInspectorPanel** (`features/workflows-builder/components/WorkflowInspectorPanel.tsx`) | **MIGRATED** → Radix `TabsRoot/TabsList/TabsTrigger/TabsContent` | True panel-switcher (Workflow ⇄ Context body) on the cc-tab recipe — the exact appearance the CC Tabs primitive carries. Now has roving focus, `role=tab`/`tabpanel` + `aria-controls`/`aria-selected` wiring, automatic activation; disabled "Context" trigger preserved; controlled `value`/`onValueChange` keeps the auto-switch-on-context-select effect; a stale `"context"` value with no selection coerces to `"workflow"`. `TabsRoot` is `[display:contents]` so the `<aside>` flex column lays out header+body byte-identically (no layout box added). Contract §10. |
| **DiffPanel** (`features/session/git/DiffPanel.tsx`) | **MIGRATED** → Radix `TabsRoot/TabsList/TabsTrigger/TabsContent/TabsTriggerCount` | Uncommitted ⇄ Commits panel-switcher on the cc-tab recipe → byte-identical appearance. Plain `TabsContent` (matches the prior unmount-on-switch ternary). `CommitHistory`'s lazy `useCommitDiffQuery` untouched. Tests updated (`data-active`→`aria-selected`; tab-activation `fireEvent.click`→`fireEvent.mouseDown`). Contract §10. |
| **SessionDiffViewer** (`features/session-diff/components/SessionDiffViewer.tsx`) | **MIGRATED** → Radix `TabsRoot/TabsList/TabsTrigger/TabsContent/TabsTriggerCount` | Uncommitted ⇄ Commits; default tab still computed from `diff.files.length`; plain `TabsContent`. Byte-identical cc-tab appearance. Contract §10. |
| **RightPane** (`features/session/conversation/RightPane.tsx`) | **MIGRATED** → Radix `TabsRoot/TabsList/TabsTrigger/TabsContent` | Diff/Docs/Specs; `forceMount` on each `TabsContent` to **preserve the prior keep-mounted** (`display:contents`/`none`) behavior; visibility via `data-[state=inactive]:hidden` (Preflight-off: an author display utility beats the bare `hidden` attribute). Contract §10. |
| **AgentCapabilitiesConfigurator** (`components/agent-capabilities/AgentCapabilitiesConfigurator.tsx`) | **MIGRATED** (unstyled-trigger follow-up) → Radix `TabsRoot/TabsList(asChild)/TabsTrigger(asChild)/TabsContent` | A genuine `role=tablist` panel-switcher with **bespoke grouped underline tabs** (Shared/Claude/Codex group labels interleaved between triggers, agent-identity cyan/violet accents, bottom-border active). The shipped `asChild` (unstyled) escape hatch (follow-up #1) lets `TabsList`/`TabsTrigger` adopt the consumer's own strip + buttons, so Radix wires roving focus + automatic activation + aria while the bespoke appearance is preserved byte-for-byte (the group-label `<span>`s stay interleaved and roving focus skips them). Active state moved from a manual `isActive` check to `data-[state=active]:…` variants (incl. `data-[state=active]:data-[agent=codex]:border-b-violet`); panels are now `TabsContent` (Radix mounts only the active). Modeled by the `GroupedUnderlineTabs` story; before/after parity screenshots byte-identical at 1440×900 + 390×844; live ArrowRight roving-focus + cyan ring verified. Contract §10. |
| **ProjectCockpit** view switch (`features/project-detail/cockpit/ProjectCockpit.tsx`) | **DEFERRED** | The Sessions ⇄ Conversations switch is a true panel-switcher on the cc-tab recipe, but its two "panels" are laid out as **independent CSS `grid-template-areas` children** (the conversations view is *two* grid areas — rail + workspace — not one element). Radix `TabsContent` must wrap each panel in a single element, which cannot enclose two sibling grid-area children without restructuring the responsive grid (parity risk). The second strip (`chat`/`rail` mobile-pane switch) is a **CSS-visibility mode switch** with no tabpanels → a segmented control (§7), whose primitive is absent here. Both deferred. |
| **ConfigPage** settings nav (`features/config/ConfigPage.tsx`) | **MIGRATED** → `TabsRoot orientation="vertical"` + `TabsList asChild` (the `<nav>`) + `TabsTrigger asChild` (the `NAV_ITEM_BASE` buttons) + `TabsContent` per section | **Decision: true tabset, not app navigation.** The nav buttons swap which `*Section` renders **in place within the same `/config` route** — no URL/route change, no navigation event — which is the definition of a tabset panel-switcher, not navigation (APG Tabs vs a nav landmark). So `role=tab`/`role=tabpanel` semantics are correct. The `asChild` escape hatch (follow-up #1) reproduces the bespoke vertical nav appearance exactly (`NAV_ITEM_BASE`, inset-cyan `data-[state=active]:shadow-[inset_2px_0_0_var(--cyan)]`) while Radix supplies Up/Down roving focus + automatic activation + `data-orientation=vertical` + aria-selected/controls; the previously conditionally-rendered sections became `TabsContent` (inactive panels keep their `hidden` wrapper, children unmount). The non-capabilities `ConfigSaveBar` gating is preserved. Contract §10. |
| **MachineDetail** mobile diagram/info switch (`features/workflows-catalog/machine/MachineDetail.tsx`) | **DEFERRED** | A responsive **mode switch** (`data-mobile-panel` toggles CSS visibility of the canvas vs the detail rail, both present together on desktop) — a value-picker, not a panel-switcher (contract §7/§10). Correct target is `SegmentedControl`, which is **absent from this worktree**. The file's own comment already documents why the appearance-locked `Tab` primitive can't carry its mobile parity overrides. |
| **SpecBrowser** steering/features segment + per-file tabs (`features/session/conversation/SpecBrowser.tsx`) | **KEPT (presentational)** | These are **value-pickers** — the segment selects which list renders and the file tabs select which doc the `MarkdownViewer` shows; neither switches a `role=tabpanel`. Per contract §10 ("keep the presentational recipe for cases that are visually tabs but not panel-switchers"), they stay on the unchanged presentational `Tabs/Tab/TabCount` recipe. Not Radix tabs, not segmented. |
| **ConversationSidebarHeader** filter strip (`features/session/sidebar/ConversationSidebarHeader.tsx`) | **DEFERRED — blocked-on-SegmentedControl** | The All/Needs/Run/Session strip is a **filter value-picker** (each button sets `onFilterChange`; there are **no `role=tabpanel`s** and no `aria-controls`) — a mode switch, not a panel-switcher (contract §7/§10). Its current `role="tablist"`/`role="tab"`/`aria-selected` markup is in fact the **misuse a SegmentedControl corrects** (segmented = `radiogroup`/`radio`, not tab/tablist). Correct target is the §7 `SegmentedControl`, which is **absent from this worktree** (lives in `radix-choice-primitives`, not merged here). Not Radix Tabs (no panels to switch). Deferred with the dependency cited — same disposition as the ProjectsIndexPage status filter and MachineDetail mobile switch. |
| **ConversationTabStrip** (`features/session/tabs/ConversationTabStrip.tsx`) | **KEPT (already-correct ARIA) — keep-with-rationale** | A genuine open-conversation tab strip, but **structurally un-migratable to Radix Tabs without a redesign** — identical blockers to the cockpit `ConversationTabs` row (Group B below): (1) **cross-region split-pane** — the strip is rendered in `SessionContent` while its conversation *panels* (`ConversationPanelContainer` / `PanesGrid`) are rendered in a *separate* grid cell, so there is no co-located element a Radix `Tabs.Root` could enclose as both list **and** content; (2) each `ConversationTab` (`<div role=tab>`) **nests an interactive close `<button>`** (and a rename input), which is invalid inside a Radix `TabsTrigger` (itself a `<button>`) — de-nesting changes DOM/appearance. It already exposes correct `role=tablist`/`role=tab`/`aria-selected`; keyboard activation (Enter/Space) is wired in `ConversationTab`. Higher-ranked **don't-redesign non-goal** (Charter) + **ui-primitive parity** (rank 2) prevail over the criterion; "panel visibility / aria-selected remain correct" already holds. (`aria-controls` is omitted because the panel lives cross-region with no single stable tabpanel id — adding it is part of the same deferred restructure.) |

---

## DISCLOSURE (task: migrate-disclosure-consumers)

| Consumer | Disposition | Rationale (cited) |
|---|---|---|
| **InspectorConfigBlock** (`features/workflows-builder/components/InspectorConfigBlock.tsx`) | **MIGRATED** → `Collapsible` (controlled) | Single show/hide region — the contract's named "config blocks" consumer (§8). Radix now wires `aria-expanded`/`aria-controls` and **unmounts the closed body** (out of the a11y tree + tab order). Header kept via `CollapsibleTrigger hideChevron` + the existing `SectionChevron`/label/summary/badge children; body appearance moved to an inner div inside `CollapsibleContent`. Standard disclosure-trigger hover (`bg-bg-hover`) is a minor normalization, accepted for consumer migration. |
| **CollabCollapsibleCard** (`features/session/conversation/collab/CollabCollapsibleCard.tsx`) | **MIGRATED** → `Collapsible` (controlled) | Standalone disclosure used by all collab cards (§8). Controlled `open`/`onOpenChange` preserves the orchestration "expand/collapse all" (a card mounted during an active force now honours it); `hideChevron` keeps the ▸/▾ glyph; agent-identity left border + nav pulse stay on the outer `<section>` wrapper. Closed body now unmounts. |
| **McpServerCard** (`components/mcp/McpServerCard.tsx`) | **DEFERRED** | The header `<button>` **embeds a nested interactive `role=switch` toggle** (and a refresh control pattern). A Collapsible trigger is itself a `<button>`; nesting an interactive control inside it is invalid and Radix cannot host it. Splitting the full-row-click-to-expand header from the toggle is a header **redesign** beyond consumer-migration scope (also flagged in the switch-choice dispositions as "McpServerCard nested-in-header toggle"). Deferred; needs the header restructure + the absent Switch primitive. |
| **CommitHistory** (`features/session/git/CommitHistory.tsx`) | **MIGRATED** → `Accordion type="single" collapsible asChild` (rail container) / `AccordionItem asChild` (timeline row) / `AccordionTrigger asChild` (CSS-grid header button) / `AccordionContent asChild` (diff panel), via the `asChild` escape hatch (follow-up #4) | The timeline-rail `::before`/`::after` pseudo-elements moved onto the consumer's own item `<div>` and re-keyed `has-[[data-expanded=true]]`→`has-[[data-state=open]]`; the 2-row CSS-grid header button is the `asChild` trigger. **Lazy diff preserved**: `useCommitDiffQuery(..., isExpanded ? commit.fullHash : null)` with `isExpanded = expandedHash === commit.fullHash` driven off the controlled accordion value (`enabled: !!hash`) — live-verified 0 diff requests while collapsed, exactly 1 on expand. **Fixes the pre-existing a11y gap for free** (real `<button>`, `aria-expanded`/`aria-controls`, role=region, roving focus, Enter/Space). **Parity note:** swapping the clickable `<div>`→`<button>` dropped the inherited page font to the UA button default (13.3px/normal, Preflight off), shrinking the auto-sized grid rows ~6px/row (accumulating drift) + a metadata baseline shift; pinned `text-[15px] leading-[1.5]` on the trigger to restore the div's exact font context → before/after now byte-identical (0px) at 1440×900 + 390×844. Contract §8/§10. |
| **SpecBrowser feature groups** (`features/session/conversation/SpecBrowser.tsx`) | **MIGRATED** (unstyled-trigger follow-up) → `Accordion type="single" collapsible asChild` (flat `<div>` column) / `AccordionItem asChild` / `AccordionTrigger asChild` (header `<button>`) / `AccordionContent asChild` | A single-expand stack rendered as a **flat borderless list**. The shipped `asChild` (unstyled) escape hatch (follow-up #4) keeps the flat appearance (no `accordionRoot` card frame, no hairlines) while Radix wires `aria-expanded`/`aria-controls`/roving focus/single-open + mount-unmount — **fixing the pre-existing missing-`aria-expanded`/keyboard gap**. The two-glyph `▾`/`▸` swap became a single `▸` rotating via `group-data-[state=open]/spec-group:rotate-90`; count-badge + header-text state re-keyed `data-[expanded=true]`→`data-[state=open]`. The file list is `<button>`s wrapped in a generic `<div>` content element (never a `<ul>` directly — a `<ul>` as the asChild content would take Radix's `role=region` and orphan its `<li>`s, axe `listitem`). **Only the feature groups migrated**; the steering/features **segment** + per-file **tabs** stay presentational (value-pickers → absent `SegmentedControl`, see row above). Modeled by the `FlatGroupList` story; live Enter-toggle + single-open verified. Contract §8/§10. |
| **SessionDiffViewer** commit disclosure (`features/session-diff/components/SessionDiffViewer.tsx`) | **MIGRATED** → `Accordion type="single" collapsible asChild` (commit list) / `AccordionItem asChild` (timeline-rail row) / `AccordionTrigger asChild` (CSS-grid header button) / `AccordionContent asChild` (lazy diff panel) | The **session-diff page's Commits tab** held a hand-rolled copy of the exact CommitHistory disclosure — a clickable `<div onClick={onToggle}>` per commit with **no `aria-expanded`/`aria-controls` and no keyboard trigger**, the diff body conditionally rendered on an `isExpanded` prop. Migrated in place (NOT by importing CommitHistory — that lives in the separate `session/git` feature; cross-feature import is forbidden by the colocation rule, which is why this file keeps its own diff recipes). Mirrors CommitHistory exactly with this file's own class strings for **byte-parity**: the timeline rail `::before`/`::after` stays on the `AccordionItem asChild` `<div>` and keeps its existing `isExpanded`-driven expanded classes (the prop stays in sync with the controlled accordion value); the 2-row grid header `<div>`→`AccordionTrigger asChild` `<button>` with the same `text-[15px] leading-[1.5]` font pin + inset cyan `focus-visible` ring CommitHistory uses (div→button drops the inherited page font under Preflight-off); the diff body `{isExpanded && …}`→`AccordionContent asChild` so Radix mounts/unmounts it. **Lazy diff preserved**: `useCommitDiffQuery(..., isExpanded ? commit.fullHash : null)` unchanged, gated off the controlled accordion value (single-open via the page's existing `expandedHash` state). **Fixes the pre-existing a11y gap** (real `<button>`, `aria-expanded`/`aria-controls`, role=region, roving focus, Enter/Space). Contract §8/§10. |

---

## Recommended follow-ups (for future contexts / primitive work)

These require either an absent primitive or an **additive** primitive change, which
per the ui-primitive skill must be done design-first in a primitive-implementation
context (not a consumer-migration one) — mirroring the overlay/​switch waves'
queued "additive content variant" follow-ups:

1. **Tabs underline/grouped appearance variant** (or `asChild`/unstyled list+trigger) → unblocks AgentCapabilitiesConfigurator and ConfigPage nav.
2. **SegmentedControl** (the `radix-choice-primitives` primitive) merged into this lineage → unblocks MachineDetail mobile switch, ProjectCockpit mobile-pane switch, and any SpecBrowser segment reconsidered as a control.
3. **ProjectCockpit grid restructure** so the conversations view is a single `TabsContent` element (or a `display:contents` panel wrapper) → unblocks its Radix Tabs migration.
4. **Collapsible/Accordion unstyled (`asChild`/flat) trigger+content variant** → unblocks CommitHistory (timeline rail), SpecBrowser feature groups (flat list), and the McpServerCard header restructure (split trigger from the toggle); fix the pre-existing missing-`aria-expanded` gaps at the same time.

---

## UPDATE — `asChild` escape hatch shipped (follow-ups #1 and #4 done)

The additive **`asChild` (unstyled) escape hatch** is now on `TabsList`,
`TabsTrigger`, `CollapsibleTrigger`, `CollapsibleContent`, and all four Accordion
parts (root/item/trigger/content); `orientation="vertical"` is confirmed exposed
on `TabsRoot`. A bespoke consumer supplies its own element and Radix wires the
behaviour onto it; the baked recipe + chevron are dropped so they cannot pollute
it. Verified live (Storybook + injected axe) — see
`docs/reports/unstyled-trigger-variants-verification.md`.

This **flips the appearance/structure rationale** for these deferred consumers to
"unblocked — queued as a migration slice":

- **AgentCapabilitiesConfigurator** (Tabs `asChild` grouped underline) — unblocked.
- **ConfigPage** nav (Tabs `asChild` + `orientation="vertical"`) — unblocked.
- **CommitHistory** (Accordion `asChild` grid header; preserve the lazy
  `useCommitDiffQuery`; fix the missing-`aria-expanded` gap) — unblocked.
- **SpecBrowser feature groups** (Accordion `asChild` flat list; same a11y fix) —
  unblocked.

Still blocked by an **absent primitive** (the §7 `SegmentedControl`/`RadioGroup` +
`Switch` are in the sibling `radix-choice-primitives` context, **not merged into
this branch**), so deferred with that dependency cited, NOT force-fit:
ProjectsIndexPage status filter, SpecBrowser file tabs, MachineDetail mobile
switch, ProjectCockpit mobile-pane switch (value-pickers → segmented), and
**McpServerCard** (its nested enable/disable toggle needs `Switch`; the
trigger/sibling-control structure itself is now unblocked).

Still a **structural decision** (not an appearance blocker): ConversationTabs
(split-pane) and ProjectCockpit's desktop view switch (grid-template-areas).

---

## DECISION NOTE — blocked / structural-decision consumers (task: resolve-blocked-tabs-disclosure-consumers)

Resolution of the two groups of audited consumers that the shipped `asChild`
escape hatch did **not** unblock. Per consumer: **migrate-now / blocked-on-X /
keep-with-rationale**. No new dependency was introduced and no parallel control
was hand-rolled (migration contract §7/§13; Workflow Charter non-goals).

### GROUP A — blocked by an ABSENT primitive (§7 SegmentedControl/RadioGroup + Switch)

The §7 segmented/exclusive-choice primitive (`SegmentedControl`/`RadioGroup`) and
`Switch` live in the sibling `radix-choice-primitives` context and are **not
merged into this branch** (confirmed: no `src/components/ui/SegmentedControl.tsx`
/ `RadioGroup.tsx` / `Switch.tsx` here). Every Group-A consumer is a **mode
switch / value-picker** (selects a value, does not swap a `role=tabpanel`) or a
nested binary toggle — their correct target is that absent primitive, NOT Radix
Tabs/Collapsible/Accordion.

| Consumer | Decision | Cited reason |
|---|---|---|
| **ProjectsIndexPage** status filter | **blocked-on-SegmentedControl** | Value-picker (active/idle/archived filter), contract §7/§10. Target = SegmentedControl, absent here. |
| **SpecBrowser** steering/features segment + per-file tabs | **blocked-on-SegmentedControl** | Value-pickers (segment selects which list renders; file tabs select which doc `MarkdownViewer` shows) — neither swaps a `role=tabpanel`. Contract §10 keeps them on the presentational recipe until SegmentedControl lands. (Feature *groups* already migrated → Accordion, separate row.) |
| **MachineDetail** mobile diagram/info switch | **blocked-on-SegmentedControl** | Responsive CSS-visibility mode switch (canvas vs detail rail, both present on desktop). Contract §7/§10. The file's own comment documents why the appearance-locked `Tab` can't carry its mobile overrides. |
| **ProjectCockpit** mobile chat/rail pane switch | **blocked-on-SegmentedControl** | `MobilePane` (`chat`/`rail`) toggles CSS visibility via `group-data-[mobile-pane]` — a mode switch with no tabpanels. Contract §7. |
| **McpServerCard** header enable/disable toggle | **blocked-on-Switch** | The header `<button>` embeds a nested interactive `role=switch`; the trigger/sibling-control STRUCTURE is now unblocked by `CollapsibleTrigger asChild` (see `UI/Collapsible › HeaderWithSiblingControl`), but the toggle itself still needs the absent `Switch` primitive. |
| **ConversationSidebarHeader** filter strip (`features/session/sidebar/ConversationSidebarHeader.tsx`) | **blocked-on-SegmentedControl** | The All/Needs/Run/Session strip is a **filter value-picker** — each button calls `onFilterChange`, there are **no `role=tabpanel`s** and no `aria-controls`. Its present `role="tablist"`/`role="tab"`/`aria-selected` is the exact tab-semantics misuse a SegmentedControl corrects (segmented = `radiogroup`/`radio`). Target = the §7 `SegmentedControl`, **absent here**. NOT Radix Tabs (nothing to panel-switch); deferred with the dependency cited, not force-fit, not hand-rolled. |

**Coordination recommendation (surfaced to Alex):** land/merge the
`radix-choice-primitives` `SegmentedControl`/`RadioGroup` + `Switch` into this
lineage (via a dedicated primitive-implementation context running the
`ui-primitive` skill), **or** migrate these specific consumers within the
`radix-choice-primitives` context where those primitives already live. Until one
of those happens, all Group-A consumers **stay deferred with the dependency
cited** — the charter-compliant default (do not introduce a new dependency or
hand-roll a parallel control). No code change in this task.

### GROUP B — structural decision (not an appearance blocker)

| Consumer | Decision | Cited rationale (source-of-truth) |
|---|---|---|
| **ConversationTabs** (`features/project-detail/cockpit/ConversationTabs.tsx`) | **keep-with-rationale** (already-correct ARIA) | TWO structural blockers, each a redesign beyond consumer-migration parity: (1) it is **presentational and cross-region** — it renders only the tab *strip*; the conversation *panels* are rendered elsewhere by the page (split-pane), so there is no co-located `TabsContent`, and Radix `Tabs.Root` must enclose both list and content. (2) each tab `<button>` **nests an interactive close control** (`<span role="button" tabindex=0>`); a Radix `TabsTrigger` is itself a `<button>`, and interactive-content-in-a-button is invalid ARIA — de-nesting the close into a sibling changes the DOM/appearance. It already exposes correct `role=tablist`/`role=tab`/`aria-selected`. Higher-ranked **don't-redesign non-goal** (Charter) + **ui-primitive parity** (rank 2) prevail over the criterion; "panel visibility / aria-selected remain correct" already holds. |
| **ConversationTabStrip** (`features/session/tabs/ConversationTabStrip.tsx`) | **keep-with-rationale** (already-correct ARIA) | The open-conversation tab strip — structurally identical to `ConversationTabs` above. TWO redesign-level blockers: (1) **cross-region split-pane** — `SessionContent` renders the strip in one grid cell and its conversation *panels* (`ConversationPanelContainer` / `PanesGrid`) in a *separate* cell, so a Radix `Tabs.Root` has no co-located element to enclose as both list **and** `TabsContent`; (2) each `ConversationTab` (`<div role=tab>`) **nests an interactive close `<button>` + rename `<input>`**, invalid inside a Radix `TabsTrigger` (itself a `<button>`) — de-nesting changes DOM/appearance. Already exposes `role=tablist`/`role=tab`/`aria-selected` with Enter/Space activation; `aria-controls` is omitted because the panel is cross-region with no single stable tabpanel id (part of the same deferred restructure). Don't-redesign non-goal (Charter) + ui-primitive parity (rank 2) prevail over the criterion; required "aria-selected / panel visibility remain correct" already holds. |
| **ProjectCockpit** desktop Sessions⇄Conversations view switch (`features/project-detail/cockpit/ProjectCockpit.tsx`) | **keep-with-rationale / defer** (already-correct ARIA) | The Conversations view is **two independent `grid-template-areas` children** — the rail (`#plc-conversation-list`, `[grid-area:rail]`) and the workspace (`#plc-conversation-workspace`, `role=tabpanel`, `[grid-area:conversation]`). A single Radix `TabsContent` cannot span two grid areas; the offered `[display:contents]` wrapper is viable in principle but interacts with (a) the panels' **asymmetric mount semantics** (conversations children are conditionally *unmounted* when on Sessions, while `SessionsPanel` stays mounted-and-`hidden`) and (b) the tightly-coupled responsive `group-data-[mobile-pane=…]:[&_.convo-sidebar]:…` descendant selectors — replicating both exactly via `forceMount` + `data-[state=inactive]:hidden` is a structural rework with real parity risk, i.e. a redesign, not a mechanical swap. It is also interleaved with the Group-A mobile chat/rail **mode switch** (→ absent SegmentedControl), so the cockpit cannot be fully/consistently resolved in this context regardless. The desktop switch already wires `role=tablist`/`role=tab`/`aria-selected`/`aria-controls` → `role=tabpanel`. Per "only implement a Tabs migration where parity holds" + the don't-redesign non-goal (Charter) + ui-primitive parity (rank 2), **keep the current correct ARIA and defer** the Radix migration to a future cockpit-grid restructure (recorded follow-up #3) bundled with the SegmentedControl landing. |

**Net for this task:** no consumer is *unblocked by a decision* (Group A awaits an
absent primitive; Group B's parity does not hold without a redesign), so no new
code migration is performed here — the deliverable is this recorded decision,
with each consumer marked migrate-now / blocked-on-X / keep-with-rationale and the
governing source-of-truth cited.
