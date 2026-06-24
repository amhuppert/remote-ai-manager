---
description: Implement or update a reusable UI primitive in src/components/ui/ — Radix-backed, design-system-faithful, WAI-ARIA APG-correct, with Storybook stories and a real keyboard/axe verification pass. Use when building or changing a shared primitive (dropdown, select, dialog, tooltip, popover, tabs, switch, accordion, etc.) — NOT for page/feature UI (use ui-design for that).
name: ui-primitive
---

# UI Primitive Implementation

Build or update a **reusable primitive** in `src/components/ui/` — the shared, appearance-owning building blocks (`Button`, `Tabs`, `DropdownMenu`, …) that feature code composes. These are different from feature UI: a primitive owns a canonical recipe, omits `className`/`style`, and must be correct in isolation.

`$ARGUMENTS` is the component to build or change (e.g. "a Select primitive", "add a Tooltip", "update DropdownMenu to support …").

## Success criteria

- Behavior comes from **Radix UI** (the unified `radix-ui` package); the wrapper owns only CC appearance.
- Implements the **correct WAI-ARIA APG pattern**, with the pattern's APG URL linked in a code comment, implemented to spec.
- Faithful to the CC design system (`cc-design-system` skill) and the authoring contract (`docs/tailwind-conventions.md`): utility-first, `@theme` tokens, `data-*` state, `cn()`, `layoutClassName`-only escape hatch, **no new global CSS, no inline hex/rgb**.
- Passes the `accessibility` skill review + an automated `axe` run + a real keyboard walkthrough.
- Has Storybook stories covering every state/variant, and is **tested live in Storybook the way a user would use it** (keyboard, pointer, screen-reader semantics).
- `bun run typecheck`, `bun run lint`, and the colocated tests are green.

---

## Phase 0 — Confirm the pattern and API BEFORE coding

This is design-first, like `ui-design`. A wrong pattern or API choice is expensive to unwind — confirm it first.

1. **Pick the APG pattern from the actual UI need, not the word the user used.** "Dropdown" is ambiguous: it can mean a Menu Button, a Select/Listbox, or a Combobox — three different APG patterns with different Radix primitives. If the requested pattern doesn't match the need, **say so and propose the right one** (when this skill was first written, "dropdown adhering to the menubar pattern" was really the Menu Button pattern — menubar had no consumer in the app). See the pattern map below.
2. **Choose the API shape.** Default to **composable styled parts** (re-export structural Radix parts as-is, wrap appearance parts) — it matches `Tabs`/`Button`, is idiomatic Radix, and expresses submenus/checkboxes/groups cleanly. A single config-object component is a poorer fit; only use it if the user asks.
3. **Use `AskUserQuestion`** to lock the pattern + API when there's any ambiguity. Present a brief proposal (parts list, visual contract in tokens, stories you'll write). Only build after the user confirms.

### APG pattern → Radix primitive map

Read the linked APG page for the chosen pattern in full before implementing, and link it in the component's header comment.

| Need | APG pattern | Radix primitive |
|---|---|---|
| Button opens a menu of **actions** | [Menu Button](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) | `DropdownMenu` (right-click → `ContextMenu`) |
| Persistent app menu bar (File/Edit/View) | [Menubar](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/) | `Menubar` |
| Pick **one value** from a list | [Combobox (select-only)](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) / [Listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) | `Select` |
| Type-to-filter + pick | [Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) | ⚠️ no native Radix Combobox — escalate (community lib / `Command`) |
| Modal dialog | [Dialog (Modal)](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | `Dialog` (CC already has `ModalShell` — check first) |
| Confirm/destructive prompt | [Alert Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/alertdialog/) | `AlertDialog` |
| Hover/focus hint | [Tooltip](https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/) | `Tooltip` |
| Show/hide one region | [Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) | `Collapsible` |
| Stacked expandable sections | [Accordion](https://www.w3.org/WAI/ARIA/apg/patterns/accordion/) | `Accordion` |
| Tabbed panels | [Tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) | `Tabs` (CC already has `Tabs` — check first) |
| On/off control | [Switch](https://www.w3.org/WAI/ARIA/apg/patterns/switch/) | `Switch` |
| Checkbox / radio group | [Checkbox](https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/) / [Radio](https://www.w3.org/WAI/ARIA/apg/patterns/radio/) | `Checkbox` / `RadioGroup` |
| Range input | [Slider](https://www.w3.org/WAI/ARIA/apg/patterns/slider/) | `Slider` |
| Non-modal floating panel | (compose Dialog/Disclosure semantics) | `Popover` |

Full index: <https://www.w3.org/WAI/ARIA/apg/patterns/>. **Always check `src/components/ui/` first** — if the primitive (or a close one) already exists, update it rather than adding a parallel one.

---

## Phase 1 — Load context (do this in parallel, once)

Read these together before writing anything — it's the efficient prep that avoids rework:

- The **`cc-design-system` skill** (`.claude/skills/cc-design-system/SKILL.md`) — tokens, semantic color, the three-font contract, the critical do/don't rules (incl. the **canonical cyan `:focus-visible` outline**).
- **`docs/tailwind-conventions.md`** — the operational contract: `data-*` state, static class maps, `cn()`, `layoutClassName` allowlist, token-backed arbitrary utilities, guardrails, the four allowlists.
- **The reference primitive: `src/components/ui/DropdownMenu.tsx`** (Radix-backed, the model for this skill) plus `Button.tsx` / `Tabs.tsx` / `IconButton.tsx` for the simpler recipe shape.
- **`src/components/ui/primitives.test.tsx`** and a `*.stories.tsx` (e.g. `Tabs.stories.tsx`, `DropdownMenu.stories.tsx`) for the test + story conventions.
- **Tokens**: `src/features/_root/styles/theme.css` (`@theme`, `--color-*`/`--z-index-*`/`--shadow-*`/`--radius-*`) and `tokens.css` (`--cc-*` parity colors). Grep by **value**, not just name, before assuming a token is missing.
- **`src/components/icons.tsx`** for the SVG set (all `currentColor`, `aria-hidden`).

---

## Phase 2 — Install Radix

Use the **unified package** (one dependency, all primitives) — not the many `@radix-ui/react-*` packages:

```bash
bun add radix-ui
```

```tsx
import { DropdownMenu as RadixDropdownMenu } from "radix-ui";
// RadixDropdownMenu.Root / .Trigger / .Content / .Item / .Portal / ...
```

---

## Phase 3 — Implement (CC primitive rules)

Author per `docs/tailwind-conventions.md`. The non-negotiables for a `ui/` primitive:

- **Parts own appearance and omit `className`/`style`.** Type as `Omit<React.ComponentProps<typeof RadixX>, "className" | "style"> & { layoutClassName?: string }`. The only escape hatch is `layoutClassName` (layout-only: margin, grid/flex placement, order, self-align, width/basis, responsive `hidden` — never color/bg/border/radius/shadow/padding), appended **last** via `cn()`.
- **Radix `data-*` → Tailwind `data-*` variants.** This is the big win: Radix already emits `data-state` (`open`/`closed`/`checked`/`unchecked`), `data-highlighted`, `data-disabled`, `data-side`, `data-orientation`. Select them directly: `data-[state=checked]:bg-cyan-glow`, `data-[highlighted]:bg-[var(--cc-cyan-a08)]`, `data-[disabled]:opacity-40`. No React state mirror needed for these.
- **Static class strings only.** Variants are static maps keyed by a union; compose with `cn()`. Never interpolate (`bg-${x}`). **Never concatenate a string literal with a variable** (`"..." + itemFocus`) — the `no-dynamic-class` guardrail rejects it; inline the literal or pass both as separate `cn()` args. (Literal + literal across lines is allowed.)
- **No two utilities targeting the same CSS property** on one element without mutually-exclusive gating. Example: a checked-vs-highlighted background → `data-[state=checked]:bg-X data-[state=unchecked]:data-[highlighted]:bg-Y` (chained variants), not two unconditional `bg-*`.
- **Colors:** semantic token utilities (`bg-bg-elevated`, `text-text-primary`, `text-red`); for a parity color with no scale entry, use a token-backed **arbitrary utility** `bg-[var(--cc-…)]` / `shadow-[…var(--cc-…)…]` (a `var()` carries no literal → passes `no-hardcoded-color`). **Reuse existing tokens; do not mint new ones** without escalating.
- **Portals:** bake Radix `Portal` into the floating-content wrapper so call sites can't forget it. Set the z-index token (`z-menu` / `z-dropdown` / `z-popover`), `sideOffset`, and `collisionPadding`. Radix's collision-aware positioning replaces hand-rolled viewport math.
- **Overlay coordination:** for any open/close overlay, wire Radix's `onOpenChange` into **`useOverlayScope(open)`** (`@/hooks/useOverlayScope`) so CC's global page-hotkey suppression keeps working (Radix manages focus/Escape/outside-click; the overlay stack is separate). Support controlled + uncontrolled.
- **Motion:** gate entrance animations with `motion-safe:` (e.g. `data-[state=open]:motion-safe:animate-[fadeIn_0.12s_ease]`) — there is no global reduced-motion reset to rely on. Keep it fast/restrained per the design system.
- **Composition:** re-export **structural** parts unchanged (`Trigger`, `Portal`, `Group`, `RadioGroup`, `Sub`); wrap **appearance** parts (`Content`, `Item`, `Label`, `Separator`, `CheckboxItem`/`RadioItem`, `SubTrigger`/`SubContent`). Triggers compose existing primitives via `asChild` + `<Button>`/`<IconButton>` (React 19 forwards the merged ref through their `...rest` spread).
- **Allowlists:** `src/components/ui/**` is **already** in all four allowlists (eslint `MIGRATED_UTILITY_FIRST`, `.prettierrc`, `tailwind-utility-collisions` `UTILITY_FIRST_PATHS`, and a primitive adds no global CSS). No allowlist edits needed — but run `lint` to confirm.

### Link the pattern in code

The component's header comment must name the APG pattern, link its URL, and note what Radix provides vs. what the wrapper owns. Example from `DropdownMenu.tsx`:

```tsx
// Radix-backed menu-button primitive (WAI-ARIA APG "Menu Button" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/). Radix owns behaviour
// (roving focus, type-ahead, arrow/Home/End/Escape, collision positioning,
// outside-click, role/aria wiring); these wrappers own CC appearance via data-* variants.
```

---

## Phase 4 — Unit tests (class contract + genuinely-new logic)

A styled wrapper over a behavior library is largely presentational, but still test the **class contract** (the primitive's guarantee) and any **new logic** (overlay-scope wiring, controlled/uncontrolled, asChild ref merge). Colocate as `ComponentName.test.tsx`.

- The `unit` vitest project is **node env**; opt a DOM test file in with the first line `// @vitest-environment jsdom`.
- `vitest.setup.ts` polyfills `ResizeObserver`/`IntersectionObserver`. Radix menus/popovers also need, at the top of the test file:
  ```tsx
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  ```
- Render **controlled `open` + `modal={false}`** to assert the open content's class contract without simulating pointer/keyboard. Query the portalled content via `screen.getByRole("menu"|"menuitem"|…)` (it lands in `document.body`).
- Assert: item recipe classes, `danger`/`disabled` mapping, checked tint (`data-[state=checked]:…`), `layoutClassName` appended last, **the `:focus-visible` outline class is present**, and the overlay-scope side effect (`isOverlayOpen()` true when open → false when closed). No `vi.mock` of internal modules.

Run: `NODE_ENV=test CLAUDECODE=1 npx vitest run src/components/ui/<Name>.test.tsx --project unit --no-color`

---

## Phase 5 — Storybook stories

Colocate `ComponentName.stories.tsx`, `@storybook/nextjs-vite`, `fn` from **`storybook/test`** (NOT `@storybook/test` — Storybook 10 moved it; typecheck will catch the wrong path). Set `parameters: { a11y: { test: "error" }, layout: "centered" }`.

Cover every state/variant: default, each variant, selection (radio/checkbox), disabled item, submenu/groups/labels, and a **`StaticOpen`/`defaultOpen` story** so the floating surface is reviewable without interaction. Demonstrate composition with `Button`/`IconButton` triggers via `asChild`.

---

## Phase 6 — Test it live, the way a user would

This is required, not optional. The Storybook a11y vitest project is disabled in AI/headless runs, so drive the **running Storybook with Playwright** instead.

1. **Get this worktree's Storybook URL** — never assume a port:
   `mcp__cc-session-tools__ensure_dev_server({ name: "storybook" })` → use the returned `localUrl`.
2. Open a story iframe for clean screenshots: `http://localhost:<port>/iframe.html?id=<title-kebab>--<story-kebab>&viewMode=story` (e.g. `ui-dropdownmenu--selection`).
3. **Exercise it as a user:** Tab to the trigger, Enter/Space/Arrow to open, Arrow/Home/End to navigate, type-ahead, Escape to close (verify focus returns to trigger), hover, click, select. Use `browser_press_key`, `browser_click`, `browser_hover`. Screenshot and `Read` the PNG to judge appearance. (Element-targeted screenshots **crop outlines** that sit outside the box — use a viewport screenshot to see focus rings.)
4. **Introspect with `browser_evaluate`** — confirm real behavior, not just looks:
   ```js
   () => { const el = document.activeElement; const cs = getComputedStyle(el);
     return { role: el.getAttribute('role'), focusVisible: el.matches(':focus-visible'),
              outline: `${cs.outlineWidth} ${cs.outlineStyle} ${cs.outlineColor}` }; }
   ```
5. **Run axe live** (works even though the vitest a11y project is off) — open the component, then:
   ```js
   async () => {
     if (!window.axe) { await new Promise((res, rej) => { const s = document.createElement('script');
       s.src = 'https://cdn.jsdelivr.net/npm/axe-core@4/axe.min.js'; s.onload = res; s.onerror = rej;
       document.head.appendChild(s); setTimeout(() => rej(new Error('timeout')), 8000); }); }
     const r = await window.axe.run(document, { runOnly: ['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'] });
     return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target.join(' ')) }));
   }
   ```
   Triage each hit: confirm whether it's **your component** vs. a **pre-existing/global** element (e.g. CC's `.tooltip-portal`) vs. a **Storybook-iframe artifact** (`bypass` with no `<main>`). Fix yours; report the rest, don't silently absorb them.

---

## Phase 7 — Accessibility pass

Invoke the **`accessibility` skill** and run its checklist against the component. The CC-specific items that bit the dropdown build (check every one):

- **Keyboard focus indicator (2.4.7 / 1.4.11).** Radix moves real DOM focus (roving), so `:focus-visible` matches on keyboard nav. Do **not** rely on a faint highlight tint alone (a ~1.2:1 background change is not a sufficient indicator). Items get `outline-none` + `focus-visible:[outline:2px_solid_var(--color-cyan)]` (inset offset inside the menu padding); triggers get the canonical cyan outline from `Button`/`IconButton`.
- **`modal` default.** Radix's default `modal={true}` `aria-hidden`s the page behind the overlay (incl. the focusable trigger) → axe `aria-hidden-focus`. For menus/popovers default **`modal={false}`** (also no scroll-lock; matches CC) and keep it overridable. Reserve `modal` for true blocking dialogs.
- **Contrast on the surface it actually renders on (1.4.3).** CC's muted text (`--text-secondary` #7b899f ≈ 4.2:1, `--text-tertiary` #738699 ≈ 4.0:1) **fails AA 4.5:1 on the lightest `bg-elevated`** overlay surface (it passes on darker `bg-surface`). Verify Label/description/shortcut text against the menu surface with axe; if it fails, escalate as a token/design-system decision (don't reshape the palette from inside a primitive).
- **Names:** icon-only triggers need `aria-label`; decorative SVGs `aria-hidden` (CC icons already are); overlay content is labelled by its trigger (`aria-labelledby`) automatically — verify.
- **Target size (2.5.8):** interactive rows/triggers ≥ 24px (44px comfortable on mobile).
- **Reduced motion (2.3.3):** entrance animation gated with `motion-safe:`.

---

## Phase 8 — Gates + review

- `bun run typecheck` · `bun run lint` · the colocated tests — all green.
- Present: the chosen APG pattern + why, the parts/API, tokens used, **before/after or live screenshots**, the axe result, and any deferred/out-of-scope findings (e.g. global or design-system issues). For a brand-new primitive, do **not** migrate existing call sites in the same pass unless asked — ship the primitive + stories for review first.

---

## Hard-won gotchas (from the DropdownMenu build)

- Pattern mismatch is the #1 risk — resolve "which APG pattern" before anything else.
- `radix-ui` unified package; `import { X as RadixX } from "radix-ui"`.
- `fn` imports from **`storybook/test`**, not `@storybook/test`.
- `no-dynamic-class` rejects `literal + variable` — inline the literal or use `cn()` args.
- Tailwind silently drops malformed arbitrary variants — verify `data-*`/arbitrary variants actually emit (computed style or screenshot), don't assume.
- `src/components/ui/**` is pre-registered in all four guardrail allowlists — no allowlist edits for a primitive (verify with `lint`).
- Reuse tokens by value before minting; minting/palette changes are escalations, not in-primitive decisions.
- Live-verify with Playwright + injected axe; the storybook vitest a11y project does not run in AI/headless mode.
