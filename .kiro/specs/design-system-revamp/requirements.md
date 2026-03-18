# Requirements Document

## Introduction

This specification addresses all findings from a comprehensive UI audit of the CC application. The audit identified critical accessibility failures (WCAG AA contrast violations, sub-minimum font sizes), visual inconsistencies (3+ distinct tab patterns, 2+ section header patterns, 4+ badge variants), and polish gaps (card under-differentiation, dead space, misplaced controls) across all four main views.

The scope is a focused revision of the existing design system — token adjustments, pattern canonicalization, and visual hierarchy improvements — not a redesign. The "Ground Control" visual identity (dark theme, cyan accents, mono-heavy typography, atmospheric effects) is preserved.

## Requirements

### Requirement 1: Text Color Contrast Accessibility

**Objective:** As a user, I want all text to meet WCAG AA contrast requirements, so that I can read content comfortably on all screens regardless of vision ability.

#### Acceptance Criteria

1. The design system shall define `--text-tertiary` with a color value that achieves at minimum a 4.5:1 contrast ratio against `--bg-void` (#06090f).
2. The design system shall define `--text-tertiary` with a color value that achieves at minimum a 4.5:1 contrast ratio against `--bg-surface` (#111825).
3. The design system shall define `--text-tertiary` with a color value that achieves at minimum a 3:1 contrast ratio against `--bg-raised` (#172033).
4. The design system shall define `--text-secondary` with a color value that maintains at minimum a 4.5:1 contrast ratio against `--bg-void` (#06090f).
5. The design system shall ensure all accent color text tokens (`--cyan-dim`, `--amber-dim`, `--green-dim`, `--red-dim`) achieve at minimum a 4.5:1 contrast ratio against `--bg-surface`.
6. The design system shall not introduce any new text-on-background combination that fails WCAG AA (4.5:1 for normal text, 3:1 for large text ≥18.66px bold or ≥24px).

### Requirement 2: Minimum Font Size Floor

**Objective:** As a user, I want all text in the application to be at least minimally legible, so that I can read labels, metadata, and controls without straining.

#### Acceptance Criteria

1. The design system shall establish 0.7rem (11.2px at default browser settings) as the absolute minimum font-size for any rendered text in the application.
2. CC shall not render any text element smaller than 0.7rem in desktop viewports (>900px).
3. CC shall not render any text element smaller than 0.7rem in mobile viewports (≤768px).
4. When the existing CSS contains font-size declarations below 0.7rem (currently 152 occurrences including values as low as 0.48rem), the design system shall raise each to at minimum 0.7rem while preserving the relative size hierarchy between elements (i.e., labels that were smaller than body text should remain smaller, but not below the floor).
5. The design system shall update the Typography Patterns Quick Reference in the design spec to reflect the new minimum and any adjusted sizes.

### Requirement 3: Icon and Interactive Element Sizing

**Objective:** As a user, I want icons and interactive elements to be large enough to see clearly and click/tap accurately, so that I can interact with the interface without frustration.

#### Acceptance Criteria

1. The design system shall establish 20px as the minimum rendered size (width and height) for any icon that conveys meaning or is interactive on desktop viewports (>768px).
2. The design system shall establish 44px as the minimum touch target size (width and height) for all interactive elements on mobile viewports (≤768px), per WCAG 2.5.5.
3. When icon buttons are currently sized below 24px on desktop (currently 65+ occurrences), CC shall increase them to at minimum 24px, excluding purely decorative elements (separators, scrollbar tracks, progress bar tracks, status dots).
4. The design system shall ensure all icon buttons have sufficient color contrast — icon color against button background shall achieve at minimum 3:1 contrast ratio.
5. The design system shall increase the minimum icon SVG size inside buttons from the current 10-14px to at minimum 16px on desktop.
6. While on mobile viewports (≤768px), CC shall ensure all icon buttons render at minimum 44×44px touch target area (via padding if the visual icon is smaller).

### Requirement 4: Canonical Tab/Filter Pattern

**Objective:** As a user, I want all tab-like and filter controls across the app to look and behave identically, so that the interface feels unified and I can transfer learned interactions between pages.

#### Acceptance Criteria

1. The design system shall define exactly ONE canonical tab/filter pattern with the following states: inactive, hover, active, and optional count badge.
2. CC shall apply the canonical tab pattern to the project page filter controls (ALL / ACTIVE / RUNNING / IDLE / Archived), replacing the current inconsistency where the "Archived" button uses a different visual treatment from the other filter pills.
3. CC shall apply the canonical tab pattern to the conversation sidebar tabs (SESSION / ACTIVE), replacing the current `convo-sidebar-tabs` implementation.
4. CC shall apply the canonical tab pattern to the git panel tabs (Changes / Commits), replacing the current underline-style `git-panel-tabs` implementation.
5. CC shall apply the canonical tab pattern to the diff panel tabs (Uncommitted / Commits), ensuring it matches all other tab instances.
6. The canonical tab pattern shall use mono font, consistent sizing (minimum 0.72rem text), and the established semantic color tokens for active state (cyan).
7. When a tab has an associated count, the tab shall display the count using a consistent badge treatment (same size, shape, color, and position relative to the label across all instances).

### Requirement 5: Canonical Section Header Pattern

**Objective:** As a user, I want all section headers across the app to share a unified visual treatment, so that I can quickly identify and distinguish sections regardless of which page I'm on.

#### Acceptance Criteria

1. The design system shall define exactly ONE canonical section header pattern with the following optional elements: collapse toggle, label, count/badge, and trailing actions.
2. CC shall apply the canonical section header pattern to the PINNED section on the projects page, replacing the current `pinned-section-header` implementation.
3. CC shall apply the canonical section header pattern to the ROADMAP section on the project sessions page, replacing the current `roadmap-header` implementation.
4. CC shall apply the canonical section header pattern to the CONVERSATIONS section in the session detail sidebar, replacing the current `convo-sidebar-title` implementation.
5. CC shall apply the canonical section header pattern to the GIT section in the session detail view, ensuring consistency with all other section headers.
6. The canonical section header shall use mono font at minimum 0.72rem, uppercase text, consistent letter-spacing, and `--text-secondary` color for the label (not `--text-tertiary`).
7. When a section header includes a count, the count shall be displayed using a consistent treatment (same font-size, color, and position) across all instances.
8. When a section header is collapsible, the collapse toggle (chevron) shall use a minimum 16px icon size and animate with the same transition timing (0.15s ease) across all instances.

### Requirement 6: Canonical Badge System

**Objective:** As a user, I want badges, pills, and tags across the app to follow a unified visual system, so that I can quickly parse status, type, and count information consistently.

#### Acceptance Criteria

1. The design system shall define a canonical badge system with three tiers: **status badges** (semantic state — running, merged, idle, awaiting), **type badges** (category — feature, bug, idea), and **count badges** (numeric — session count, prompt count, commit count).
2. Status badges shall use the established semantic color mapping: cyan for running/active, green for merged/ready, amber for awaiting/warning, and the neutral palette for idle.
3. Type badges shall use the established semantic color mapping: cyan for feature, red for bug, amber for idea.
4. Count badges shall use a neutral treatment (not semantic color) unless the count indicates an active state.
5. The design system shall establish consistent sizing across all badge tiers: minimum 0.7rem font-size, consistent padding (horizontal ≥8px, vertical ≥2px), consistent border-radius (pill shape), and mono font at 600 weight.
6. CC shall apply the canonical badge system to project card badges (session count/status), replacing the current `project-badge` variants.
7. CC shall apply the canonical badge system to session table badges (MERGED, FAST), ensuring visual weight is proportional to importance (status badges should be less visually dominant in table rows where every row has the same status).
8. CC shall apply the canonical badge system to roadmap type badges (FEATURE, BUG, IDEA), ensuring consistent sizing with other badge instances.

### Requirement 7: Empty State and Null Value Treatment

**Objective:** As a user, I want empty states and missing data to be clearly communicated with intentional design, so that I never mistake absent data for a broken interface.

#### Acceptance Criteria

1. The design system shall define a canonical empty state treatment with: centered layout, icon (minimum 2rem, 40% opacity), title in display font, and description in mono font.
2. CC shall apply the canonical empty state to the conversation panel "No messages yet" state.
3. CC shall apply the canonical empty state to any other view that can render with zero content (empty session list, empty diff panel, empty roadmap).
4. When a data field has no value (currently displayed as "—"), CC shall replace the dash with either the numeric zero ("0") where the field represents a count, or a muted "none" text in `--text-tertiary` color where the field represents a non-numeric value (e.g., "LAST ACTIVE").
5. The null value treatment shall be consistent across all views — project card stats, session table cells, and metadata strips shall all use the same pattern for absent data.

### Requirement 8: Project Card Visual Differentiation

**Objective:** As a user, I want to immediately distinguish active projects from idle ones when scanning the dashboard, so that I can quickly find the projects that need my attention.

#### Acceptance Criteria

1. While a project has active (running) sessions, CC shall render its card with a visible at-rest accent (subtle cyan border tint or glow) that does not require hover interaction to be visible.
2. While a project has sessions but none are running, CC shall render its card with a moderate visual treatment that distinguishes it from fully idle cards but is less prominent than the active treatment.
3. While a project has zero sessions (idle), CC shall render its card with a visually recessive treatment (dimmed border, reduced contrast) that clearly communicates inactivity.
4. While a project is pinned, CC shall render its card with a visible pinned indicator (amber accent) that is distinguishable from the active/idle state treatment, at rest without requiring hover.
5. The design system shall ensure that the hover effect on cards enhances the at-rest state (e.g., active cards glow brighter on hover) rather than being the sole source of visual differentiation.
6. The card visual hierarchy at rest, from most to least prominent, shall be: active (running sessions) > has-sessions (not running) > idle (no sessions).

### Requirement 9: Page Composition and Dead Space

**Objective:** As a user, I want each page to feel complete and well-composed, so that no view feels sparse, broken, or unfinished.

#### Acceptance Criteria

1. When the merged session view displays minimal content (single conversation, few commits), CC shall group related elements closer together and use appropriate max-width constraints to prevent content from appearing lost in a full-width viewport.
2. When the session detail view has a conversation sidebar, CC shall render the sidebar at sufficient width to display session names, project names, and prompt descriptions without excessive truncation (minimum 220px, aim for showing at least 30 characters of session name).
3. CC shall visually integrate the roadmap section and sessions table on the project sessions page with consistent container treatment (either both contained in bordered panels, or both using open layout with consistent spacing).
4. The design system shall establish consistent section spacing between major content blocks across all views (using spacing tokens, not arbitrary pixel values).
5. When a page has fewer content elements than expected (e.g., merged session with 1 conversation, 1-2 commits), CC shall not allow the content to float in the center of a vast empty area — content shall be anchored to the top of the content area with natural vertical flow.

### Requirement 10: Control Placement and Visual Weight

**Objective:** As a user, I want controls to live in appropriate locations with visual weight proportional to their importance, so that the interface hierarchy guides my attention correctly.

#### Acceptance Criteria

1. CC shall not place interactive controls (toggles, buttons) within metadata-only display strips. The TDD toggle shall be relocated from the session info strip to a more appropriate location (e.g., the topbar controls area or a settings panel).
2. The roadmap action buttons (play/start, reorder, delete) shall use a subdued visual treatment (outline or ghost style) rather than the current prominent filled cyan treatment, so that action buttons do not draw more attention than the roadmap content itself.
3. When session table rows all share the same status (e.g., all MERGED in an archived view), CC shall reduce the visual weight of repetitive status badges — either by omitting them when redundant with the view context, or by using a more subdued badge variant.
4. The design system shall define a visual weight hierarchy for action buttons: primary actions (cyan filled) > secondary actions (outline) > tertiary/utility actions (ghost/icon-only).
5. The session table "Delete" button shall remain visually distinct as a danger action (red treatment) while "Unarchive" and other non-destructive actions shall use the secondary (outline) treatment.

### Requirement 11: Spacing and Layout Consistency

**Objective:** As a user, I want consistent spacing throughout the application, so that the interface feels cohesive and professionally crafted.

#### Acceptance Criteria

1. The design system shall define standard spacing values for: space between major sections on a page, space between a section header and its content, and space between items within a section.
2. CC shall apply consistent major section spacing across all views — the gap between the roadmap section and the sessions table, the gap between the info strip and the content area, and the gap between content sections shall all use the same spacing token.
3. CC shall apply consistent header-to-content spacing — the distance from any section header to the first item in that section shall be uniform across all instances.
4. The design system shall document these standard spacings in the design spec under a "Spacing Patterns" section.

### Requirement 12: Design System Specification Synchronization

**Objective:** As a developer, I want the design system spec to accurately reflect all revamp changes, so that future development uses the correct reference.

#### Acceptance Criteria

1. When token values are modified (e.g., `--text-tertiary` hex value), CC shall update the design spec (`.kiro/specs/ui-design-system/design.md`) to reflect the new values.
2. When new canonical patterns are established (tabs, section headers, badges, empty states), CC shall add them to the design spec as documented component contracts with usage rules.
3. When minimum sizes or floors are established (font-size floor, icon size minimums), CC shall add them to the design spec under Implementation Rules.
4. The design spec shall include a new "Canonical Patterns" section documenting each canonical pattern (tabs, section headers, badges, empty states, null values) with: visual specification, required elements, state definitions, and usage locations.
5. The design spec shall include a new "Accessibility Minimums" section documenting: contrast ratio requirements, minimum font sizes, minimum touch target sizes, and icon size minimums.
