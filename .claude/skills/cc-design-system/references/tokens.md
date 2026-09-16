# Tokens

Design reference for color, typography, spacing, radii, and layout constants. Verify exact values and utility names in the current CSS sources before editing a token.

The executable token definitions are the source of truth for exact values. They are exposed to Tailwind through `@theme` in `src/features/_root/styles/theme.css` (which now carries the **literal** values directly — the alias bridge is collapsed), while the same values keep their legacy `var(--…)` names in `src/features/_root/styles/tokens.css` for the preserved CSS that still reads them.

---

## `@theme` namespaces → utilities

When authoring UI, reach for the **utility** (not the raw `var(--…)`). Each token sits under a Tailwind namespace so a utility generates for it:

| Token family (design name) | `@theme` namespace | Utilities generated | Notes |
|---|---|---|---|
| Backgrounds `--bg-*` | `--color-bg-*` | `bg-bg-void`, `bg-bg-surface`, … | |
| Borders `--border-*` | `--color-border-*` | `border-border-subtle`, … | |
| Accents `--cyan/amber/green/blue/red/violet` (+ `-dim/-glow/-glow-strong/-glow-text`) | `--color-*` | `bg-cyan`, `text-red`, `border-amber`, `ring-cyan-glow`, … | |
| **Text colors** `--text-primary/secondary/tertiary/inverse` | `--color-text-*` | `text-text-primary`, `bg-text-inverse`, … | Under `--color-text-*`, **never** `--text-*` (Tailwind v4 reads `--text-*` as a font-size scale). |
| Rainbow glows | `--color-rainbow-glow*` | `bg-rainbow-glow`, … | The rainbow **gradient** is `--background-image-rainbow` / `-rainbow-tint` → `bg-rainbow` / `bg-rainbow-tint`. |
| Spacing `--space-*` (+ semantic `section/header-content/item`) | `--spacing-*` | `p-*`, `m-*`, `gap-*` (`p-md`, `gap-sm`, `px-xl`, …) | |
| Radii `--radius-sm/md/lg` | `--radius-*` (`@theme inline`) | `rounded-sm/md/lg` | `inline` because the name collides with the legacy `--radius-*`. Pills stay `rounded-[9999px]`. |
| Fonts `--font-display/body/mono` | `--font-*` (`@theme inline`) | `font-display`, `font-body`, `font-mono` | Resolve through the `next/font` `var(--font-anybody/manrope/geist-mono)` runtime refs. |
| Sizing floors | `--cc-size-floor-{font,icon,icon-btn,touch}` | _(none — minimums, not a scale)_ | The legibility-floor guarantee asserts against these (`design-system-guarantees.test.ts`). |
| z-index tiers | `--z-index-*` | `z-*` (`z-dropdown`, `z-tooltip`, …) | Ordered named bands; namespace is `--z-index-*` (generates `z-*`), not `--z-*`. |
| Breakpoints | `--breakpoint-*` | desktop-first `max-*` variants | `max-640/768/800/900/960/1080/1100/1180` + `min-769` companion. Registered as inclusive `@media (max-width:…)`; **not** inverted to mobile-first. |
| Shared animations | `--animate-{pulse-dot,fade-in,bulk-float-in}` | `animate-pulse-dot`, … | Only shared JSX-authored keyframes are tokenized; graph/atmospheric/vendor `@keyframes` stay bespoke in preserved CSS. |
| Drop shadows | `--shadow-dropdown` / `--shadow-menu` | `shadow-dropdown` / `shadow-menu` | Canonical popover/menu black drop shadow. |

For a parity color that has **no** token, mint a `--cc-*` token in `tokens.css` (token-owner context only) and reference it via a token-backed arbitrary utility — `bg-[var(--cc-…)]` — which passes the `no-hardcoded-color` guardrail. Never inline a raw color literal in a class string. See `docs/tailwind-conventions.md §8.3`.

---

## Color

### Backgrounds — 6-level elevation

| Token | Value | Use |
|---|---|---|
| `--bg-void` | `#06090f` | Page background only. Never `#000`. |
| `--bg-base` | `#0b1019` | Recessed surfaces: inputs, code blocks, idle cards. |
| `--bg-surface` | `#111825` | Default surfaces: cards, panels, modals. |
| `--bg-raised` | `#172033` | Tooltips, branch chips, active card surface. |
| `--bg-elevated` | `#1a2740` | Hover on items inside surfaces. |
| `--bg-hover` | `#1c2841` | Hover on surface-level elements. |

Hover steps up exactly one level. Never skip.

### Borders — 4 intensities

| Token | Value | Use |
|---|---|---|
| `--border-dim` | `#141d2e` | Lightest separator. |
| `--border-subtle` | `#1a2338` | Default cards and panels at rest. |
| `--border-default` | `#243048` | Stronger separation; active card. |
| `--border-strong` | `#2e3d5c` | Hover and focus only. Never at rest. |

1px solid. Never thicker, except diff lines (3px left-border encoding add / remove / context).

### Accents

| Family | Token | Value |
|---|---|---|
| Cyan (primary) | `--cyan` | `#00e5ff` |
|  | `--cyan-dim` | `#00b8cc` |
|  | `--cyan-glow` | `rgba(0, 229, 255, 0.15)` |
|  | `--cyan-glow-strong` | `rgba(0, 229, 255, 0.30)` |
|  | `--cyan-glow-text` | `rgba(0, 229, 255, 0.60)` |
| Amber | `--amber` | `#ffb300` |
|  | `--amber-dim` | `#cc8f00` |
|  | `--amber-glow` | `rgba(255, 179, 0, 0.15)` |
| Green | `--green` | `#00e676` |
|  | `--green-dim` | `#00b85c` |
|  | `--green-glow` | `rgba(0, 230, 118, 0.15)` |
| Blue | `--blue` | `#448aff` |
|  | `--blue-dim` | `#2979ff` |
|  | `--blue-glow` | `rgba(68, 138, 255, 0.15)` |
| Red | `--red` | `#ff3d5a` |
|  | `--red-dim` | `#cc3148` |
|  | `--red-glow` | `rgba(255, 61, 90, 0.12)` |
|  | `--red-text` | `#e8506c` (use as text color where 4.5:1 contrast is required) |
| Violet (Codex identity, reserved) | `--violet` | `#c77dff` |
|  | `--violet-dim` | `#9d56d6` |
|  | `--violet-glow` | `rgba(199, 125, 255, 0.15)` |
|  | `--violet-glow-strong` | `rgba(199, 125, 255, 0.30)` |

### Semantic color mappings

| Color | Meaning |
|---|---|
| Cyan | Active, running, primary action, focus. |
| Amber | Awaiting input from the user. |
| Green | Success, merged, done. |
| Blue | Reserved; rarely used. |
| Red | Destructive, error. |
| Violet | Codex agent identity. Reserved. |

### Text — 4 levels

| Token | Value | Use |
|---|---|---|
| `--text-primary` | `#dce2f0` | Body text, primary labels, active states. |
| `--text-secondary` | `#7b899f` | Secondary labels, hover-promotable text. |
| `--text-tertiary` | `#738699` | Metadata, null em-dashes, tertiary labels. |
| `--text-inverse` | `#06090f` | Text on cyan/colored backgrounds (e.g. primary buttons). |

Follow the current primitive's state recipe and check contrast against its actual background. Subdued interactive text promotes on hover/focus; preserve a visible focus indicator.

### Rainbow gradient (reserved for `.cc-rainbow-*` surfaces only)

| Token | Value |
|---|---|
| `--rainbow-gradient` | 6-stop: `#ff6b6b → #ffa500 → #ffd93d → #6bcb77 → #4d96ff → #9b59b6 → loop` |
| `--rainbow-tint` | low-alpha (~0.10–0.14) version for tinted backgrounds |
| `--rainbow-glow` | `rgba(155, 89, 182, 0.15)` — violet halo |
| `--rainbow-glow-strong` | `rgba(155, 89, 182, 0.25)` — hover halo |
| `--rainbow-glow-blue` | `rgba(77, 150, 255, 0.08)` — secondary halo |

---

## Typography

### Family aliases

| Alias | Family | Weights | Role |
|---|---|---|---|
| `--font-display` | Anybody | 400 / 600 / 800 | Page titles, modal titles, `CC` logo, empty-state titles. Tracking `-0.03em`. |
| `--font-body` | Manrope | 300–800 | **Conversation message prose only.** Set at `0.9rem` / `1.65` line-height. |
| `--font-mono` | Geist Mono | 300–700 | Everything else: chrome, buttons, labels, nav, metadata, code, tables, badges, inputs, diffs, breadcrumbs, status, timestamps, counters. |

Loaded via `next/font/google`.

### Size tier system

| Tier | Value | Use |
|---|---|---|
| 1 (floor) | `0.7rem` (≈ 11.2px) | Smallest metadata, timestamps, chevrons. `--font-size-floor`. |
| 2 (small) | `0.72rem` | Section labels, table headers, small buttons, badges. |
| 3 (base) | `0.78rem` | Buttons, inputs, data values, branch chips. |
| 4 (body) | `0.82rem` | Inline code, expanded content, item titles. |
| 5 (prose) | `0.9rem` | Conversation message body text. |
| Display | `1.0rem`+ | Page titles (Anybody 800 / 2.4rem), modal titles (Anybody 700 / 1.2rem). |

### Typography for new screens — use utilities

New and migrated UI sets type with **Tailwind utilities**: `font-display`/`font-body`/`font-mono` for the family, `text-text-*` for color, and the size tiers above. The old `.cc-*` typography helper recipes were **deleted in the migration** (they had no production consumers) — do **not** reach for them:

```
.cc-page-title  .cc-page-subtitle  .cc-logo  .cc-modal-title  .cc-empty-title
.cc-meta-label  .cc-button-text    .cc-prose .cc-inline-code  .cc-code-block   — DELETED
```

Use `SectionHeader` for section labels and inspect the CSS inventory before editing a retained legacy recipe.

### Utility classes

- `font-display`, `font-body`, `font-mono` (Tailwind utilities from `--font-*`).
- Text **color** is `text-text-primary/secondary/tertiary/inverse` and `text-cyan/amber/green/red/violet` (from `--color-*`).
- The legacy `.text-primary/secondary/tertiary` and `.text-cyan/amber/…` **class recipes** in `typography.css` are utility-shaped names with legacy consumers; inspect their consumers and collision guard before changing them. Author new UI with the Tailwind `text-*` utilities, not these recipes.

---

## Spacing

### Linear scale

| Token | Value |
|---|---|
| `--space-2xs` | `2px` |
| `--space-xs` | `4px` |
| `--space-sm` | `8px` |
| `--space-md` | `12px` |
| `--space-lg` | `16px` |
| `--space-xl` | `24px` |
| `--space-2xl` | `32px` |
| `--space-3xl` | `48px` |

Use token-backed spacing utilities in JSX. Preserved CSS uses `var(--space-*)`; do not introduce arbitrary margin/padding scales.

### Semantic aliases

| Token | Aliases | Use |
|---|---|---|
| `--space-section` | `var(--space-xl)` | Between major sections. |
| `--space-header-content` | `var(--space-sm)` | Section header → its content. |
| `--space-item` | `var(--space-xs)` | Between list items. |

### Sizing floors

| Token | Value | Use |
|---|---|---|
| `--font-size-floor` | `0.7rem` | Smallest permitted font size. |
| `--icon-size-min` | `20px` | Minimum meaningful icon visual size. |
| `--icon-btn-min` | `24px` | Minimum icon button (desktop). |
| `--touch-target-min` | `44px` | Minimum touch target (mobile). |

---

## Radii

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | `4px` | Small inputs, badges, code spans. |
| `--radius-md` | `6px` | Buttons, chips, smaller cards. |
| `--radius-lg` | `10px` | Cards, modals, panels. |
| (pills) | `9999px` | Use the existing pill utility (`rounded-full` or `rounded-[9999px]`) from the component recipe. |

No half-radius custom values.

---

## Layout constants

| Token | Value | Use |
|---|---|---|
| `--topbar-height` | `48px` | Topbar height. |
| Sidebar width (desktop) | `308px` | Active Conversations sidebar. |
| Sidebar width (smallest) | `280px` | Below 960px viewport width. |
| Right pane width | `340px` | Diff / docs / specs pane. |
| Tabs strip height | `36px` | Tab strip above conversation pane. |

### Breakpoints

| Breakpoint | Behavior |
|---|---|
| ≤1180px | Right pane hides; content collapses to single column. |
| ≤1080px | Topbar crumbs shrink; fleet counter hides. |
| ≤960px | Topbar status + counter hide; sidebar shrinks to 280px. |
| ≤768px | Mobile single-panel mode; bottom toolbar appears. |

---

## Adding a new token

Before adding any new token:

1. Check that no existing token already covers the use case (and that a `color-mix()` over an existing token won't do — see the parity-color note above).
2. Establish why an existing token or composition cannot express the required treatment. Do not inline a raw color to avoid adding a justified parity token.
3. Follow the existing naming pattern: `--<category>-<variant>` (e.g. `--cyan-glow-strong`, not `--strong-cyan-glow`).
4. Add the legacy `var(--…)` name to `src/features/_root/styles/tokens.css` **and** mirror its literal under the matching `@theme` namespace in `src/features/_root/styles/theme.css` (so a utility generates). Adding tokens is reserved to the foundation/token-owner context — feature waves consume tokens, they don't mint them.

`.cc-*` helper recipes are not the authoring path for new UI anymore — build with utilities or a `ui/` primitive. Touch the retained recipes only via their primitive.
