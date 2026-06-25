# Tabs / Disclosure consumer-migration — verification record

Verification for the migrated consumers in the "Tabs, Segmented, Collapsible,
and Accordion Consumer Migration" context. Migrate-vs-defer table:
`docs/reports/tabs-disclosure-consumer-dispositions.md`.

> **Concurrency note.** Two iterations of this execution context ran in the same
> worktree. The final on-disk state is a green merge of both. This record was
> consolidated to cover the **full** migrated set (6 consumers + the guardrail
> extension), superseding the earlier "(3)" framing.

## Migrated consumers (6)

Tabs (Radix `TabsRoot/TabsList/TabsTrigger/TabsContent`, byte-identical cc-tab look):
- `WorkflowInspectorPanel` — Workflow/Context; `TabsRoot` is `[display:contents]`;
  stale `"context"` value with no selection coerces to `"workflow"`.
- `DiffPanel` — Uncommitted/Commits; plain `TabsContent`; CommitHistory lazy
  `useCommitDiffQuery` untouched.
- `SessionDiffViewer` — Uncommitted/Commits; default tab from `diff.files.length`.
- `RightPane` — Diff/Docs/Specs; `forceMount` TabsContent to preserve the prior
  keep-mounted behavior; visibility via `data-[state=inactive]:hidden`.

Disclosure (Radix `Collapsible`, closed region unmounts):
- `InspectorConfigBlock` (controlled) — `CollapsibleTrigger hideChevron` keeps the
  bespoke `SectionChevron`-at-start.
- `CollabCollapsibleCard` (controlled) — keeps the ▸/▾ glyph; orchestration
  force-state preserved + honored on first mount.

## Guardrail extension (`eslint-rules/tailwind-guardrails.mjs` + test)

The nested-Tabs flex/scroll chain in DiffPanel/SessionDiffViewer/RightPane needs
`min-h-0` (the height counterpart of the already-allowed `min-w`), and RightPane's
force-mounted visibility needs the bracketed state-variant `data-[state=…]:flex`/
`hidden` in `layoutClassName`. Added `min-h` to `LAYOUT_ALLOWED` and fixed
`stripVariants` to strip bracketed variant prefixes (`data-[…]:`) while leaving
arbitrary-value utilities (`[display:contents]`) intact. The change only removes
false-positives — a bracketed-variant **appearance** utility
(`data-[state=active]:bg-red-500`) still fails on its `bg-red-500` core (covered by
a new test). Guardrail RuleTester: **54 green**. Full-repo `eslint .` stays at the
documented **40-error** pre-existing baseline (zero added; none in any touched
file). This follows the established B-3 precedent ("extend `LAYOUT_ALLOWED` rather
than break parity").

## Unit / type / lint gates

- `vitest run` over the 7 touched suites (Tabs/Collapsible/Accordion primitives +
  WorkflowInspectorPanel + InspectorConfigBlock + CollabCollapsibleCard +
  CollabResolutionDecisionCard) = **85 passed**.
- Broader regression: `src/features/workflows-builder` + `…/collab` = 207 passed;
  `src/features/session/conversation` + `src/components/agent-capabilities` =
  299 passed / 7 skipped. No failures.
- `tsc --noEmit` clean. `eslint` clean on all changed source + test files and the
  guardrail.
- Red→green: the task's red tests (closed disclosure region UNMOUNTS; active tab
  resolves to a `role=tabpanel` via `aria-controls`) failed pre-migration and pass
  now. Ripple from the unmount-on-close semantics was fixed in the consuming tests
  (WorkflowInspectorPanel `expandBlock` before reading collapsed-block footers;
  CollabResolutionDecisionCard `defaultOpen` for the body-content sparkline tests).

## Live Storybook + injected-axe (private Storybook on :6044)

`ensure_dev_server({ name: "storybook" })` resolves to the **prefix-sibling**
worktree `radix-ui-migration-aba982` (its index lacks this branch's migrated
source), so a private `storybook dev --port 6044` was started in this worktree —
the recurring gotcha from prior waves. axe-core 4.10.2 injected via CDN, ruleset
`wcag2a/2aa/21a/21aa/22aa`.

### Tabs — `workflows-workflowinspectorpanel--workflow-tab` (+ `ui-tabs--panel-switcher`)

- `role=tablist` present; 2 `role=tab` triggers; active "Workflow" `aria-selected=true`
  + `data-state=active`; "Context" `disabled` + `aria-selected=false`.
- Each trigger's `aria-controls` resolves to a `role=tabpanel`; **only the active
  panel is mounted** (inactive context panel absent from the DOM).
- Roving keyboard nav confirmed on the primitive story: focus a trigger, `ArrowRight`
  moves focus to the next trigger, sets its `tabindex=0`, auto-activates it
  (`aria-selected=true`), and swaps the visible panel. (Initial `tabindex=-1` on the
  selected tab before focus enters is inherent Radix roving-focus behavior — it is
  identical in the already-verified `ui-tabs` primitive story, not a consumer
  regression.)

### Disclosure — `workflows-inspectorconfigblock--inherited-from-global`

- Collapsed by default: trigger is a `<button>`, `aria-expanded=false`,
  `data-state=closed`, **no region in the DOM** (unmounted; Radix omits
  `aria-controls` while the content is absent).
- `Enter` on the focused trigger expands: `aria-expanded=true`, `data-state=open`,
  `aria-controls` now resolves to the **newly-mounted** region (with content), and
  focus is retained on the trigger.

### Disclosure — `collab-collabinitialdraftcard--claude-primary-from-fixture`

- Click toggles the card: `aria-expanded` false→true, `data-state` closed→open,
  region mounts with content, `data-open` on the card `<section>` follows. Reverse
  click unmounts the region.

### Tabs — `session-diffpanel--with-commits` (private Storybook :6041, axe-core 4.11.1)

A second private Storybook (:6041) was run in this worktree for the additional tab
consumers (the prefix-sibling gotcha again). On DiffPanel WithCommits:
`role=tablist` + 2 `role=tab` (Uncommitted/Commits); active tab's `aria-controls`
resolves to a **visible** `role=tabpanel`. **Roving keyboard:** click Uncommitted →
`ArrowRight` moves **both selection and DOM focus** to Commits and reveals the
Commits panel (APG automatic activation), with a cyan focus outline (sampled
mid-`transition-all`; settles to `rgb(0,229,255)`). axe hits: the global
`.tooltip-portal` (§4) and `color-contrast` on CommitHistory's `.opacity-70`
commit-metadata text — the latter inside a **deferred** consumer (untouched),
pre-existing, not introduced by the tab migration.

### axe triage — every hit is pre-existing / out-of-scope (none introduced here)

- `aria-tooltip-name` on the global **`.tooltip-portal`** — the pre-existing empty
  global portal, out-of-scope per migration contract §4 (reported, not absorbed —
  same hit recorded in the disclosure-primitive verification).
- `select-name` on `ImplementerEditor`'s native `<select>`s (3) — pre-existing
  nameless selects, a deferred **Select-consumer** concern (contract §12), not
  changed by this migration; they were nameless before and merely surface once the
  disclosure body is open.
- `color-contrast` on the collab card header summary text ("2 claims · 2
  assumptions", `text-text-tertiary` on `bg-bg-raised`) — pre-existing
  design-system tertiary-on-elevated contrast on header content supplied by
  `CollabInitialDraftCard`, not introduced by the trigger migration.

No axe violation originates in the migrated `Tabs`/`Collapsible` wiring.

## UPDATE — retry: SessionDiffViewer commit disclosure + remaining tablist dispositions

Addresses the reopened-context validator feedback (three items).

### SessionDiffViewer commit disclosure → `Accordion` (MIGRATED)

`features/session-diff/components/SessionDiffViewer.tsx`'s inline `CommitEntry`
lazy commit-diff disclosure was still hand-rolled (clickable `<div>`, no
`aria-expanded`/`aria-controls`, no keyboard trigger). It is now migrated to the
`Accordion` primitive via the `asChild` escape hatch — a **structural mirror of
the already-unit-tested + live-verified `CommitHistory`** (same
`Accordion type="single" collapsible asChild` rail / `AccordionItem asChild`
timeline row / `AccordionTrigger asChild` CSS-grid header `<button>` /
`AccordionContent asChild` diff panel):

- Lazy diff preserved: `useCommitDiffQuery(..., isExpanded ? commit.fullHash : null)`
  driven off the controlled accordion value — the closed section fires **no**
  diff request (the query stays `enabled: !!hash`).
- The div→button font-parity trap (Preflight off, no `button{font:inherit}`) is
  handled identically to `CommitHistory`: `text-[15px] leading-[1.5]` + button
  resets pin the prior font context so the auto-sized grid rows don't drift;
  inset cyan focus-visible ring added.
- Closed region unmounts (Radix); `aria-expanded`/`aria-controls`/`role=region`
  + roving focus + Enter/Space now wired — **fixing the pre-existing a11y gap**.
- **Verification:** keyboard/focus/aria/visibility are provided wholesale by the
  `Accordion` primitive (independently live-verified + axe-clean — see
  `disclosure-primitives-verification.md`) and the wiring is byte-for-byte the
  pattern `CommitHistory.test.tsx` pins (button-per-commit, `aria-expanded`
  toggles on Enter/Space, `aria-controls`→mounted `role=region`, single-open). A
  bespoke SessionDiffViewer integration test was **not** added: it would require
  fabricating a full valid `sessionStateSchema` fixture plus three fetch stubs
  (the `useSessionQuery` retry policy makes the network boundary slow/brittle to
  fake), i.e. exactly the high-maintenance fake-wiring test the engineering
  standards caution against — the trivial-wiring-onto-a-verified-primitive
  exemption applies. `tsc --noEmit` clean; `eslint` clean on the file; all 135
  tests across the touched primitive + consumer suites green.

### Remaining production tablists — now dispositioned (no code change)

Two audited `role=tablist` usages the prior pass omitted are now in the
dispositions table **and** the decision note:

- **`ConversationSidebarHeader`** (sidebar All/Needs/Run/Session filter strip) —
  **blocked-on-SegmentedControl**. A filter value-picker with no `role=tabpanel`s
  / `aria-controls`; its `role="tablist"`/`role="tab"` markup is the very
  tab-semantics misuse a `SegmentedControl` (radiogroup/radio) corrects. Target
  is the §7 `SegmentedControl`, absent from this worktree → deferred with the
  dependency cited (same disposition as ProjectsIndexPage / MachineDetail).
- **`ConversationTabStrip`** (open-conversation tab strip) —
  **keep-with-rationale**. Structurally identical to the cockpit
  `ConversationTabs`: cross-region split-pane (strip and its conversation panels
  render in separate `SessionContent` grid cells, so no co-located
  `Tabs.Root`/`TabsContent` pairing) **and** each `ConversationTab` nests an
  interactive close `<button>` + rename `<input>` (invalid inside a Radix
  `TabsTrigger`). Already exposes `role=tablist`/`role=tab`/`aria-selected` with
  Enter/Space activation; the don't-redesign non-goal (Charter) + ui-primitive
  parity (rank 2) prevail over the criterion, and the required "aria-selected /
  panel visibility remain correct" already holds.

## Deferred consumers

Documented with cited rationale in `tabs-disclosure-consumer-dispositions.md`
(the authoritative migrate-vs-defer table). Genuinely deferred consumers —
ProjectCockpit (desktop grid-template-areas + mobile pane switch), MachineDetail
mobile switch, SpecBrowser steering/features segment + per-file tabs,
ProjectsIndexPage status filter, McpServerCard nested toggle,
**ConversationSidebarHeader** filter strip (added this retry), and
**ConversationTabStrip** / cockpit ConversationTabs (kept-with-rationale,
already-correct ARIA) — are blocked on either the absent `SegmentedControl` /
`Switch` primitive (the §7 choice controls live in the sibling
`radix-choice-primitives` context, not merged here) or a grid/structural
restructure, both of which are out of this consumer-migration context's scope.
(The consumers reached via the `asChild` escape hatch —
AgentCapabilitiesConfigurator, ConfigPage nav, CommitHistory, SpecBrowser feature
groups — are **MIGRATED**, recorded in the dispositions table's UPDATE section,
not deferred.)
