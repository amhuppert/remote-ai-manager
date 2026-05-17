---
name: cc-design-system
description: This skill should be used when designing, building, or reviewing any Command Center (CC) user interface — pages, components, screens, prototypes, or design changes. Covers visual tokens (colors, typography, spacing, radii, layout constants), component class contracts, iconography, motion, atmospherics, and content/voice rules. Triggers on phrases like "build a page", "design a component", "design system", "tokens", "what color/font/spacing should I use", "is this on-brand", "review the styling", or anytime new CSS / components / chrome is being written for CC.
---

# Command Center Design System

## Vision

Command Center is "air traffic control for Claude Code." The UI must feel like an operator's console: high signal, low ceremony, every pixel earning its place. Visual posture is **dense, technical, terse**. The void color sits flat under everything; atmosphere comes from two subtle overlays (noise grain + scan lines) and from accent glows, never from images or background gradients.

The system is **monochrome-dark with semantic accents** (cyan = active, amber = awaiting, green = success, red = destructive, violet = Codex agent identity). Surfaces step through six elevation levels; hover always moves up one level, never skipping. Typography is mono-by-default; body prose font is reserved for conversation messages only.

When a new screen or component is needed, reach for existing tokens and `.cc-*` canonical patterns first. New tokens or one-off styles are smells — almost always there's already a recipe.

---

## Critical rules

These are non-negotiable. Breaking any of them creates regressions.

### Don't

- **Never use `#000` for backgrounds.** The page background is always `--bg-void` (`#06090f`).
- **Never use emoji, PNG icons, or color icons.** SVG-only, 1.5 stroke, currentcolor inheritance. See `references/iconography.md`.
- **Never use Manrope (`--font-body`) outside conversation message prose.** Everything else — buttons, labels, metadata, chrome — is `--font-mono` (Geist Mono).
- **Never use a full cyan background for "selected" states on rows or items.** Cyan-as-bg is reserved for primary buttons and active `.cc-tab`. Use elevation + border for selection elsewhere.
- **Never use rainbow (`.cc-rainbow-*`) for anything other than max-class reasoning effort.** It signals "exceeds the scale" precisely because it doesn't belong to any agent or status.
- **Never use `--text-secondary` or `--text-tertiary` as the rest state of interactive text.** On hover, promote to `--text-primary`.
- **Never use `--violet` for anything other than Codex agent identity.** It is brand-load-bearing.
- **Never use `outline: none` without a replacement focus ring.** Cyan border + cyan glow on inputs; always visible.
- **Never skip elevation levels on hover.** Bg moves up exactly one step.
- **Never invent half-step radii** (no `5px`, `7px`, etc.). Use `--radius-sm/md/lg` or `9999px` for pills.
- **Never paraphrase domain terms.** *Session, conversation, worktree, branch, prompt, diff, fork, finalize* — exact meanings.
- **Never write marketing copy.** No exclamation marks, no rhetorical questions, no "Welcome!", no emoji. Operator tone only.
- **Never use "1 session" / "0 sessions" inline copy.** Counts are raw numerals with UPPERCASE labels below.
- **Never hide actions behind hover-only.** Every action must also be reachable via keyboard and touch.

### Do

- **Use `[data-*]` attributes for layout/state, not classes.** `data-layout`, `data-agent`, `data-status`, `data-composer-focused`. Classes are for appearance only.
- **Use the `.cc-*` typography helper layer** (`.cc-page-title`, `.cc-section-label`, `.cc-meta-label`, `.cc-prose`, etc.) for new screens. Per-selector inlining is acceptable for existing surfaces.
- **Use `var(--space-*)` always** — never literal pixel values in margin/padding.
- **Use BEM modifiers on `.cc-badge`** — `.cc-badge--status`, `.cc-badge--type`, `.cc-badge--count`, `.cc-badge--subtle`.
- **Make icon-only buttons accessible** — `aria-label` + `data-tooltip` on every one.
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
- **No toolbars.** Controls sit inside the contexts they apply to.
- **Progressive density.** As viewport shrinks, hide ornament and metadata before structural elements.
- **Press uses background, not transform.** Cards do `translateY(-1px)` on hover, then return. The only positional motion.
- **Animation is fast and restrained.** `0.15s ease` interactions, `0.2s ease` entries, `0.25s ease` layout. No bouncy easing, no spring overshoot.
- **`prefers-reduced-motion` halts the rainbow gradient and degrades live-state pulses to static.**
- **Responsive ≠ stripped.** Mobile views show the same information density per panel; just one panel at a time.

---

## Reference routing

Load the relevant reference file when working on a specific surface. Don't load all of them — only what the current task needs.

| File | Load when |
|---|---|
| [`references/tokens.md`](references/tokens.md) | You need exact hex values, full color tables, complete size tiers, all spacing aliases, or the rainbow gradient stops. Also: token naming conventions for new additions. |
| [`references/components.md`](references/components.md) | You're building or modifying a component. Covers foundation classes (`.btn`, `.status-dot`, `.prompt-input`, `.modal-*`), canonical `.cc-*` patterns (`.cc-tabs`, `.cc-section-header`, `.cc-badge--*`), composite components (`.project-card`, `.sessions-table`, `.session-info-strip`, etc.), the card recipe, hover/press states, and the Codex agent variant. |
| [`references/iconography.md`](references/iconography.md) | You're adding, replacing, or selecting an icon. Covers the canonical icon set, SVG conventions (1.5 stroke, currentcolor), sizing inside buttons, unicode-glyph rules, and the substitution policy (hand-drawn → Lucide → unicode). |
| [`references/motion-and-atmospherics.md`](references/motion-and-atmospherics.md) | You're touching animation, hover effects, atmospheric overlays (noise/scan lines), frosted glass, shadows, glows, or the rainbow gradient surfaces. |
| [`references/content-and-voice.md`](references/content-and-voice.md) | You're writing UI copy — button labels, empty states, dialog titles, confirmations, microcopy. Covers voice, casing rules (sentence case / UPPERCASE MONO / lowercase mono), person & address, microcopy patterns (IDs, counts, null values, time format). |
