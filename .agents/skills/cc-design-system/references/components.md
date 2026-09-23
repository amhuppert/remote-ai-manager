# Components

Canonical component recipes, composite components, the card recipe, hover/press states, and the Codex agent variant.

## Build with primitives first

After the Tailwind migration, the contract for the canonical recipes is the set of **React primitives** in `src/components/ui/`, each emitting pure Tailwind utilities and shipping a `.stories.tsx`:

| Primitive | Replaces recipe | Notes |
|---|---|---|
| `Button` | `.btn*` | variants primary/danger/success/ghost/warning + `-sm`; `layoutClassName` for external geometry. |
| `IconButton` | `.btn-icon-only`, `.cc-ibtn`, pin-toggle | `square`/`pill`/`ghost`; `size="touch"`; `data-pressed` for toggles. Owns mobile 44px touch-enlarge. |
| `StatusChip` | Lifecycle/status pill | Preferred for tone-coded lifecycle and status labels; use its current schema-backed props. |
| `Badge` | General badge | Type/count/subtle treatments; inspect current variants and attributes. |
| `StatusDot` | `.status-dot`/`.status-indicator` | cyan/amber/green/idle; live states pulse. |
| `Tabs` | `.cc-tabs`/`.cc-tab`/`.cc-tab-count` | active = cyan bg; mind the `data-[status=…]` underscore pitfall (use static maps). |
| `SectionHeader` | `.cc-section-*` | header/chevron/label/count/actions. |
| `EmptyState` | `.empty-state*` | icon/title/desc. |
| `FormField` | `.form-*` | group/label/input/hint/error. |
| `Dialog` / `AlertDialog` | Modal/dialog surface | Styled Radix parts with the shared `dialog-recipe.ts`, including mobile sheet treatment. |

Build with current primitives rather than legacy recipe classes. Inspect the component's exports and stories for the actual API; authoring rules live in `docs/tailwind-conventions.md`.

The historical class names in the tables below identify visual treatments, not public APIs or guarantees that those classes still exist. Use their colors and states through the current primitive or utilities.

---

## Foundation

| Concept | Class(es) | Notes |
|---|---|---|
| Buttons | `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-sm` | Mono font; sentence-case text; never full-color background except `.btn-primary` (cyan) and `.btn-danger` (red). |
| Icon-only buttons | `.btn-icon-only`, `.btn-icon-only.danger` | Include `aria-label` and compose `WithTooltip`/`Tooltip` for the visible hint. |
| Status dots | `.status-dot`, `.status-dot.cyan`, `.status-dot.amber`, `.status-dot.idle` | Live states animate via `pulse-dot 2.5s`. Idle uses `--text-tertiary` with no animation. |
| Text input / textarea | `.prompt-input` | Cyan focus ring (border + glow). Sending state uses `.prompt-input.busy` with `pulse-border`. |
| Empty state | `.empty-state`, `.empty-state-title`, `.empty-state-desc` | Two short lines; max ~320px width. No illustrations, no stacked CTAs. |
| Modal / confirm dialog | `.modal-overlay`, `.modal-card`, `.modal-title`, `.modal-actions` | Use the shared `dialog-recipe.ts`; it currently includes an 8px blur. See the motion reference before adding or changing fullscreen blur. |

---

## Canonical `.cc-*` patterns

### Tabs

```
.cc-tabs           container (flex, gap 2px, padding 3px, border, radius)
.cc-tab            individual tab (mono, 0.72rem, 500 weight, rounded, transition)
.cc-tab.active     active state
.cc-tab:hover      hover state
.cc-tab-count      count badge (0.7rem, pill, opacity 0.85)
```

| State | Background | Text |
|---|---|---|
| Inactive | transparent | `--text-secondary` |
| Hover | `--bg-hover` | `--text-primary` |
| Active | `--cyan` | `--text-inverse` |

### Section header

```
.cc-section-header     container (flex, align-items: center, gap var(--space-sm))
.cc-section-chevron    collapse toggle (16px, rotates -90deg)
.cc-section-label      label text (mono, 0.72rem, 600 weight, uppercase, 0.08em tracking, --text-secondary)
.cc-section-count      count badge (mono, 0.7rem, 400 weight, --text-tertiary, parenthesized)
.cc-section-actions    trailing action area
```

### Badges

For new lifecycle/status pills, use `StatusChip`. The historical `Badge` status treatment below describes existing styling rather than overriding the root primitive-selection rule.

> The `.cc-badge*` CSS recipe was **deleted** in the migration; the `Badge` primitive (`ui/Badge.tsx`) now emits these styles as utilities. The API below is the primitive's contract: `variant` carries the tier, `data-*` carries the value.

Tier via `variant` (was the BEM modifier); value within the tier via attribute selector. This scales without modifier-class explosion.

**Tier** (the `Badge` variant; historical class labels shown for reference):

```
.cc-badge--status      status tier (semantic color bg + text)
.cc-badge--type        type tier (feature/bug/idea)
.cc-badge--count       count tier (neutral bg, secondary text)
.cc-badge--subtle      subdued variant (composes with the above)
```

**Value within the tier** (attribute selector on the tier modifier):

```
[data-status="running" | "active" | "merged" | "ready" | "awaiting" | "warning"]
[data-type="feature" | "bug" | "idea"]
[data-active="true"]
[data-backend="claude" | "codex"]   /* orthogonal — applies regardless of tier */
```

Example: `<Badge variant="status" data-status="running">Running</Badge>`.

The tier-as-variant + value-as-attribute split (rather than the original spec's tier-via-attribute `.cc-badge[data-status="..."]` with no tier modifier) is the contract the `Badge` primitive implements — keep this pattern.

**Status colors:**

| State | Background | Text | Extras |
|---|---|---|---|
| Running / Active | `--cyan-glow` | `--cyan` | cyan box-shadow |
| Merged / Ready | `--green-glow` | `--green` | — |
| Awaiting | `--amber-glow` | `--amber` | — |
| Idle | `--bg-raised` | `--text-secondary` | — |

**Type colors:**

| Type | Background | Text |
|---|---|---|
| Feature | `--cyan-glow` | `--cyan` |
| Bug | `--red-glow` | `--red` |
| Idea | `--amber-glow` | `--amber` |

**Count colors:**

| Variant | Background | Text |
|---|---|---|
| Default | `--bg-raised` | `--text-secondary` |
| Active (has running) | `--cyan-glow` | `--cyan` |

**Subtle variant** (`.cc-badge--subtle`): 50% opacity on background, no border. Use when badge content is redundant with context.

---

## Composite components

| Concept | Class(es) |
|---|---|
| Project card (3 states) | `.project-card`, `.has-sessions`, `.idle`, `.active` |
| Sessions table | `.sessions-table` + `tr` rows |
| Session info strip (28px) | `.session-info-strip`, `.si-item`, `.si-label`, `.si-val`, `.si-sep` |
| Copyable ID | `.copyable-id`, `.copyable-id-val`, `.copyable-id-icon`, `.copied` |
| Context-fill indicator | `.context-fill--normal/--warning/--danger`, `.context-fill__bar-track/__fill`, `.context-fill__pct` |
| Reasoning effort selector | `.effort-selector`, `.effort-selector-trigger`, `.effort-selector-trigger.cc-rainbow-border` (xhigh/max), `.effort-selector-dropdown`, `.effort-selector-option` |
| Command indicator (slash commands) | `.command-indicator`, `.command-indicator--expanded`, `.command-name`, `.command-args` |
| Conversation message | `.message`, `.message.user`, `.message.assistant`, `.message-role`, `.message-content` |
| Prompt input area | `.prompt-input-area`, `.prompt-input`, `.prompt-input.busy`, `.prompt-send` |
| Diff view | `.diff-file`, `.diff-file-header`, `.diff-line.add/remove/context/hunk` |
| Layout switcher | `.layout-switcher`, `.layout-btn`, `.layout-btn.active`, `.layout-btn--dual` |

---

## Card recipe

The canonical surface for any cluster of related metadata + actions.

- `background: var(--bg-surface)` (or `--bg-base` idle, `--bg-raised` active).
- `border: 1px solid var(--border-subtle)` (idle `--border-dim`, active `--border-default` + 3px cyan left).
- `border-radius: var(--radius-lg)` (10px).
- `padding: var(--space-xl)` (24px).
- `::before` cyan top-edge gradient that fades in on hover.
- Hover: `translateY(-1px)` + dark drop shadow.

Three states — **idle / has-sessions / active** — are elevation-driven, never opacity-driven.

---

## Hover & press

- **Hover (most surfaces)** — background steps up one elevation level; border bumps to `--border-strong`. Buttons may add `box-shadow` glow in their semantic color.
- **Hover (text-only / ghost)** — color shifts toward `--cyan` for primary actions; stays `--text-primary` for content links.
- **Press** — no scale-down. State communicated by background, never `transform`. Cards do `translateY(-1px)` on hover then return to 0 — the only positional motion.
- **Focus rings** — cyan border + cyan glow on inputs. Always visible. Never `outline: none` without replacement.

---

## Codex agent variant

Switch into Codex identity via the `[data-agent="codex"]` attribute selector. Color comes from `--violet` (`#c77dff`). Applies to `.cc-panel`, `.agent-pill`, and any surface tagged with the attribute. **Reserved exclusively for Codex agent surfaces** — never use violet outside this context.

---

## Adding a new component

Before introducing a new component:

1. **Can an existing `ui/` primitive handle it?** Most button / icon-button / tab / badge / section-header / empty-state / form-field / modal / status-dot needs are already a primitive — compose it, don't re-author.
2. **If not a primitive, can plain Tailwind utilities + `cn()` express it?** Prefer composition with utilities over any new CSS.
3. **Still need something shared and new?** Make it a new `ui/` primitive (with a `.stories.tsx`) — do NOT author a new `.cc-*` recipe or a new stylesheet. The `no-unapproved-global-css` guardrail rejects new global CSS, and new shared visual patterns belong in a primitive, not a class.
4. **Does it respect hover/elevation rules?** Background steps up one level on hover; border bumps to strong. No exceptions.

When in doubt, check whether the surface should reuse a primitive or a card variant rather than introduce anything new.
