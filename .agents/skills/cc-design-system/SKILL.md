---
name: cc-design-system
description: Apply Command Center visual conventions when designing,
  implementing, or reviewing UI; consult focused references for tokens,
  components, icons, motion, or UI copy.
---

# Command Center Design System

## Vision

Command Center is an operator console for AI coding agents. The UI must feel like an operator's console: high signal, low ceremony, every pixel earning its place. Visual posture is **dense, technical, terse**. The void color sits flat under everything; atmosphere comes from two subtle overlays (noise grain + scan lines) and from accent glows, never from images or background gradients.

The system is **monochrome-dark with semantic accents** (cyan = active, amber = awaiting, green = success, red = destructive, violet = Codex agent identity). Surfaces step through six elevation levels; hover always moves up one level, never skipping. Typography is mono-by-default; body prose font is reserved for conversation messages only.

When a new screen or component is needed, reach for the **`@theme` tokens, Tailwind utilities, and the `src/components/ui/` primitives** first. New tokens or one-off styles are smells — almost always there's already a token, a utility, or a primitive recipe.

---

## Authoring model: Tailwind utility-first

CC is migrated to **Tailwind v4 as the authoring mechanism over its existing token
system** — same visual language, different mechanics. The full operational contract
is `docs/tailwind-conventions.md`; the essentials:

- **Utilities, not new CSS.** New and migrated UI is written as Tailwind utility
  classes (layout + appearance) backed by the CC tokens. Do **not** add feature
  CSS files; the `no-unapproved-global-css` guardrail rejects new stylesheets
  outside the foundation/vendor areas. Consult `docs/tailwind-conventions.md`
  for migration boundaries and the CSS inventory for remaining owners.
- **Tokens are `@theme`.** Every CC token is exposed in
  `src/features/_root/styles/theme.css` under a Tailwind namespace, so a utility
  generates for it: colors under `--color-*` → `bg-*`/`text-*`/`border-*`
  (text colors are `--color-text-*`, e.g. `text-text-primary`); spacing
  `--spacing-*` → `p-*`/`m-*`/`gap-*`; radii `--radius-*` → `rounded-*`; fonts
  `--font-*` → `font-display/body/mono`; plus `--z-index-*`, `--breakpoint-*`
  (desktop-first `max-*` variants), `--animate-*`. The alias bridge is collapsed —
  `theme.css` holds literal values; the legacy `var(--…)` names stay in `tokens.css`
  for preserved CSS. See `references/tokens.md`.
- **React primitives own canonical recipes.** `Button`, `Badge`, `StatusDot`,
  `Tabs`, `SectionHeader`, `Dialog`, `AlertDialog`, `IconButton`, `EmptyState`, `FormField`
  (`src/components/ui/`) emit pure utilities and **omit `className`/`style`** so a
  call site cannot inject appearance. Layout-only geometry goes through their
  `layoutClassName` escape hatch. See `references/components.md`.
- **`cn()` composes; state is `data-*`.** Compose conditional classes with
  `cn()` (`src/lib/ui/cn.ts`, a `clsx` wrapper) — every argument is a complete
  static string. Encode appearance variants as **static class maps** keyed by a
  union; encode component **state** as `data-*` attributes selected by `data-*`
  variants. Never build a class name by interpolation (`bg-${x}` is rejected by
  the guardrails and may not even be generated).
- **Token-backed arbitrary utilities for parity colors.** When zero-visual-change
  parity needs a color with no token (e.g. a custom-alpha glow), the value lives
  as a `--cc-*` token in `tokens.css` and is referenced via
  `bg-[var(--cc-…)]` / `shadow-[…var(--cc-…)…]` — a `var()` inside an arbitrary
  utility carries no literal, so it passes `no-hardcoded-color`. Never inline a raw
  `#hex`/`rgb()`/`rgba()` in a class string.
- **Preflight is not imported.** CC's `reset.css` is the reconciled canonical base
  reset. One standing consequence: a single-side border needs the other sides
  zeroed explicitly (`border-x-0 border-b-0 border-t …`) because no global border
  reset is loaded.

### Existing CSS and migration boundaries

CSS for generated/vendor DOM, rendered markdown, base reset, and atmospheric pseudo-elements remains where utilities cannot own that DOM. Check `docs/tailwind-conventions.md` and `scripts/css-inventory.ts` and its generated `docs/reports/css-inventory.md` (`bun run css:inventory` when the report is absent) before converting a surface. Use current primitives for new JSX; the presence of a legacy recipe does not make it the authoring path.

Keep an element under one styling owner. When migrating an element, account for legacy descendant selectors that still target it: unlayered legacy CSS wins over layered utilities even when the utility has greater specificity.

---

## Critical rules

These are non-negotiable. Breaking any of them creates regressions.

### Don't

- **Never use `#000` for backgrounds.** The page background is always `--bg-void` (`#06090f`).
- **Never use emoji, PNG icons, or color icons.** SVG-only, 1.5 stroke, currentcolor inheritance. See `references/iconography.md`.
- **Never use Manrope (`--font-body`) outside conversation message prose.** Everything else — buttons, labels, metadata, chrome — is `--font-mono` (Geist Mono).
- **Never use a full cyan background for "selected" states on rows or items.** Cyan-as-bg is reserved for primary buttons and active `.cc-tab`. Use elevation + border for selection elsewhere.
- **Never use rainbow (`.cc-rainbow-*`) for anything other than max-class reasoning effort.** It signals "exceeds the scale" precisely because it doesn't belong to any agent or status.
- **Match the primitive's text-state recipe and verify contrast on its actual surface.** Where subdued text is used at rest, promote it on hover/focus; color changes alone do not replace a visible focus indicator.
- **Never use `--violet` for anything other than Codex agent identity.** It is brand-load-bearing.
- **Never use `outline: none` without a replacement focus ring.** Keyboard focus is always visible — use the canonical cyan focus outline (see "Do"). Never leave the browser default (blue) outline on a control; it clashes with the control's own border.
- **Never skip elevation levels on hover.** Bg moves up exactly one step.
- **Never invent half-step radii** (no `5px`, `7px`, etc.). Use `--radius-sm/md/lg` or `9999px` for pills.
- **Never paraphrase domain terms.** *Session, conversation, worktree, branch, prompt, diff, fork, finalize* — exact meanings.
- **Never write marketing copy.** No exclamation marks, no rhetorical questions, no "Welcome!", no emoji. Operator tone only.
- **Never use "1 session" / "0 sessions" inline copy.** Counts are raw numerals with UPPERCASE labels below.
- **Never hide actions behind hover-only.** Every action must also be reachable via keyboard and touch.

### Do

- **Use `[data-*]` attributes for state.** `data-layout`, `data-agent`, `data-status`, `data-composer-focused`. Select them with Tailwind `data-*` variants (`data-[status=running]:…`) mapped through static class maps. Appearance is utilities; never compute a class string at runtime.
- **Use Tailwind text utilities + primitives for new screens** — `font-display/body/mono`, the `text-text-*` colors, and the size tiers (`references/tokens.md`). The old `.cc-*` typography helpers (`.cc-page-title`, `.cc-prose`, …) were deleted in the migration; use `SectionHeader` for section labels rather than depending on historical recipe classes.
- **Use spacing utilities** (`p-*`/`m-*`/`gap-*`, backed by `--spacing-*`) in migrated/new UI; `var(--space-*)` remains only inside preserved CSS. Never literal pixel values for margin/padding.
- **Use `StatusChip` for tone-coded lifecycle/status pills**, as required by the root UI contract. Use `Badge` for other badge treatments such as type/count/subtle; inspect current props rather than reviving legacy `.cc-badge*` classes.
- **Make icon-only buttons accessible** — `aria-label` plus the `WithTooltip`/`Tooltip` primitive for its visible hint.
- **Keyboard focus is a cyan outline.** The canonical `:focus-visible` indicator for interactive controls (buttons, icon buttons, menu/dropdown triggers, tabs) is a **2px solid `--cyan` outline at `outline-offset: 2px`** — the `Button`/`IconButton` primitives emit it (`focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2`). Two exceptions keep their established treatments: **inputs/textareas** show a cyan **border + glow** focused appearance (`focus:border-cyan` + `0 0 0 3px var(--cyan-glow)`), and **menu/listbox items** use an inset cyan focus outline alongside the `data-highlighted` background (see `src/components/ui/menu-recipe.ts`).
- **Make actions imperative; state declarative.** Buttons say `Merge`, `Archive`. Status says `Running`, `Awaiting input`.

---

## Foundation at a glance

### Color families (full palette in `references/tokens.md`)

- **Backgrounds (6 levels):** `--bg-void` → `--bg-base` → `--bg-surface` → `--bg-raised` → `--bg-elevated` → `--bg-hover`. Recessed to elevated.
- **Borders (4 intensities):** `--border-dim` → `--border-subtle` → `--border-default` → `--border-strong` (hover/focus only).
- **Text (4 levels):** `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-inverse`.
- **Accents:** `--cyan` (active/primary), `--amber` (awaiting), `--green` (success/merged), `--red` (destructive/error), `--blue` (reserved), `--violet` (Codex identity). Each has `-dim`, `-glow`, and select `-glow-strong` / `-glow-text` variants.

### Typography

- `--font-display` — Anybody (page titles, modals, `CC` logo, empty-state titles).
- `--font-body` — Manrope (conversation message prose ONLY).
- `--font-mono` — Geist Mono (everything else: chrome, labels, code, data).

Size floor: `0.7rem`. Five tiers from 0.7 → 0.9rem; display starts at 1.0rem+.

### Spacing scale

`2px (2xs) / 4px (xs) / 8px (sm) / 12px (md) / 16px (lg) / 24px (xl) / 32px (2xl) / 48px (3xl)`.

Semantic aliases: `--space-section` (xl), `--space-header-content` (sm), `--space-item` (xs).

### Layout constants

- **Topbar:** 48px.
- **Sidebar:** 308px (desktop) / 280px (≤960px).
- **Right pane:** 340px.
- **Tabs strip:** 36px.
- **Radii:** `--radius-sm:4px / --radius-md:6px / --radius-lg:10px`. Pills use `9999px`.
- **Icon-in-button ratio:** 60% (18px icon in 30px button; 26px icon in 44px touch target).

### Breakpoints

- **≤1180px** — right pane hides; content collapses to single column.
- **≤1080px** — topbar crumbs shrink; fleet counter hides.
- **≤960px** — topbar status hides; sidebar shrinks to 280px.
- **≤768px** — mobile single-panel mode; bottom toolbar appears.

---

## Layout & interaction rules

- **Topbar-only navigation.** No persistent left-rail nav outside dedicated content panels.
- **Keep controls in context.** Toolbars and action groups belong with the content they operate on; the mobile bottom toolbar is an established layout pattern.
- **Progressive density.** As viewport shrinks, hide ornament and metadata before structural elements.
- **Press uses background, not transform.** Cards do `translateY(-1px)` on hover, then return. Avoid adding unrelated positional motion; existing entry/expansion animations are documented in the motion reference.
- **Animation is fast and restrained.** `0.15s ease` interactions, `0.2s ease` entries, `0.25s ease` layout. No bouncy easing, no spring overshoot.
- **`prefers-reduced-motion` halts the rainbow gradient and degrades live-state pulses to static.**
- **Responsive ≠ stripped.** Mobile views show the same information density per panel; just one panel at a time.

---

## Reference routing

Load the relevant reference file when working on a specific surface. Don't load all of them — only what the current task needs.

| File | Load when |
|---|---|
| [`docs/tailwind-conventions.md`](../../../docs/tailwind-conventions.md) | You're **authoring or migrating UI** — the operational contract for utilities, primitives, `cn()`, `data-*` state, `layoutClassName`, `max-*` breakpoints, the token-backed-arbitrary-utility parity pattern, the guardrails, and the preserved-CSS catalog. Read this before writing any new component. |
| [`references/tokens.md`](references/tokens.md) | You need exact hex values, full color tables, complete size tiers, all spacing aliases, the rainbow gradient stops, or the **legacy-token → `@theme` namespace → utility** mapping. Also: token naming conventions for new additions. |
| [`references/components.md`](references/components.md) | You're building or modifying a component. Covers the `ui/` primitives (Button/IconButton/Badge/Tabs/StatusDot/EmptyState/FormField/SectionHeader/Dialog/AlertDialog) and the visual contract (colors/states) they reproduce, composite surfaces (`.project-card`, `.sessions-table`, `.session-info-strip`, etc.), the card recipe, hover/press states, and the Codex agent variant. |
| [`references/iconography.md`](references/iconography.md) | You're adding, replacing, or selecting an icon. Covers the canonical icon set, SVG conventions (1.5 stroke, currentcolor), sizing inside buttons, unicode-glyph rules, and the substitution policy (hand-drawn → Lucide → unicode). |
| [`references/motion-and-atmospherics.md`](references/motion-and-atmospherics.md) | You're touching animation, hover effects, atmospheric overlays (noise/scan lines), frosted glass, shadows, glows, or the rainbow gradient surfaces. |
| [`references/content-and-voice.md`](references/content-and-voice.md) | You're writing UI copy — button labels, empty states, dialog titles, confirmations, microcopy. Covers voice, casing rules (sentence case / UPPERCASE MONO / lowercase mono), person & address, microcopy patterns (IDs, counts, null values, time format). |
