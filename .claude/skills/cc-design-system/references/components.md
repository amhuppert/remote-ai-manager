# Components

Foundation classes, canonical `.cc-*` patterns, composite components, the card recipe, hover/press states, and the Codex agent variant. Class names are the contract — the same selector appears in CSS, in TSX components, and in any prototypes; they must agree.

---

## Foundation

| Concept | Class(es) | Notes |
|---|---|---|
| Buttons | `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-sm` | Mono font; sentence-case text; never full-color background except `.btn-primary` (cyan) and `.btn-danger` (red). |
| Icon-only buttons | `.btn-icon-only`, `.btn-icon-only.danger` | Always include `aria-label` + `data-tooltip`. |
| Status dots | `.status-dot`, `.status-dot.cyan`, `.status-dot.amber`, `.status-dot.idle` | Live states animate via `pulse-dot 2.5s`. Idle uses `--text-tertiary` with no animation. |
| Text input / textarea | `.prompt-input` | Cyan focus ring (border + glow). Sending state uses `.prompt-input.busy` with `pulse-border`. |
| Empty state | `.empty-state`, `.empty-state-title`, `.empty-state-desc` | Two short lines; max ~320px width. No illustrations, no stacked CTAs. |
| Modal / confirm dialog | `.modal-overlay`, `.modal-card`, `.modal-title`, `.modal-actions` | Overlay `rgba(6, 9, 15, 0.8)` + `blur(8px)`. |

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

Base: `.cc-badge`. **Hybrid API:** BEM modifier for the **tier**; attribute selector for the **value within the tier**. This scales without modifier-class explosion.

**Tier** (always required — BEM modifier on `.cc-badge`):

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

Example: `<span class="cc-badge cc-badge--status" data-status="running">Running</span>`.

The "use BEM, not attributes" decision was about replacing the original spec's tier-via-attribute pattern (`.cc-badge[data-status="..."]` with no tier modifier). Production correctly uses BEM for the tier and attributes for the value — keep this pattern.

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

1. **Can an existing canonical pattern handle it?** Most cases fit `.cc-tabs`, `.cc-section-header`, `.cc-badge--*`, or the card recipe.
2. **Does it need a new class name, or just composition?** Prefer composition over new classes.
3. **If new — does the class name use the `.cc-*` prefix?** Use `.cc-*` for shared canonical patterns; existing per-feature class names stay where they are.
4. **Does it respect hover/elevation rules?** Background steps up one level on hover; border bumps to strong. No exceptions.

When in doubt, check whether the surface should be a card variant rather than a new composite.
