# Switch & Choice Consumer Migration — verification record

Context: "Switch and Choice Consumer Migration" of the radix-ui-migration workflow.
Dispositions (migrated vs deferred + rationale):
`.cc/graph-workflow-docs/switch-choice-consumer-dispositions.md`.

## Gates (all green)

- `bun run typecheck` — clean.
- `eslint` on the changed files — 0 errors (the `layoutClassName="flex-wrap"` on the
  migrated filter `SegmentedControl`s passes `no-appearance-in-layout-classname`).
- `CLAUDECODE='' bun run test --run` over the changed + deferred-consumer suites — 74 passed:
  `TddToggle.test.tsx` (8 — adds whole-pill click, no-double-toggle, and
  disabled-pill-click assertions through the switch role),
  `AgentCapabilityPanel.test.tsx` (12), `McpServerCard.test.tsx` (2),
  `CCCheckbox.test.tsx` (5), `ParameterDeclarationEditor.test.tsx` (18),
  `UnifiedComposer.test.tsx` (7), `project-cockpit-flows.test.tsx` (7),
  `PromptDesktopToolbar.test.tsx`, `BackendsSection.test.tsx` (2),
  `MobileActionMenu.test.tsx` (3), `MobileBottomBar.test.tsx` (4). The
  deferred-consumer suites (BackendToggle hooks, Mobile, AskQuestion) stay green untouched.

## Live pass (private Storybook + injected axe-core 4.10.2 + real keyboard)

`ensure_dev_server({ name: "storybook" })` resolves to the **prefix-sibling**
worktree (`radix-ui-migration-aba982`) which lacks these changes, so a **private**
Storybook was run from this worktree on `:6034` and driven with Playwright.

### TddToggle (`components-tddtoggle--interactive`)
- Renders `role="switch"`, accessible name "Toggle red-green TDD", for both the
  default and compact variants; the visible pill carries `cursor:pointer`.
- **Real `Space` keypress** toggles the focused switch (`aria-checked` true→false,
  focus retained on the switch — no trap).
- **Whole-pill click affordance verified directly** (this was the attempt-1
  regression, now restored). Each click was hit-tested with
  `document.elementFromPoint` and dispatched at a real coordinate; `aria-checked`
  read after a React flush (two `requestAnimationFrame`s):
  - **Padding click** — a point in the wrapper's left padding (between the pill
    border and the switch) hit-tests to the wrapper `<span>` itself (not the
    switch, not the label) and toggles `false→true`. The bordered/padded area
    toggles as one control again.
  - **Direct switch click** toggles **exactly once** (`true→false`, a net single
    flip) — the switch's `stopPropagation` prevents the wrapper handler also
    firing, so no double-toggle.
  - **Label click** toggles `false→true` (the label has no own handler; the click
    bubbles to the wrapper).
- Injected axe: **0 violations of mine.** The only hit is the pre-existing global
  empty `.tooltip-portal` (`aria-tooltip-name`) — reported-not-absorbed per
  contract §4 / the tooltip-primitive verification record. The wrapper's pointer
  `onClick` adds **no** new violation (keyboard access is fully provided by the
  inner focusable Radix `Switch`; the wrapper is a redundant mouse-only target).

### AgentCapabilityPanel (`…--interactive-regression`)
- Filters → a `role="radiogroup"` ("Filter Claude Skills") of 6 `role="radio"`
  items with the original accessible names ("Show all" … "Show parent-disabled");
  "Show all" `aria-checked=true` by default.
- **Real `ArrowRight`** moves roving focus + selection within the group
  (selection-follows-focus; the one-position skip is the known Radix
  arrow-timing quirk, not a wrapper bug — see the choice-primitives notes).
- Item toggles → `role="switch"` with names ("Disable Native Skill" …) +
  `aria-checked`.
- Injected axe: no violations from the migrated controls. Two non-mine hits — the
  global `.tooltip-portal`, and a `color-contrast` on the **deferred, untouched**
  layer-switcher card's `text-text-tertiary` detail subtext (the pre-existing
  tertiary-on-elevated contrast noted in `overlay-consumer-verification.md`).

### McpCapabilityPanelContainer (`…--server-rows`)
- Filters → a `role="radiogroup"` ("Filter MCP servers") of 4 named radios.
- Server toggles → `role="switch"` with names ("Disable playwright" …).
- Injected axe: no violations from the migrated controls. Two non-mine hits — the
  global `.tooltip-portal`, and a `button-name` on the expand **chevron `<button>`**
  (an `aria-hidden` `›` with no accessible name) — a **pre-existing** gap in the
  disclosure trigger this context did not touch; flagged for the Collapsible/
  disclosure migration (McpServerCard/McpCapabilityPanelContainer are named
  Collapsible consumers), reported-not-absorbed per contract §4.

## Deferred consumers (could not migrate safely — see disposition doc)

DebugModeToggle (amber pill toggle-button), McpServerCard server toggle
(nested-in-header-button + bespoke size → disclosure context), MCP tool toggles
(bespoke 14×26 size, no matching `Switch` size), BackendToggle +
MobilePromptToolbar backend (agent-identity violet vs cyan-only closed
`SegmentedControl`), MobilePromptToolbar model/effort rows (rich rows vs dot-list
`RadioGroup`), AskQuestionPanel option rows (fully bespoke per-agent rows + nested
input + 1–9 shortcuts), AgentCapabilityPanel layer switcher (two-line cards +
detail subtext + paired sr-only select). Two additive primitive follow-ups queued
(`Switch` xs-size + amber tone; `SegmentedControl` per-item agent accent).
