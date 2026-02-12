# CSM Design System

Reference for implementing the Claude Session Manager UI. The canonical design prototype lives at `ui-design/index.html`.

---

## 1. Vision: "Ground Control"

The aesthetic is **mission control for code** — a dark, high-density interface that feels like monitoring a fleet of autonomous coding agents from a command center. It is utilitarian but not cold; the electric cyan accents and subtle atmospheric effects (noise grain, scan lines) give it character without sacrificing information density.

Key qualities:

- **Data-dense**: mono-spaced metadata, compact strips, no wasted whitespace
- **Dark-first**: deep blue-black base, never pure black
- **Glowing accents**: cyan as the dominant accent with colored glow halos — not flat color
- **Atmospheric texture**: subtle SVG noise overlay + CSS scan-line effect on `body` pseudo-elements
- **Restrained motion**: staggered reveals on page load, smooth transitions on interactions, pulsing status dots — never gratuitous animation

---

## 2. Design Principles

1. **Vertical space is sacred.** The session detail view must maximize content area. Every pixel of chrome must earn its place. Controls live in the topbar or inline panel headers — never in standalone toolbars that consume full rows.

2. **Context-aware topbar.** The topbar right side swaps content based on the current page (controlled by `data-page` attribute on `.app`). Non-detail pages show global status; detail pages show session-specific controls (layout switcher, refresh, delete).

3. **Information hierarchy through typography.** Display font (`Anybody`) for page titles only. Mono font (`Geist Mono`) for all data, labels, metadata, buttons, and navigation. Body font (`Manrope`) for conversation message content only.

4. **Progressive density.** Projects list is spacious (cards with breathing room). Sessions list is moderate (table rows). Session detail is maximum density (compact strip + full-bleed panels).

5. **No redundant information.** If the breadcrumb shows the session name, no heading repeats it. If status is in the topbar, it is not also in the panel.

6. **Semantic color, not decorative color.** Cyan = active/primary/running. Green = ready/success/additions. Amber = warning/user-authored. Red = danger/deletions. These meanings are consistent everywhere.

---

## 3. Design Tokens

### 3.1 Color Palette

```css
/* Base palette — 5 elevation levels */
--bg-void: #06090f /* page background, deepest */ --bg-base: #0b1019
  /* input backgrounds, inset areas */ --bg-surface: #111825
  /* cards, panels, topbar (with alpha) */ --bg-raised: #172033
  /* elevated elements, file headers, tooltips */ --bg-hover: #1c2841
  /* hover states on surfaces */ /* Borders — 3 intensity levels */
  --border-subtle: #1a2338 /* default panel/card borders */
  --border-default: #243048 /* input borders, table headers, buttons */
  --border-strong: #2e3d5c /* hover states, focused borders */
  /* Accent: Electric Cyan — primary action color */ --cyan: #00e5ff
  --cyan-dim: #00b8cc /* hover/pressed state */
  --cyan-glow: rgba(0, 229, 255, 0.15) /* background tint */
  --cyan-glow-strong: rgba(0, 229, 255, 0.3) /* strong glow halos */
  --cyan-glow-text: rgba(0, 229, 255, 0.6) /* text-shadow for logo */
  /* Accent: Amber — warnings, user-authored content */ --amber: #ffb300
  --amber-dim: #cc8f00 --amber-glow: rgba(255, 179, 0, 0.15)
  /* Accent: Green — success, ready states, diff additions */ --green: #00e676
  --green-dim: #00b85c --green-glow: rgba(0, 230, 118, 0.15)
  /* Accent: Red — danger, errors, diff deletions */ --red: #ff3d5a
  --red-dim: #cc3148 --red-glow: rgba(255, 61, 90, 0.12) /* Text — 4 levels */
  --text-primary: #dce2f0 /* headings, primary content */
  --text-secondary: #7b899f /* labels, secondary info */
  --text-tertiary: #4d5a72 /* hints, separators, low-priority metadata */
  --text-inverse: #06090f /* text on cyan/bright backgrounds */;
```

### 3.2 Typography

| Role    | Font Family                 | CSS Variable     | Usage                                                                                |
| ------- | --------------------------- | ---------------- | ------------------------------------------------------------------------------------ |
| Display | **Anybody** (400, 600, 800) | `--font-display` | Page titles, logo, modal titles only                                                 |
| Body    | **Manrope** (300–800)       | `--font-body`    | Conversation message content, base `body` font                                       |
| Mono    | **Geist Mono** (300–700)    | `--font-mono`    | Everything else: buttons, labels, nav, metadata, code, tables, badges, inputs, diffs |

**Font loading**: Google Fonts with `preconnect` to both `fonts.googleapis.com` and `fonts.gstatic.com`.

**Base font size**: `15px` on `html`.

**Typographic patterns**:

- Page titles: `font-display`, 800 weight, `2.4rem`, `-0.03em` tracking, line-height 1.1
- Section labels / panel headers: `font-mono`, 600 weight, `0.72rem`, uppercase, `0.08em` letter-spacing
- Metadata labels (tiny): `font-mono`, 600 weight, `0.58–0.65rem`, uppercase, `0.06–0.1em` letter-spacing
- Button text: `font-mono`, 500 weight, `0.78rem` (default) or `0.72rem` (small)
- Body content (conversation): `font-body`, 400 weight, `0.9rem`, `1.65` line-height
- Code in messages: `font-mono`, `0.82rem`, `--bg-raised` background, `--cyan` color, `2px 6px` padding, `3px` border-radius

### 3.3 Spacing Scale

```css
--space-xs: 4px --space-sm: 8px --space-md: 16px --space-lg: 24px
  --space-xl: 32px --space-2xl: 48px --space-3xl: 64px;
```

### 3.4 Border Radii

```css
--radius-sm: 4px /* badges, small buttons, chips, info strips */
  --radius-md: 6px /* buttons, inputs, modals inner elements */
  --radius-lg: 10px /* cards, panels, modal container */;
```

---

## 4. Atmospheric Effects

These effects create the "ground control" atmosphere. They are subtle and should not interfere with content.

### 4.1 Noise Texture

Applied via `body::before` as a fixed overlay at `z-index: 9999`, `pointer-events: none`, `opacity: 0.025`. Uses an inline SVG data URI with `feTurbulence` (fractal noise, baseFrequency 0.9, 4 octaves). Tiled at `256px`.

### 4.2 Scan Lines

Applied via `body::after` as a fixed overlay at `z-index: 9998`, `pointer-events: none`. Uses `repeating-linear-gradient` — transparent 2px, then `rgba(0,0,0,0.03)` for 2px.

### 4.3 Topbar Frosted Glass

Background: `rgba(11, 16, 25, 0.85)` with `backdrop-filter: blur(16px) saturate(140%)`. Sticky at `top: 0`, `z-index: 100`.

---

## 5. Layout Architecture

### 5.1 App Shell

```
.app (flex column, min-height 100vh)
  +-- .topbar (sticky, 56px height)
  |     +-- .topbar-brand (logo + divider + breadcrumb)
  |     +-- .topbar-status (context-aware right side)
  +-- .main (flex: 1, full width, padded)
        +-- .page (only one visible at a time via .active class)
```

The `.app` element carries a `data-page` attribute (`"projects"`, `"sessions"`, or `"detail"`) that controls topbar content visibility and main padding adjustments.

### 5.2 Topbar Context Switching

```css
/* Non-detail pages: show global status, hide session controls */
.app:not([data-page="detail"]) .topbar-status-session {
  display: none;
}

/* Detail page: hide global status, show session controls */
.app[data-page="detail"] .topbar-status-default {
  display: none;
}
.app[data-page="detail"] .main {
  padding: var(--space-md) var(--space-lg);
}
```

**Default status** (non-detail): hooks-active indicator + session-running count.

**Session status** (detail): running-state dot, layout switcher, separator, refresh icon button, delete icon button.

### 5.3 Session Detail Layout

```
.session-detail-layout (grid: auto 1fr, full viewport height minus topbar)
  +-- .session-info-strip (ultra-compact metadata bar ~28px)
  +-- .session-content-area (grid with data-layout attribute)
        +-- .prompt-panel (conversation + prompt input)
        +-- .sidebar-diff-panel (diff viewer)
```

**Layout modes** (controlled by `data-layout` on `.session-content-area`):

| Mode              | `data-layout`    | Grid Columns | Visibility          |
| ----------------- | ---------------- | ------------ | ------------------- |
| Conversation only | `"conversation"` | `1fr`        | Diff panel hidden   |
| Default split     | `"default"`      | `1fr 420px`  | Both visible        |
| 50/50 split       | `"split"`        | `1fr 1fr`    | Both visible        |
| Diff only         | `"diff"`         | `1fr`        | Prompt panel hidden |

The layout switcher in the topbar uses inline SVG icons showing visual representations of each layout.

### 5.4 Responsive Behavior

At `max-width: 900px`:

- Default and split layouts collapse to single column
- Project cards grid becomes single column
- Session info strip wraps
- Topbar session controls reduce gap

---

## 6. Component Catalog

### 6.1 Buttons

| Variant     | Class                   | Background     | Border                | Text Color         |
| ----------- | ----------------------- | -------------- | --------------------- | ------------------ |
| Default     | `.btn`                  | `--bg-surface` | `--border-default`    | `--text-primary`   |
| Primary     | `.btn .btn-primary`     | `--cyan`       | `--cyan`              | `--text-inverse`   |
| Danger      | `.btn .btn-danger`      | transparent    | `rgba(255,61,90,0.3)` | `--red`            |
| Small       | add `.btn-sm`           | —              | —                     | `0.72rem` font     |
| Icon-only   | `.btn-icon-only`        | transparent    | `--border-default`    | `--text-secondary` |
| Icon danger | `.btn-icon-only.danger` | —              | —                     | Red on hover       |

All buttons use `font-mono`. Icon-only buttons are `30x30px` with `data-tooltip` attribute for hover labels (via `::after` pseudo-element).

Primary button hover adds `box-shadow: 0 0 20px var(--cyan-glow)`.

### 6.2 Status Indicators

A pulsing dot (`7px` circle) paired with uppercase mono text:

- **Active/Running**: `--green` dot with green glow + `pulse-dot` animation (2.5s ease-in-out)
- **Warning**: `--amber` dot with amber glow
- **Running (session)**: `--cyan` dot with cyan glow

Session status in tables uses a `6px` dot with three states:

- `.running` — cyan, pulsing
- `.ready` — green, static glow
- `.idle` — `--text-tertiary`, no glow

### 6.3 Project Cards

Surface-level card with `--radius-lg`. On hover: border brightens, background elevates to `--bg-raised`, subtle `-1px` translateY lift, and a cyan gradient line fades in across the top edge (via `::before` pseudo-element).

Contents: project name (mono, 600), activity badge (pill shape, full-round radius), file path (mono, tertiary), stats row (separated by border-top).

### 6.4 Sessions Table

Full-width borderless table. Header row: tiny uppercase mono labels in `--text-tertiary`. Body rows: `--border-subtle` bottom border, hover background `--bg-surface`. Clickable rows (cursor: pointer).

Session name: mono, 600 weight. Branch: mono chip with `--bg-raised` background and `--border-subtle` border.

### 6.5 Modals

Full-screen overlay: `rgba(6, 9, 15, 0.8)` with `backdrop-filter: blur(8px)`. Center-aligned modal card: `--bg-surface`, `--border-default`, `--radius-lg`, max-width `480px`. Entry animations: overlay fades in (0.15s), modal slides up 10px (0.2s). Closes on overlay click and Escape key.

Form inputs: `--bg-base` background, `--border-default` border, mono font. Focus: cyan border + `0 0 0 3px var(--cyan-glow)` ring.

### 6.6 Conversation Panel

Flex column with `panel-header` (title + message navigation), scrollable `panel-body`, and fixed `prompt-input-area` at bottom.

**Messages**: User messages labeled in `--amber`, assistant messages in `--cyan`. Assistant content has a `2px` left border in `--border-default` with `--space-md` left padding.

**Message navigation**: Small `20px` arrow buttons flanking a `"1 / 4"` counter. Counter auto-updates on scroll via `IntersectionObserver`-like scroll detection.

**Prompt input**: Textarea (mono, `0.85rem`) with a `48px` square send button. When busy: send button becomes outlined with a spinning border and cyan spinner inside.

### 6.7 Diff Panel

Flex column with `panel-header`, `diff-toolbar`, and scrollable `diff-content`.

**Toolbar**: Compact strip (`4px` vertical padding) with three button groups separated by `1px` vertical lines:

1. Collapse all / Expand all (icon buttons)
2. `< Files >` navigation (prev/next file headers)
3. `< Changes >` navigation (prev/next hunk markers)

**File sections**: Each file wrapped in `.diff-file-section`. File header is sticky (`top: 0`), clickable to collapse. Contains: chevron (rotates -90deg when collapsed), file name (truncated), per-file stats (`+N -M` in green/red).

**Diff lines**:

- `.hunk`: cyan-dim text on cyan-glow background
- `.add`: green text, `3px` green left border, `rgba(0,230,118,0.06)` background
- `.remove`: red text, `3px` red left border, `rgba(255,61,90,0.06)` background
- `.context`: `--text-tertiary`, no border highlight

### 6.8 Session Info Strip

Ultra-compact horizontal bar (~28px tall). Mono font at `0.68rem`. Items are label-value pairs separated by `1px` vertical lines. Labels: `0.58rem`, uppercase, `--text-tertiary`. Values: `--text-secondary`.

Displays: branch name, created date, prompt count, worktree path.

### 6.9 Badges / Pills

Full-round border-radius (`100px`). Two states:

- `.active`: cyan glow background, cyan text, semi-transparent cyan border
- `.idle`: subtle gray background, `--text-secondary` text, `--border-subtle` border

### 6.10 Layout Switcher

Grouped button bar with `3px` padding, `--bg-surface` background, `--border-subtle` border. Individual buttons are `32x26px` with inline SVG icons. Active button: `--cyan` background, `--text-inverse` color. Tooltips appear below on hover.

---

## 7. Animation Patterns

| Animation       | Duration | Easing                | Usage                                                       |
| --------------- | -------- | --------------------- | ----------------------------------------------------------- |
| `pulse-dot`     | 2.5s     | ease-in-out, infinite | Status dots — opacity 1 to 0.5                              |
| `fadeIn`        | 0.15s    | ease                  | Modal overlay entrance                                      |
| `slideUp`       | 0.2s     | ease                  | Modal card entrance — translateY(10px) to 0                 |
| `spin`          | 0.8s     | linear, infinite      | Spinner rotation                                            |
| `pulse-border`  | 1.5s     | ease-in-out, infinite | Busy send button glow                                       |
| `staggerReveal` | 0.35s    | ease, forwards        | Page content stagger — translateY(8px) + opacity 0 to final |

**Stagger pattern**: Apply `.stagger-in` to a parent. Children get `animation-delay` at 50ms increments (up to 8 children: 0ms, 50ms, 100ms, ... 350ms). Re-trigger by resetting `animation` to `"none"`, forcing reflow, then clearing.

**Transition defaults**: Most interactive elements use `transition: all 0.15s ease`. Layout column changes use `transition: grid-template-columns 0.25s ease`.

---

## 8. Navigation Model

The app uses a breadcrumb in the topbar as the sole navigation mechanism:

```
projects                              → Projects list
projects / {project-name}            → Sessions list for that project
projects / {project-name} / {session} → Session detail
```

Breadcrumb separators are `/` in `--text-tertiary`. Links are `--text-secondary`, hover to `--text-primary`. The active session name uses `.bc-session` class: `--text-primary`, 600 weight.

Page visibility is toggled via `.page.active` class. Only one page is visible at a time.

---

## 9. Scrollbar Styling

WebKit scrollbars: `6px` wide/tall, transparent track, `--border-default` thumb with `3px` border-radius. Thumb hover: `--border-strong`.

---

## 10. Implementation Notes for Future Agents

1. **Tech stack**: Next.js + TypeScript + Bun. Convert CSS custom properties to a theme object or Tailwind config. The design tokens in Section 3 are the source of truth.

2. **Font loading**: Use `next/font/google` for Anybody, Manrope, and Geist Mono. Apply via CSS variable pattern.

3. **Noise + scan lines**: These are `body`-level pseudo-elements. In Next.js, apply to the root layout's wrapper div or use a global CSS approach. Keep them subtle — they should be barely perceptible.

4. **The topbar is always present.** It is the primary navigation (breadcrumb) and the context-aware control surface. Never add secondary navigation bars or tab strips below it.

5. **Session detail must be full-bleed.** The entire viewport minus the 56px topbar is available for content. The info strip and panels fill this space as a CSS Grid.

6. **Layout switcher state** should persist per-session (localStorage or URL param).

7. **Diff panel collapse state** should be session-scoped. Navigation buttons auto-expand collapsed files when jumping to them.

8. **All data-display text uses mono font.** This is not optional — it is core to the visual identity. Paths, branch names, timestamps, counters, button labels, table cells, breadcrumb segments — all mono.

9. **Glow effects are semantic.** Cyan glow = primary/active. Green glow = success/ready. Amber glow = warning. Red glow = danger. Apply as `box-shadow` on dots, `background` tint on banners, and `text-shadow` on the logo.

10. **Keep interactive element sizes small.** Icon-only buttons: `30px`. Toolbar nav buttons: `22px` height. Message nav arrows: `20px`. The UI is designed for a desktop pointer — touch targets are not a priority.
