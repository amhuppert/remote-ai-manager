# Tooltip primitive — live verification & axe record

Component: `src/components/ui/Tooltip.tsx` (Radix-backed, WAI-ARIA APG
[Tooltip](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)).
Stories: `src/components/ui/Tooltip.stories.tsx` (`UI/Tooltip` — TextTrigger,
IconButtonTrigger, LongText, StaticOpen).
Verified live by driving the running Storybook with Playwright (the Storybook
a11y vitest project does not run in headless/AI mode).

## Environment

The CC-adopted `storybook` dev server resolves to the **prefix-sibling** worktree
(`radix-ui-migration-aba982`, without the `.tooltip-primitive` suffix) — a known
gotcha — so it does not serve this worktree's new files. Verification used a
**private Storybook started in this worktree** (`npx storybook dev --port 6019`),
where `index.json` indexed `ui-tooltip--*`.

## Keyboard / focus

- **Tab to trigger:** trigger receives focus; `:focus-visible` matches; computed
  trigger outline = `2px solid rgb(0, 229, 255)` (the canonical cyan focus ring
  from `Button`). Tooltip opens on focus (`data-state="instant-open"`).
- **`aria-describedby` wiring:** the focused trigger's `aria-describedby`
  (`radix-_r_0_`) matches the id of the open tooltip's visually-hidden
  `role="tooltip"` description span, whose text is the tooltip content
  ("Reveals on hover and keyboard focus").
- **Escape:** dismisses the tooltip, `aria-describedby` is cleared, and **focus
  remains on the trigger** (focus is not trapped).

## Pointer / hover

- Hovering the trigger opens the tooltip (`data-state="delayed-open"`);
  `aria-describedby` again matches the open tooltip span id
  (`describedbyMatchesOpenTip: true`).

## Appearance (computed style on the styled bubble)

Recipe resolves to the token values it ports from the legacy `.tooltip-portal`:

| property | computed | token |
|---|---|---|
| background | `rgb(23, 32, 51)` | `bg-bg-raised` (#172033) |
| border | `1px solid rgb(36, 48, 72)` | `border-border-default` (#243048) |
| color | `rgb(123, 137, 159)` | `text-text-secondary` (#7b899f) |
| z-index | `99999` | `z-tooltip` (`--z-index-tooltip`) |
| state | `instant-open` / `delayed-open` | Radix `data-state` |

Long content wraps onto multiple lines within `max-w-[260px]` (the legacy global
single-line system could not wrap); short labels still render on one line.
(Note: in the private Storybook the mono webfont falls back to a serif — a
Storybook font-injection artifact; the `font-mono` class and token are present.)

## axe (live, injected axe-core 4.x, wcag2a/2aa/21a/21aa/22aa)

One violation, **out of scope** for this primitive:

- `aria-tooltip-name` (serious) on `.tooltip-portal`. This is the **legacy global
  bespoke `TooltipProvider`** element (className `tooltip-portal`, `role=tooltip`,
  **empty** text, NOT inside any `[data-radix-popper-content-wrapper]`), mounted
  by the Storybook preview's global layout. It is the pre-existing system the
  migration contract §4 says to **report, not absorb** ("the bespoke
  `.tooltip-portal` global remains for unconverted sites"). Do not delete it in
  the primitive PR.

The Radix Tooltip primitive itself is **axe-clean**: it does not use the
`.tooltip-portal` class and exposes a proper accessible name via the
visually-hidden `role="tooltip"` description span.

## Gates

`bun run typecheck` clean · `eslint src/components/ui/Tooltip.tsx Tooltip.stories.tsx Tooltip.test.tsx`
0 problems · `vitest run src/components/ui/Tooltip.test.tsx --project unit` 7/7 green.
