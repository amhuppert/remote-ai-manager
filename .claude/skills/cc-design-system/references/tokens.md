# Tokens

Full reference for color, typography, spacing, radii, and layout constants. SKILL.md has the at-a-glance version; this is the authoritative table.

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

Never use secondary or tertiary as the rest state of interactive text — on hover, promote to primary.

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

### `.cc-*` typography helper classes

Reusable named recipes. Use these for new screens and prototypes.

```
.cc-page-title       — page-level heading
.cc-page-subtitle    — secondary heading under page title
.cc-logo             — CC wordmark
.cc-modal-title      — modal heading
.cc-empty-title      — empty-state heading
.cc-section-label    — UPPERCASE MONO section label
.cc-meta-label       — small metadata label
.cc-button-text      — button text recipe
.cc-prose            — conversation message body
.cc-inline-code      — inline code spans
.cc-code-block       — block code
.cc-diff             — diff line text
```

### Utility classes

- `.font-display`, `.font-body`, `.font-mono`
- `.text-primary`, `.text-secondary`, `.text-tertiary`, `.text-cyan`, `.text-amber`, `.text-green`, `.text-red`, `.text-violet`

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

Always use `var(--space-*)`. Never literal pixel values in margin/padding.

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
| (pills) | `9999px` | Not tokenized; applied inline. |

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

1. Check that no existing token already covers the use case.
2. Check that the new token will be used in ≥3 places (otherwise inline the value).
3. Follow the existing naming pattern: `--<category>-<variant>` (e.g. `--cyan-glow-strong`, not `--strong-cyan-glow`).
4. Add it to the appropriate section above and to production `src/app/globals.css`.

New `.cc-*` helper classes follow the same rule: ≥3 callers, or it stays inlined.
