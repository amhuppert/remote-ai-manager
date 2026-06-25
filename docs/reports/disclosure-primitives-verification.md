# Collapsible & Accordion primitives — live verification record

Primitives: `src/components/ui/Collapsible.tsx` (WAI-ARIA APG **Disclosure**) and
`src/components/ui/Accordion.tsx` (WAI-ARIA APG **Accordion**), sharing
`src/components/ui/disclosure-recipe.ts`. Stories:
`Collapsible.stories.tsx`, `Accordion.stories.tsx`.

Verified against a **private Storybook in this worktree on :6021** — the shared
`ensure_dev_server({ name: "storybook" })` resolves to the **prefix-sibling**
worktree `radix-ui-migration-aba982` (its index served only the legacy
`Components/CollapsibleText`, not `UI/Collapsible`/`UI/Accordion`), so a private
`storybook dev --port 6021` was started here. Same gotcha noted for prior waves.

## Collapsible (`ui-collapsible--simple-disclosure`)

- **Keyboard reveal:** Tab focuses the trigger (`<button>`, `data-state=closed`,
  `aria-expanded=false`); Enter toggles to `data-state=open`, `aria-expanded=true`,
  `aria-controls` resolves to the now-mounted region (`#radix-_r_0_`) whose text
  is visible. Space behaves identically (Radix native button).
- **Focus ring:** keyboard focus matches `:focus-visible`; computed outline
  `2px solid rgb(0, 229, 255)` (canonical cyan `--color-cyan`), `outline-offset:-2px`
  (inset, inside the trigger padding). Captured in `collapsible-open.png`.
- **Chevron:** trailing `ChevronDownIcon` computes `rotate: 180deg` when the
  trigger group is open (Tailwind v4 `rotate-180` sets the CSS `rotate` property,
  not `transform` — `transform` reads `none`, which is expected).
- **Escape:** N/A — a disclosure is in-flow content, not a dismissable overlay
  (no Radix Escape handling, by design; the primitive does **not** register with
  the overlay scope, so page hotkeys stay live while open).
- **axe (wcag2a/2aa/21a/21aa/22aa):** zero violations on the component. The only
  hit is the pre-existing **global `.tooltip-portal`** (`aria-tooltip-name`),
  out-of-scope per migration contract §4 — reported, not absorbed.

## Accordion (`ui-accordion--single`, `--disabled-item`)

- **Roving focus:** Tab enters the first header; ArrowDown moves to the next
  header (`Overview → Requirements`, cyan ring follows); End jumps to the last
  header (`Tasks`). Each header is a `<button>` matching `:focus-visible`.
- **Single semantics:** Enter on `Tasks` opens it and **only** it
  (`aria-expanded=true` on exactly one header); the other panels are `hidden`
  (`display:none`, empty, removed from the a11y tree and tab order). Multiple
  (`--multiple`) keeps independent panels open together (covered by unit tests).
- **Region wiring:** open panel is `role=region`, `id` matches its header's
  `aria-controls`.
- **Disabled item:** the `Locked` header is `disabled` + `data-disabled`,
  `opacity:0.5`, and `pointer-events:none`. The `pointer-events` drop is
  deliberate: the unlayered `typography.css` `button { cursor: pointer }` reset
  beats any `@layer utilities` `cursor-not-allowed`, so — matching `menu-recipe`
  — disabled triggers suppress pointer events instead (no stale pointer cursor).
- **axe:** zero violations on the component (same single global `.tooltip-portal`
  hit only).

## Gates

`bun run typecheck` PASS · targeted `eslint` clean on the 3 new files +
2 stories · `Collapsible.test.tsx` + `Accordion.test.tsx` = 16 tests green.
The repo-wide `bun run lint` reports 40 pre-existing errors, none in these files.
