# Requirements Document

## Introduction

This specification formalizes the CC (Command Center) UI design system — the complete visual language, design tokens, component patterns, typography rules, color semantics, layout architecture, responsive behaviors, and atmospheric effects that all UI features must follow.

The design system serves as the single source of truth for visual consistency across the project list, session list, and session detail views, replacing the legacy `memory-bank/design-system.md` document. The canonical design prototype lives at `ui-design/index.html`.

## Vision: "Ground Control"

The aesthetic is **mission control for code** — a dark, high-density interface that feels like monitoring a fleet of autonomous coding agents from a command center. It is utilitarian but not cold; the electric cyan accents and subtle atmospheric effects (noise grain, scan lines) give it character without sacrificing information density.

Key qualities:

- **Data-dense**: mono-spaced metadata, compact strips, no wasted whitespace
- **Dark-first**: deep blue-black base, never pure black
- **Glowing accents**: cyan as the dominant accent with colored glow halos — not flat color
- **Atmospheric texture**: subtle SVG noise overlay + CSS scan-line effect on `body` pseudo-elements
- **Restrained motion**: staggered reveals on page load, smooth transitions on interactions, pulsing status dots — never gratuitous animation

## Design Principles

1. **Vertical space is sacred.** The session detail view must maximize content area. Every pixel of chrome must earn its place. Controls live in the topbar or inline panel headers — never in standalone toolbars that consume full rows.
2. **Context-aware topbar.** The topbar right side swaps content based on the current page (controlled by `data-page` attribute on `.app`). Non-detail pages show global status; detail pages show session-specific controls (layout switcher, refresh, delete).
3. **Information hierarchy through typography.** Display font (`Anybody`) for page titles only. Mono font (`Geist Mono`) for all data, labels, metadata, buttons, and navigation. Body font (`Manrope`) for conversation message content only.
4. **Progressive density.** Projects list is spacious (cards with breathing room). Sessions list is moderate (table rows). Session detail is maximum density (compact strip + full-bleed panels).
5. **No redundant information.** If the breadcrumb shows the session name, no heading repeats it. If status is in the topbar, it is not also in the panel.
6. **Semantic color, not decorative color.** Cyan = active/primary/running. Green = ready/success/additions. Amber = warning/user-authored. Red = danger/deletions. These meanings are consistent everywhere.
7. **Responsive, not stripped down.** Mobile is a first-class experience, not a degraded desktop view. Every feature is accessible on every screen size; nothing is hidden or removed on mobile. Desktop uses density and side-by-side panels; mobile uses vertical stacking and panel switching.

## Requirements

### Requirement 1: Design Token Architecture

**Objective:** As a developer, I want all visual properties (colors, spacing, radii, typography, sizing) defined as CSS custom properties in a centralized token layer, so that the entire UI can be themed and maintained from one location.

#### Acceptance Criteria

1. The Design System shall define all tokens as CSS custom properties on the `:root` selector.
2. The Design System shall define background tokens at five elevation levels with specific usage: `--bg-void` (#06090f, page background), `--bg-base` (#0b1019, input backgrounds/inset areas), `--bg-surface` (#111825, cards/panels/topbar), `--bg-raised` (#172033, elevated elements/file headers/tooltips), `--bg-hover` (#1c2841, hover states on surfaces).
3. The Design System shall define border tokens at three intensity levels with specific usage: `--border-subtle` (#1a2338, panel/card borders), `--border-default` (#243048, input borders/table headers/buttons), `--border-strong` (#2e3d5c, hover/focused borders).
4. The Design System shall define a spacing scale with tokens: `--space-xs` (4px), `--space-sm` (8px), `--space-md` (16px), `--space-lg` (24px), `--space-xl` (32px), `--space-2xl` (48px), `--space-3xl` (64px).
5. The Design System shall define border-radius tokens: `--radius-sm` (4px, badges/small buttons/chips/info strips), `--radius-md` (6px, buttons/inputs/modals inner elements), `--radius-lg` (10px, cards/panels/modal containers).
6. The Design System shall define a topbar height token: `--topbar-height` (56px).
7. When a new UI component is created, the Design System shall require that it references only existing design tokens — no hard-coded color, spacing, or sizing values.

### Requirement 2: Semantic Color System

**Objective:** As a developer, I want a strict semantic color palette with defined usage rules, so that color conveys meaning consistently across all views.

#### Acceptance Criteria

1. The Design System shall define four accent color families, each with base, dim, and glow variants: cyan (`--cyan` #00e5ff, `--cyan-dim` #00b8cc, `--cyan-glow` rgba(0,229,255,0.15), `--cyan-glow-strong` rgba(0,229,255,0.3), `--cyan-glow-text` rgba(0,229,255,0.6)), amber (`--amber` #ffb300, `--amber-dim` #cc8f00, `--amber-glow` rgba(255,179,0,0.15)), green (`--green` #00e676, `--green-dim` #00b85c, `--green-glow` rgba(0,230,118,0.15)), and red (`--red` #ff3d5a, `--red-dim` #cc3148, `--red-glow` rgba(255,61,90,0.12)).
2. The Design System shall enforce semantic color assignments: cyan for active/primary/running states, green for ready/success/diff additions, amber for warnings/user-authored content, and red for danger/errors/diff deletions.
3. The Design System shall define four text color levels: `--text-primary` (#dce2f0, headings/primary content), `--text-secondary` (#7b899f, labels/secondary info), `--text-tertiary` (#4d5a72, hints/separators/low-priority metadata), `--text-inverse` (#06090f, text on cyan/bright backgrounds).
4. When an accent color is used for an interactive element, the Design System shall provide a corresponding glow variant for hover and focus states (e.g., `box-shadow` on dots, `background` tint on banners, `text-shadow` on the logo).
5. If a color is used outside its defined semantic role, the Design System shall treat this as a violation of the visual identity contract.

### Requirement 3: Typography Contract

**Objective:** As a developer, I want strict font-family assignment rules with documented typographic patterns, so that typography usage is predictable and consistent.

#### Acceptance Criteria

1. The Design System shall define three font families with non-overlapping roles: display (`Anybody`, weights 400/600/800), body (`Manrope`, weights 300–800), and mono (`Geist Mono`, weights 300–700).
2. The Design System shall expose font families as CSS custom properties (`--font-display`, `--font-body`, `--font-mono`) with appropriate fallback stacks, loaded via `next/font/google`.
3. The Design System shall set the base font size to `15px` on the `html` element.
4. The Design System shall restrict the display font to: page titles, the app logo, modal titles, and empty-state titles only.
5. The Design System shall restrict the body font to: conversation message prose content only, and as the base `body` font-family.
6. The Design System shall assign the mono font to: all controls, labels, navigation, metadata, data values, buttons, inputs, code, diffs, tables, badges, breadcrumbs, status indicators, timestamps, and counters.
7. The Design System shall define the following typographic patterns:
   - Page titles: `--font-display`, 800 weight, `2.4rem`, `-0.03em` letter-spacing, line-height 1.1
   - Section/panel labels: `--font-mono`, 600 weight, `0.72rem`, uppercase, `0.08em` letter-spacing
   - Metadata labels (tiny): `--font-mono`, 600 weight, `0.58–0.65rem`, uppercase, `0.06–0.1em` letter-spacing
   - Button text: `--font-mono`, 500 weight, `0.78rem` (default) or `0.72rem` (small)
   - Body content (conversation): `--font-body`, 400 weight, `0.9rem`, `1.65` line-height
   - Inline code: `--font-mono`, `0.82rem`, `--bg-raised` background, `--cyan` color, `2px 6px` padding, `3px` border-radius
   - Diff content: `--font-mono`, `0.75rem`, `1.7` line-height

### Requirement 4: Button Component Variants

**Objective:** As a developer, I want a defined set of button styles with consistent sizing, spacing, and interaction feedback, so that buttons behave uniformly across the application.

#### Acceptance Criteria

1. The Design System shall define a base button style (`.btn`) with mono font, default border, surface background, and `150ms ease` transition.
2. The Design System shall provide button variants:
   - Default: `--bg-surface` background, `--border-default` border, `--text-primary` text
   - Primary (`.btn-primary`): `--cyan` background, `--cyan` border, `--text-inverse` text, 600 weight
   - Danger (`.btn-danger`): transparent background, `rgba(255,61,90,0.3)` border, `--red` text
3. The Design System shall provide size modifiers: default (`10px 18px` padding, `0.78rem` font) and small (`.btn-sm`, `6px 12px` padding, `0.72rem` font).
4. The Design System shall provide an icon-only button variant (`.btn-icon-only`) at `30×30px` with `--border-default` border, transparent background, `--text-secondary` color, and tooltip support via `data-tooltip` attribute and `::after` pseudo-element.
5. When a primary button is hovered, the Design System shall apply `--cyan-dim` background and `box-shadow: 0 0 20px var(--cyan-glow)`.
6. When a danger button is hovered, the Design System shall apply `--red-glow` background and `--red-dim` border.
7. When an icon-only button is hovered, the Design System shall reveal a tooltip positioned below the button with raised background, default border, `0.62rem` mono font.
8. When an icon-only button has the `.danger` modifier and is hovered, the Design System shall apply `--red-glow` background and `--red` color.

### Requirement 5: Status Indicator System

**Objective:** As a developer, I want a reusable status indicator pattern with animated dots and semantic colors, so that live system states are communicated clearly.

#### Acceptance Criteria

1. The Design System shall define a status indicator component (`.status-indicator`) combining a colored dot (`.status-dot`) and an uppercase mono label at `0.72rem`, 500 weight, `0.06em` letter-spacing.
2. The Design System shall size the status dot at `7px` with a border-radius of `50%` and a `box-shadow` glow matching the dot's accent color.
3. The Design System shall provide dot color variants: green (`.status-dot` default — active/ready), amber (`.status-dot.warning`), cyan (`.status-dot.cyan` — running/primary).
4. While a status represents a live/running state, the Design System shall apply the `pulse-dot` animation at `2.5s ease-in-out infinite`.
5. The Design System shall define session-table status (`.session-status`) with a `6px` dot and three states: `.running` (cyan, pulsing at `1.5s`), `.ready` (green, static glow), `.idle` (`--text-tertiary`, no glow).
6. When displayed on mobile viewports (≤768px) in non-detail views, the Design System shall hide status labels (via `font-size: 0`) and enlarge dots to `8px`.

### Requirement 6: Card Component Pattern

**Objective:** As a developer, I want a standardized card component with consistent elevation, borders, and hover behavior, so that list views feel cohesive.

#### Acceptance Criteria

1. The Design System shall define a card component (`.project-card`) with `--bg-surface` background, `--border-subtle` border, `--radius-lg` radius, and `--space-lg` padding.
2. The Design System shall render a `::before` pseudo-element on cards: a `2px` top-edge gradient line (`transparent → --cyan-dim → transparent`) that is hidden by default (`opacity: 0`).
3. When a card is hovered, the Design System shall: brighten border to `--border-strong`, elevate background to `--bg-raised`, apply `translateY(-1px)`, and fade in the cyan gradient line (`opacity: 1`).
4. The Design System shall define a card grid (`.projects-grid`) using `display: grid` with `auto-fill` columns and `minmax(340px, 1fr)`, gapped at `--space-md`.
5. When displayed on mobile viewports (≤768px), the Design System shall stack cards in a single column at full width.
6. The Design System shall define card contents: project name (`.project-name`, mono, 600 weight, `1.05rem`), activity badge (`.project-badge`, pill with `100px` border-radius), file path (`.project-path`, mono, tertiary, ellipsis-truncated), and stats row (`.project-stats`, separated by `--border-subtle` top border).

### Requirement 7: Badge and Pill Components

**Objective:** As a developer, I want standardized badge/pill styles for activity indicators, so that status labels are visually consistent.

#### Acceptance Criteria

1. The Design System shall define badges (`.project-badge`) with full-round border-radius (`100px`), mono font at `0.68rem`, 600 weight, `0.03em` letter-spacing.
2. The Design System shall provide two badge states: active (`.active` — `--cyan-glow` background, `--cyan` text, semi-transparent cyan border) and idle (`.idle` — subtle gray background, `--text-secondary` text, `--border-subtle` border).

### Requirement 8: Modal and Overlay System

**Objective:** As a developer, I want consistent modal presentation with entry animations and responsive adaptation, so that dialogs feel polished on all devices.

#### Acceptance Criteria

1. The Design System shall define a modal overlay (`.modal-overlay`) with `rgba(6,9,15,0.8)` background, `backdrop-filter: blur(8px)`, fixed positioning at `z-index: 200`, centered flex alignment, and `fadeIn` animation at `0.15s`.
2. The Design System shall define a modal card (`.modal`) with `--bg-surface` background, `--border-default` border, `--radius-lg` radius, `--space-xl` padding, `480px` max-width, and `slideUp` animation at `0.2s`.
3. The Design System shall close modals on: overlay click, Escape key, or Cancel button.
4. The Design System shall provide a confirm-dialog variant (`.confirm-modal`) with `400px` max-width, modal title (`.modal-title`, display font, 700 weight, `1.2rem`), message (`.confirm-message`, mono font, `0.82rem`, secondary color), and actions row (`.modal-actions`, flex, end-justified).
5. When displayed on mobile viewports (≤768px), the Design System shall present modals as bottom sheets: align to `flex-end`, full-width with no max-width, `--radius-lg` top corners only, bottom-edge `slideUpSheet` animation at `0.25s`, and `safe-area-inset-bottom` padding.

### Requirement 9: Form Element Styles

**Objective:** As a developer, I want consistent form styling for inputs, labels, hints, and errors, so that all forms share the same visual language.

#### Acceptance Criteria

1. The Design System shall style form inputs (`.form-input`) with `--bg-base` background, `--border-default` border, `--radius-md` radius, mono font at `0.88rem`, `10px 14px` padding, and `150ms ease` transition.
2. When a form input receives focus, the Design System shall apply `--cyan-dim` border color and `box-shadow: 0 0 0 3px var(--cyan-glow)`.
3. The Design System shall style form labels (`.form-label`) as `0.72rem` uppercase mono text, 600 weight, `0.08em` letter-spacing, `--text-secondary` color, with `--space-sm` bottom margin.
4. The Design System shall style form hints (`.form-hint`) in `--text-tertiary` and form errors (`.form-error`) in `--red`, both at `0.68rem` mono font with `--space-xs` top margin.
5. The Design System shall style input placeholders in `--text-tertiary`.

### Requirement 10: Atmospheric and Decorative Effects

**Objective:** As a developer, I want subtle atmospheric effects that create the "ground control" atmosphere without interfering with content.

#### Acceptance Criteria

1. The Design System shall apply a noise-grain texture via `body::before`: fixed positioning, `z-index: 9999`, `pointer-events: none`, `opacity: 0.025`, using an inline SVG data URI with `feTurbulence` (fractal noise, `baseFrequency: 0.9`, 4 octaves), tiled at `256px`.
2. The Design System shall apply a scan-line overlay via `body::after`: fixed positioning, `z-index: 9998`, `pointer-events: none`, using `repeating-linear-gradient` (transparent `2px`, then `rgba(0,0,0,0.03)` for `2px`).
3. The Design System shall define frosted-glass effects using `backdrop-filter: blur(16px) saturate(140%)` on semi-transparent backgrounds for the topbar (`rgba(11,16,25,0.85)`) and mobile bottom bar (`rgba(11,16,25,0.92)`).
4. The Design System shall style WebKit scrollbars: `6px` width/height, transparent track, `--border-default` thumb with `3px` border-radius, `--border-strong` thumb on hover.

### Requirement 11: Animation Library

**Objective:** As a developer, I want a standard set of CSS keyframe animations and transition patterns, so that motion design is consistent and reusable.

#### Acceptance Criteria

1. The Design System shall define the following keyframe animations:
   - `pulse-dot`: 2.5s ease-in-out infinite — opacity 1 → 0.5 → 1
   - `fadeIn`: from opacity 0 to 1
   - `slideUp`: from translateY(10px) + opacity 0 to translateY(0) + opacity 1
   - `spin`: 0.8s linear infinite — rotate 0deg to 360deg
   - `pulse-border`: 1.5s ease-in-out infinite — box-shadow cyan glow oscillation
   - `staggerReveal`: 0.35s ease forwards — from translateY(8px) + opacity 0 to final
   - `slideUpSheet` (mobile only): from translateY(100%) to translateY(0)
2. The Design System shall provide a `.stagger-in` utility class that applies `staggerReveal` to direct children with `50ms` delay increments (up to 8 children: 0ms, 50ms, 100ms, ... 350ms).
3. The Design System shall use `transition: all 0.15s ease` for interactive element state changes.
4. The Design System shall use `transition: grid-template-columns 0.25s ease` for layout column changes.
5. When the main content area loads, the Design System shall apply a `fadeIn` animation at `0.2s`.

### Requirement 12: App Shell and Navigation Model

**Objective:** As a developer, I want a defined app shell structure with breadcrumb-only navigation, so that the application has a consistent frame across all views.

#### Acceptance Criteria

1. The Design System shall define the app shell (`.app`) as a flex column with `min-height: 100vh`, carrying a `data-page` attribute (`"projects"`, `"sessions"`, or `"detail"`) for context switching.
2. The Design System shall define a sticky topbar (`.topbar`) at `top: 0`, `z-index: 100`, with `--topbar-height` height, containing a brand section (left) and status section (right).
3. The Design System shall define the brand section: logo (`.topbar-logo`, display font, 800 weight, `1.1rem`, cyan with `text-shadow` glow), vertical divider, and breadcrumb navigation.
4. The Design System shall use the breadcrumb (`.topbar-breadcrumb`) as the sole navigation mechanism with format: `projects` → `projects / {project}` → `projects / {project} / {session}`. Separators use `--text-tertiary`, links use `--text-secondary` with hover to `--text-primary`, active session segment uses `.bc-session` class (`--text-primary`, 600 weight).
5. The Design System shall define the main content area (`.main`) as `flex: 1` with `--space-lg` padding, and reduced `--space-md` top/bottom padding on detail pages.
6. When the app is on a non-detail page, the Design System shall show global status indicators (`.topbar-status-default`) and hide session controls.
7. When the app is on the detail page, the Design System shall show session controls (`.topbar-status-session`) and hide global status indicators.
8. When displayed on mobile viewports (≤768px), the Design System shall condense the topbar: reduce logo to `0.95rem`, narrow brand gap, and truncate the breadcrumb to show only the last segment (hiding intermediate segments and separators).

### Requirement 13: Responsive Breakpoint System

**Objective:** As a developer, I want clearly defined responsive breakpoints with documented behavior changes at each tier, so that all components adapt predictably.

#### Acceptance Criteria

1. The Design System shall define three breakpoint tiers: desktop (>900px), tablet (≤900px), and mobile (≤768px).
2. When the viewport is ≤900px (tablet), the Design System shall: collapse split layouts to single column, collapse project grid to single column, wrap session info strip items, and reduce topbar session control spacing.
3. When the viewport is ≤768px (mobile), the Design System shall:
   - Enlarge all tappable elements to minimum 44×44px touch targets (buttons, icon buttons, nav buttons, diff toolbar buttons)
   - Enlarge `.btn-sm` to minimum `44px` height with increased padding
   - Present modals as bottom sheets
   - Display a fixed bottom action bar for session-detail controls
   - Scale page titles to `1.6rem`
   - Reduce main content padding to `--space-md`
   - Pin prompt input area to viewport bottom via `position: sticky`
4. When the viewport is ≤768px, the Design System shall support mobile panel switching via `data-mobile-panel` attribute on `.app`: `"chat"` hides diff panel, `"diff"` hides prompt panel.
5. The Design System shall ensure adequate spacing between touch targets (minimum `8px` gap) to prevent mis-taps on mobile.

### Requirement 14: Panel and Layout System

**Objective:** As a developer, I want a flexible panel layout system supporting multiple arrangement modes, so that the session detail view can be customized by the user.

#### Acceptance Criteria

1. The Design System shall define a session detail layout grid (`.session-detail-layout`) with two rows: info strip (auto height) and content area (fills `calc(100vh - var(--topbar-height) - var(--space-md) * 2)`), minimum `500px` height.
2. The Design System shall support four content-area layout modes via `data-layout` attribute on `.session-content-area`:
   - `"default"`: `1fr 420px` (conversation + fixed sidebar)
   - `"split"`: `1fr 1fr` (equal halves)
   - `"conversation"`: `1fr` (conversation only, diff hidden)
   - `"diff"`: `1fr` (diff only, conversation hidden)
3. The Design System shall define panel components (`.prompt-panel`, `.sidebar-diff-panel`) as flex columns with: panel header (`.panel-header`, flex, `--space-md --space-lg` padding, subtitle bottom border, semi-transparent background), scrollable body (`.panel-body`, `flex: 1`, overflow-y auto), and optional footer areas.
4. The Design System shall define panel titles (`.panel-title`) as `0.72rem` uppercase mono, 600 weight, `0.08em` letter-spacing, `--text-secondary` color.
5. When a layout mode hides a panel, the Design System shall set `display: none` on that panel and allocate full width to the remaining panel.
6. When the viewport is ≤768px, the Design System shall force single-column layout regardless of the selected layout mode, overriding all `data-layout` grid definitions.
7. The Design System shall persist layout switcher selection per-session.

### Requirement 15: Session Info Strip

**Objective:** As a developer, I want an ultra-compact metadata bar for session details, so that essential session info is always visible without consuming vertical space.

#### Acceptance Criteria

1. The Design System shall define the info strip (`.session-info-strip`) with `--bg-surface` background, `--border-subtle` border, `--radius-sm` radius, mono font at `0.68rem`.
2. The Design System shall display label-value pairs (`.si-item`) in a horizontal flex row on desktop, separated by thin vertical lines (`.si-sep`, `1px × 12px`, `--border-subtle`). Labels (`.si-label`) at `0.58rem`, uppercase, `--text-tertiary`; values (`.si-val`) in `--text-secondary`.
3. The Design System shall display metadata fields: branch name, created date/time, prompt count, and worktree path.
4. When displayed on mobile viewports (≤768px), the Design System shall collapse the info strip: show a summary line (`.si-summary`) by default with branch + status; hide details (`.si-details`); show details in a wrapped vertical layout when the `.expanded` class is applied.

### Requirement 16: Conversation Panel Components

**Objective:** As a developer, I want consistent conversation display styles for messages, code blocks, and the prompt input area.

#### Acceptance Criteria

1. The Design System shall render messages (`.message`) with a role label (`.message-role`) at `0.65rem`, 700 weight, uppercase mono, `0.1em` letter-spacing: user messages in `--amber`, assistant messages in `--cyan`.
2. The Design System shall render message content (`.message-content`) in body font at `0.9rem`, `1.65` line-height, `--text-primary` color. Assistant message content shall have a `2px` left border in `--border-default` with `--space-md` left padding.
3. The Design System shall render inline code in messages with mono font at `0.82rem`, `--bg-raised` background, `--cyan` color, `2px 6px` padding, `3px` border-radius.
4. The Design System shall render code blocks with `--bg-base` background, `--border-subtle` border, `--radius-md` radius, `--space-md` padding, horizontal scroll, mono font at `0.8rem`, `1.55` line-height, `--text-primary` color.
5. The Design System shall define message navigation (`.msg-nav`) with `20px` arrow buttons (`.nav-btn`) flanking a counter (`.msg-counter`, `0.62rem`, `--text-tertiary`, `28px` min-width, centered).
6. The Design System shall define the prompt input area (`.prompt-input-area`) pinned to the panel bottom with `--bg-base` background, containing a textarea (`.prompt-textarea`, mono font, `0.85rem`, `48–160px` height range) and a `48×48px` send button (`.send-btn`).
7. When the send button is in busy state (`.busy`), the Design System shall apply an outlined style with `--bg-raised` background, `--cyan` color, `--cyan-dim` border, and `pulse-border` animation.
8. When displayed on mobile viewports (≤768px), the Design System shall pin the prompt input area to the viewport bottom via `position: sticky; bottom: 0`.

### Requirement 17: Layout Switcher Component

**Objective:** As a developer, I want a grouped button bar for switching panel layout modes in the session detail view.

#### Acceptance Criteria

1. The Design System shall define the layout switcher (`.layout-switcher`) as a flex container with `3px` padding, `--bg-surface` background, `--border-subtle` border, `--radius-md` radius, and `2px` gap between buttons.
2. The Design System shall define layout buttons (`.layout-btn`) at `32×26px`, no border, transparent background, `--text-tertiary` color, containing inline SVG icons at `18×12px`.
3. When a layout button is active (`.active`), the Design System shall apply `--cyan` background and `--text-inverse` color.
4. When a layout button is hovered, the Design System shall apply `--bg-hover` background and `--text-secondary` color.
5. The Design System shall display tooltips on layout buttons via `data-tooltip` attribute and `::after` pseudo-element.
6. When displayed on mobile viewports (≤768px), the Design System shall hide the layout switcher from the topbar and replace it with a mobile panel tab switcher (`.mobile-panel-tabs`) in the bottom action bar.

### Requirement 18: Mobile Bottom Action Bar

**Objective:** As a developer, I want a fixed bottom bar on mobile for session-detail controls that are relocated from the topbar.

#### Acceptance Criteria

1. The Design System shall define the bottom bar (`.mobile-bottom-bar`) as a fixed element at `bottom: 0`, full width, `56px` height, `z-index: 100`, with frosted-glass background (`rgba(11,16,25,0.92)`, `backdrop-filter: blur(16px) saturate(140%)`), and `--border-subtle` top border.
2. The Design System shall apply `safe-area-inset-bottom` padding for notched devices.
3. The Design System shall display the bottom bar only on mobile viewports (≤768px) and hide it on desktop (`display: none`).
4. The Design System shall contain the mobile panel tab switcher (`.mobile-panel-tabs`) and action buttons (`.mobile-actions`) within the bottom bar.
5. The Design System shall define mobile tabs (`.mobile-tab`) at `64px` min-width, `36px` height, mono font at `0.72rem`, 600 weight, uppercase. Active tab (`.active`) uses `--cyan` background and `--text-inverse` color.
6. When the detail page has a mobile bottom bar visible, the Design System shall add bottom padding to `.main` to prevent content from being obscured.

### Requirement 19: Table Component Pattern

**Objective:** As a developer, I want a standardized table pattern for data-dense views, so that session lists and similar tabular data are displayed consistently.

#### Acceptance Criteria

1. The Design System shall style the sessions table (`.sessions-table`) as full-width with `border-collapse: collapse`.
2. The Design System shall style table headers (`th`) as `0.65rem` uppercase mono text, 600 weight, `0.1em` letter-spacing, `--text-tertiary` color, left-aligned, `--space-sm --space-md` padding, `--border-default` bottom border.
3. The Design System shall style table cells (`td`) with `--space-md` padding, `--border-subtle` bottom border, `0.88rem` font.
4. The Design System shall style table rows as clickable elements (`cursor: pointer`) with a `0.1s ease` background transition, hovering to `--bg-surface`.
5. The Design System shall define session name cells (`.session-name`, mono, 600 weight), branch chips (`.session-branch`, `0.75rem` mono, `--bg-raised` background, `--border-subtle` border, `--radius-sm`), and session time (`.session-time`, `0.78rem` mono, `--text-secondary`).
6. When displayed on mobile viewports (≤768px), the Design System shall hide columns 4 and 5, and reduce cell padding to `--space-sm`.

### Requirement 20: Diff Display Styles

**Objective:** As a developer, I want a complete set of diff-specific styles, so that code changes are displayed with clear visual distinction.

#### Acceptance Criteria

1. The Design System shall style the diff content area (`.diff-content`) with mono font at `0.75rem`, `1.7` line-height, scrollable overflow.
2. The Design System shall style diff lines (`.diff-line`) with `--space-md` horizontal padding, `white-space: pre`, and a `3px` transparent left border:
   - Addition (`.add`): green text, green left border, `rgba(0,230,118,0.06)` background
   - Deletion (`.remove`): red text, red left border, `rgba(255,61,90,0.06)` background
   - Context (`.context`): `--text-tertiary`, no border highlight
   - Hunk header (`.hunk-header`): `--cyan-dim` text, `--cyan-glow` background, 500 weight
3. The Design System shall style file headers (`.diff-file-header`) as sticky elements (`top: 0`, `z-index: 1`) with `--bg-raised` background, clickable (`cursor: pointer`), containing: collapse chevron (`.diff-file-chevron`, `0.65rem`, `--text-tertiary`, `0.15s` rotation transition), file name (`.diff-file-name`, 600 weight, `--text-secondary`, ellipsis-truncated), and per-file stats (`.diff-file-stat`, green `.add-count` + red `.rm-count`).
4. When a file section is collapsed (`.collapsed`), the Design System shall hide the diff lines and rotate the chevron by `-90deg`.
5. The Design System shall define a diff toolbar (`.diff-toolbar`) as a compact strip with `4px --space-md` padding, `--border-subtle` bottom border, containing button groups separated by `1px` vertical separators (`.diff-toolbar-sep`), with toolbar labels (`.diff-toolbar-label`, `0.58rem`, uppercase mono) and nav buttons (`.diff-nav-btn`, `22px` height, `22px` min-width).
6. When displayed on mobile viewports (≤768px), the Design System shall enlarge diff toolbar buttons to `44px` touch targets and allow the toolbar to wrap.

### Requirement 21: Banner Components

**Objective:** As a developer, I want consistent banner/alert styles for system notifications like hooks status.

#### Acceptance Criteria

1. The Design System shall define a hooks banner (`.hooks-banner`) with `--amber-glow` background, `rgba(255,179,0,0.2)` border, `--radius-md` radius, `--space-md --space-lg` padding, mono font at `0.78rem`, `--amber` text.
2. The Design System shall structure banners with: icon (`.banner-icon`, `1.1rem`, flex-shrink 0), text (`.banner-text`, flex 1), and action (`.banner-action`, flex-shrink 0).
3. The Design System shall define a running indicator (`.running-indicator`) with `--cyan-glow` background, `rgba(0,229,255,0.15)` border, mono font at `0.78rem`, `--cyan` text, `fadeIn` animation, containing a spinner (`.spinner`, `14px`, `0.8s` linear infinite spin, `--cyan` top border).

### Requirement 22: Empty State Pattern

**Objective:** As a developer, I want consistent empty-state styling for when lists have no content.

#### Acceptance Criteria

1. The Design System shall define empty states (`.empty-state`) as flex column, centered alignment, `--space-3xl --space-xl` padding, centered text.
2. The Design System shall define empty-state elements: icon (`.empty-state-icon`, `2.5rem`, 30% opacity), title (`.empty-state-title`, display font, 700 weight, `1.1rem`, `--text-secondary`), description (`.empty-state-desc`, mono font, `0.78rem`, `--text-tertiary`, `320px` max-width).

### Requirement 23: Implementation Constraints

**Objective:** As a developer, I want documented implementation rules for how design tokens integrate with the Next.js tech stack.

#### Acceptance Criteria

1. The Design System shall load fonts via `next/font/google` for Anybody, Manrope, and Geist Mono, applying them through the CSS variable pattern.
2. The Design System shall apply noise and scan-line overlays as `body`-level pseudo-elements in global CSS.
3. The Design System shall never introduce secondary navigation bars, tab strips, or view switchers below the topbar — the topbar is always the sole persistent navigation surface.
4. The Design System shall ensure the session detail view is full-bleed: the entire viewport minus the `56px` topbar is available for content as a CSS Grid.
5. The Design System shall scope diff panel collapse state per-session. When navigation buttons target a collapsed file section, the Design System shall auto-expand that section.
6. The Design System shall apply CSS class naming in kebab-case BEM-style (e.g., `project-card-header`, `topbar-breadcrumb`, `diff-file-stat`).
