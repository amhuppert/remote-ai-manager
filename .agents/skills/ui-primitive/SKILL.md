---
description: Implement or change shared UI primitives in src/components/ui/,
  with the appropriate accessibility pattern, Storybook states, and live
  keyboard/axe verification. For page UI, use the design system and
  ui-design-autonomy; /ui-design is the explicit proposal workflow.
name: ui-primitive
---

# UI Primitive Implementation

Build or update a **reusable primitive** in `src/components/ui/` — the shared, appearance-owning building blocks (`Button`, `Tabs`, `DropdownMenu`, …) that feature code composes. These are different from feature UI: a primitive owns a canonical recipe, omits `className`/`style`, and must be correct in isolation.

`$ARGUMENTS` is the component to build or change (e.g. "a Select primitive", "add a Tooltip", "update DropdownMenu to support …").

## Success criteria

- Use **Radix UI** from the installed unified `radix-ui` package for supported interaction patterns; retain the existing implementation approach for primitives without a corresponding Radix behavior.
- Implements the **correct WAI-ARIA APG pattern**, with the pattern's APG URL linked in a code comment, implemented to spec.
- Faithful to the CC design system (`cc-design-system` skill) and the authoring contract (`docs/tailwind-conventions.md`): utility-first, `@theme` tokens, `data-*` state, `cn()`, `layoutClassName`-only escape hatch, **no new global CSS, no inline hex/rgb**.
- Passes the `accessibility` skill review + an automated `axe` run + a real keyboard walkthrough.
- Has Storybook stories covering every state/variant, and is **tested live in Storybook the way a user would use it** (keyboard, pointer, screen-reader semantics).
- The registered typecheck, lint, and focused test validations pass.

---

## Phase 0 — Resolve the pattern and API

Establish the intended pattern from the user flow and existing consumers. Preserve an already approved API; routine updates within that contract do not require another design gate.

1. **Pick the APG pattern from the actual UI need, not the word the user used.** "Dropdown" is ambiguous: it can mean a Menu Button, a Select/Listbox, or a Combobox — three different APG patterns with different Radix primitives. If the requested pattern doesn't match the need, **say so and propose the right one**. See the pattern map below.
2. **Choose the API shape.** Default to **composable styled parts** (re-export structural Radix parts as-is, wrap appearance parts) — it matches `Tabs`/`Button`, is idiomatic Radix, and expresses submenus/checkboxes/groups cleanly. Use an existing config API where it already fits the consumers; introducing a new shape needs a concrete benefit.
3. **Use `cctl ask`** when missing intent leaves a consequential choice between interaction patterns or public APIs. Present a concrete recommendation and the tradeoff, then follow the async end-turn instruction. If the user already settled the choice, continue implementation. The explicit `/ui-design` review gates apply only when that workflow is invoked.

### APG pattern → Radix primitive map

Read the linked APG page for the chosen pattern in full before implementing, and link it in the component's header comment.

| Need | APG pattern | Radix primitive |
|---|---|---|
| Button opens a menu of **actions** | [Menu Button](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/) | `DropdownMenu` (right-click → `ContextMenu`) |
| Persistent app menu bar (File/Edit/View) | [Menubar](https://www.w3.org/WAI/ARIA/apg/patterns/menubar/) | `Menubar` |
| Pick **one value** from a list | [Combobox (select-only)](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) / [Listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) | `Select` |
| Type-to-filter + pick | [Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) | No native Radix Combobox; inspect CC `Autocomplete` before choosing an implementation |
| Modal dialog | [Dialog (Modal)](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | `Dialog` (CC already has styled `Dialog` parts — check first) |
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

## Phase 2 — Use the installed Radix package

CC already depends on the **unified `radix-ui` package**. Check the installed version/API; an ordinary primitive change does not require reinstalling or upgrading it.

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
- **Allowlists:** `src/components/ui/**` is **already** in all four allowlists (eslint `MIGRATED_UTILITY_FIRST`, `.prettierrc`, `tailwind-utility-collisions` `UTILITY_FIRST_PATHS`, and a primitive adds no global CSS). No allowlist edits needed — but run the registered lint validation to confirm.

### Link the pattern in code

The component's header comment must name the APG pattern, link its URL, and note what Radix provides vs. what the wrapper owns. Example from `DropdownMenu.tsx`:

```tsx
// Radix-backed menu-button primitive (WAI-ARIA APG "Menu Button" pattern:
// https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/). Radix owns behaviour
// (roving focus, type-ahead, arrow/Home/End/Escape, collision positioning,
// outside-click, role/aria wiring); these wrappers own CC appearance via data-* variants.
```

---

## Phase 4 — Focused behavior tests

Test meaningful wrapper behavior: controlled/uncontrolled transitions, overlay-scope registration and cleanup, accessible naming, or composition/ref handling when changed. Reuse existing colocated test setup. Follow `docs/tailwind-conventions.md`: appearance is verified through Storybook and browser checks, not permanent tests that mirror Tailwind class strings.

Ordinary tests run in Node; DOM tests opt in with `// @vitest-environment jsdom`. Follow `.kiro/steering/tech.md#test-execution-profiles` for profile membership. Add only browser API shims the tested interaction needs, following neighboring tests, and restore modified globals. Internal project modules use dependency injection rather than `vi.mock()`.

Run the focused test file through the project's registered validation commands, requiring a match for a scoped run. A passing test with zero selected files proves nothing.

---

## Phase 5 — Storybook stories

Colocate `ComponentName.stories.tsx`, `@storybook/nextjs-vite`, `fn` from **`storybook/test`** (NOT `@storybook/test` — Storybook 10 moved it; typecheck will catch the wrong path). Set `parameters: { a11y: { test: "error" }, layout: "centered" }`.

Cover every state/variant: default, each variant, selection (radio/checkbox), disabled item, submenu/groups/labels, and a **`StaticOpen`/`defaultOpen` story** so the floating surface is reviewable without interaction. Demonstrate composition with `Button`/`IconButton` triggers via `asChild`.

---

## Phase 6 — Test it live, the way a user would

This is required, not optional. The Storybook a11y vitest project is disabled in AI/headless runs, so drive the **running Storybook with Playwright** instead.

1. **Get this worktree's Storybook URL** — never assume a port:
   run `cctl dev ensure storybook` → use the printed `localUrl`.
2. Open a story iframe for clean screenshots: `http://localhost:<port>/iframe.html?id=<title-kebab>--<story-kebab>&viewMode=story` (e.g. `ui-dropdownmenu--selection`).
3. **Exercise it as a user:** Tab to the trigger, Enter/Space/Arrow to open, Arrow/Home/End to navigate, type-ahead, Escape to close (verify focus returns to trigger), hover, click, select. Use the available browser tools or `playwright-cli` with their current schemas. Capture and open the screenshot to judge appearance. (Element-targeted screenshots **crop outlines** that sit outside the box — use a viewport screenshot to see focus rings.)
4. **Introspect with a browser evaluation tool** — confirm real behavior, not just looks:
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

- Discover the registered commands with `cctl validate list`; run the relevant typecheck, lint, and focused tests through `cctl validate run <name> --json`. For scoped tests, pass `--require-match` with the supported selection flags. Read current help for exact command syntax.
- Present: the chosen APG pattern + why, the parts/API, tokens used, **before/after or live screenshots**, the axe result, and any deferred/out-of-scope findings (e.g. global or design-system issues). For a brand-new primitive, do **not** migrate existing call sites in the same pass unless asked — ship the primitive + stories for review first.

---

## Completion boundary

Keep verification proportional to the changed primitive: exercise affected states, the relevant keyboard pattern, live accessibility checks, and required project checks. Once these pass, repeat or broaden only for a change, failure, or unresolved concern. Report any unavailable browser or accessibility tooling as an explicit verification limit.
