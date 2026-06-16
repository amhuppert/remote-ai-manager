# Theme token matrix (Tailwind migration — Stage A token bridge)

The CC design-token surface bridged onto Tailwind v4 in
`src/features/_root/styles/theme.css`. Two lanes (design.md "Token Bridge"):

- **Alias lane** — categories that already exist as `tokens.css` custom
  properties, aliased 1:1 under their Tailwind namespace. Legacy `var(--…)` names
  stay authoritative through Stage A; Stage B (task 10.1) removes the aliases.
- **Extract lane** — categories that did NOT exist as tokens (z-index,
  breakpoints, animations), lived as scattered literals, now centralized with
  resolved behavior preserved.

The surface is **visually inert**: it only makes utilities available. No existing
element is restyled, because every legacy `var(--…)` reference keeps resolving
and no legacy keyframe / literal is rewritten in Stage A.

The contract is pinned by `src/lib/shared/theme-surface.test.ts` (namespace +
ordering + enumeration) and the inertness backstops
`tailwind-utility-collisions.test.ts` / `tailwind-cascade-order.test.ts`.

## Namespace matrix (eleven families — the original ten + background-images)

| Family | Lane | Legacy source | `@theme` namespace | Utility family | Notes |
|---|---|---|---|---|---|
| Backgrounds | alias | `--bg-*` | `--color-bg-*` | `bg-bg-*` | under `--color-*` |
| Borders | alias | `--border-*` | `--color-border-*` | `border-border-*` | under `--color-*` |
| Accents | alias | `--cyan`,`--amber`,… (+ dims/glows) | `--color-*` | `bg/text/border-*` | rgba glows included |
| Background images | alias | `--rainbow-gradient`,`--rainbow-tint` | `--background-image-*` | `bg-rainbow`,`bg-rainbow-tint` | gradients (not colors) → `--background-image-*` |
| Text colors | alias | `--text-primary/secondary/tertiary/inverse` | `--color-text-*` | `text-text-*` | **NOT `--text-*`** (that is font-size) |
| Spacing | alias | `--space-*` (+ semantic) | `--spacing-*` | `p-*`/`m-*`/`gap-*` | incl. `section`/`header-content`/`item` |
| Radii | alias | `--radius-*` | `--radius-*` (**`@theme inline`**) | `rounded-*` | name collision → inline (see below) |
| Font families | alias | `--font-display/body/mono` | `--font-*` (**`@theme inline`**) | `font-*` | name collision → inline |
| Sizing floors | alias | `--font-size-floor`,`--icon-*-min`,`--touch-target-min` | `--cc-size-floor-*` | n/a | deliberate non-font-size ns; legibility-floor guarantee |
| z-index tiers | **extract** | literal `z-index:` | `--z-index-*` | `z-*` | ordered tier scale |
| Breakpoints | **extract** | literal `@media (max-width:)` | `--breakpoint-*` | desktop-first `max-*` `@custom-variant`s | frozen set |
| Animations | **extract** | `@keyframes` | `--animate-*` | `animate-*` | shared/JSX-authored only |

### `@theme inline` (radii + fonts)

Radii (`--radius-*`) and font families (`--font-*`) use `@theme inline` because
the legacy names collide with the Tailwind namespace: a non-inline alias
`--radius-sm: var(--radius-sm)` would self-reference. `inline` emits no theme
variable and inlines `var(--radius-sm)` straight into the utility, which resolves
to the (unlayered) legacy custom property — exact parity, no circular reference.
Verified by compile probe (`.rounded-sm { border-radius: var(--radius-sm) }`).

### z-index namespace note

The design matrix wrote `--z-*`; the **actual Tailwind v4 z-index namespace is
`--z-index-*`** (a compile probe showed `--z-*` generates no utilities). Using
`--z-index-*` yields the intended `z-*` utility family declaratively.

## z-index tier scale (ordered)

~22 ad-hoc literals collapsed into an ORDERED named tier scale; RELATIVE order
preserved, not exact integers. Legacy literals are NOT rewritten in Stage A —
feature waves repoint them onto these tiers.

| Tier token | Value | Legacy literals it absorbs |
|---|---|---|
Each tier maps to one of CC's actual distinct stacking bands (verified against
the legacy literals + their selectors). RELATIVE order ACROSS bands is preserved
exactly — toasts sit BELOW the menu/popover cluster, which sits below overlays
and tooltips, matching the legacy reality.

| Tier token | Value | Legacy literals it absorbs |
|---|---|---|
| `--z-index-base` | 0 | 0 |
| `--z-index-raised` | 1 | 1, 2, 5 (local stacking) |
| `--z-index-sticky` | 10 | 10, 20 |
| `--z-index-header` | 50 | 50, 60 (sticky headers, autocompletes, action bars) |
| `--z-index-panel` | 90 | 89, 90, 91 (side panels + np/unified/ds slide-in sheets) |
| `--z-index-nav` | 100 | 100 (topbar), 150 (model-selector dropdown) |
| `--z-index-dropdown` | 200 | 199, 200, 201 (dropdowns, mobile action backdrop/sheet, `.cc-toast`) |
| `--z-index-toast` | 300 | 300 (`.merge-toast`) — above dropdowns, **below menus** |
| `--z-index-menu` | 1000 | 1000 (`.ctx-menu`, `.kebab-menu`, `.mcp-config-popover`) |
| `--z-index-popover` | 1100 | 1100, 1110 (PeekPopover) |
| `--z-index-overlay` | 9999 | 9998, 9999 (full-screen/atmospheric overlays, mermaid, skip-link) |
| `--z-index-tooltip` | 99999 | 99999 (TooltipProvider) |

Re-homed guarantee (was the `ModelSelector` globals.css regex test):
`--z-index-panel < --z-index-dropdown < --z-index-tooltip`. The full scale is
also asserted strictly monotonic, so the toast-below-menus / overlay-below-tooltip
orderings cannot silently regress.

## Breakpoints (frozen, desktop-first)

CC authors `@media (max-width: …)` (desktop default, narrower viewports
override). Spine = 768px + 769px min-width companion. Recurring one-offs
tokenized; the `max-*` custom variants are registered over EXPLICIT
`@media (max-width: Npx)` (inclusive) so the boundary matches CC exactly —
Tailwind's auto `max-*` variants use an exclusive `width < value`. NOT inverted
to mobile-first.

Frozen tokens: `--breakpoint-640/768/769/800/900/960/1080/1100/1180`.
Variants: `max-640 … max-1180`, `min-769`.

## Animations

Only the **shared, JSX-authored** keyframes are tokenized, with a canonical
duration chosen where a keyframe is invoked at many. The `@keyframes` themselves
stay in the legacy stylesheets (still resolving) and existing `animation:` rules
keep their own per-call-site durations — Stage A changes no rendered animation.

### Tokenized (`--animate-*`)

| Token | Keyframe | Canonical value | Why shared |
|---|---|---|---|
| `--animate-pulse-dot` | `pulse-dot` | `2.5s ease-in-out infinite` | status-dot pulse across ~15 call sites in many unrelated surfaces (durations span 1.2–2.5s; 2.5s is dominant) |
| `--animate-fade-in` | `fadeIn` | `0.3s ease` | generic overlay/panel fade across globals/conversation/prompt |
| `--animate-bulk-float-in` | `bulk-float-in` | `0.18s ease` | toast float-in (design-named dedup target) |

**Deduplication note (source conflict — recorded per charter §"Applying the
source-of-truth hierarchy"):** `pulse-dot` and `bulk-float-in` are each defined
in two files (pulse-dot: globals.css + workflow-graph.css; bulk-float-in:
globals.css + project-detail.css). Tasks 2.4 / design.md say "deduplicate the
duplicate keyframes", but the **context NEGATIVE acceptance criterion ("no
feature CSS is deleted")** and the **charter non-goal ("Do NOT migrate any
feature surface in Stage A")** outrank a mechanical dedup. Resolution: the
**token surface is deduped** — each shared animation is one canonical
`--animate-*` token — while the duplicate legacy `@keyframes` blocks are left in
place (resolving identically). Physically collapsing the cross-file duplicates is
deferred to Stage B, when those surfaces migrate. Prevailing source: charter
non-goal + context negative criterion over tasks.md/design.md.

`spin` is NOT tokenized: Tailwind v4 already ships `--animate-spin` +
`@keyframes spin`; CC's own unlayered `@keyframes spin` continues to win for the
bare name. No action needed.

### Bespoke — stay scoped (explicitly marked, NOT tokenized)

- **Graph / vendor (workflow-graph.css, preserved per decision 4):**
  `pulse-node`, `pulse-node-selected`, `pulse-node-validating-selected`,
  `pulse-node-merging-selected`, `merging-chevron`, `dash-flow`, and the
  workflow-graph copy of `pulse-dot`.
- **Atmospheric:** `rainbow-shift`, `rainbow-border-shift`.
- **Vendor/generated content:** `mermaid-overlay-fadein` (Mermaid output).
- **Voice / debug / surface status pulses:** `voice-recording-pulse`,
  `debug-rec-pulse`, `session-status-pulse`.
- **Single-surface entrance/exit (not shared):** `fadeInOut`, `slideUp`,
  `pulse-border`, `staggerReveal`, `toastSlideIn`, `toastSlideOut`,
  `np-backdrop-in`, `np-slide-in`, `slideUpSheet`, `cmdReveal`,
  `unified-backdrop-in`, `unified-slide-in`, `unified-pulse`, `ds-panel-in`,
  `ds-sheet-in`, `mcp-skeleton-shimmer`, `plc-rise-fade`, `plc-diff-scrim-in`,
  `plc-diff-slide-in`, `kebab-in`, `info-details-pop-in`, `ask-question-scrim-in`,
  `typingBounce`, `collab-card-pulse`, `peek-in`, `peek-fade`, `peek-dot-pulse`.
