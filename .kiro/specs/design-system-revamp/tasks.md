# Implementation Plan

- [x] 1. Token Layer Foundation
- [x] 1.1 Update text contrast tokens and add accent text token for WCAG AA compliance
  - Change `--text-tertiary` from `#4d5a72` to `#738699` in the `:root` block to achieve minimum 4.5:1 contrast against void and surface backgrounds
  - Add `--red-text: #e8506c` token and replace the `--red-dim` text color usage in the context-fill danger percentage label with the new token
  - Verify `--text-secondary` (#7b899f) already passes WCAG AA — no change needed
  - Confirm `--cyan-dim`, `--amber-dim`, `--green-dim` pass WCAG AA when used as text on dark backgrounds — no changes needed
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 1.2 Add sizing floor and spacing semantic tokens
  - Add `--font-size-floor: 0.7rem`, `--icon-size-min: 20px`, `--icon-btn-min: 24px`, `--touch-target-min: 44px` as reference tokens in `:root`
  - Add `--space-section: var(--space-xl)`, `--space-header-content: var(--space-sm)`, `--space-item: var(--space-xs)` as semantic spacing tokens in `:root`
  - _Requirements: 2.1, 3.1, 3.5, 11.1_

- [x] 2. Font Size Floor Enforcement
- [x] 2.1 Apply mechanical mapping rule to all font-size declarations below the floor
  - Find all `font-size` declarations ≤0.65rem in `globals.css` and raise them to 0.7rem (tier 1)
  - Find all `font-size` declarations between 0.66rem and 0.69rem and raise them to 0.72rem (tier 2)
  - For sibling elements where both map to tier 1 and the hierarchy loss is visually significant, upgrade the previously larger element to tier 2 (0.72rem) — document each exception as a code comment
  - _Requirements: 2.1, 2.2, 2.4_

- [x] 2.2 Verify font-size floor in responsive and media query overrides
  - Check all `@media` blocks and responsive overrides for `font-size` declarations below 0.7rem and raise them per the same mechanical mapping rule
  - Ensure mobile viewports (≤768px) do not introduce any sub-floor font sizes
  - _Requirements: 2.3_

- [x] 3. Icon and Interactive Element Sizing
- [x] 3.1 Increase icon and button sizes to meet desktop minimums
  - Raise SVG icon sizes inside buttons from 10–14px to minimum 16px width and height
  - Raise icon button dimensions from 18–22px to minimum 24px width, height, and min-width on desktop
  - Exclude purely decorative elements (status dots, separators, scrollbar tracks, progress bar tracks) from the size increase
  - Scale toggle track to minimum 28px wide by 16px tall with 12px knob
  - _Requirements: 3.1, 3.3, 3.5_

- [x] 3.2 Add mobile touch target minimums for interactive elements
  - Add `min-width: 44px` and `min-height: 44px` to all icon buttons in mobile viewports (≤768px), using padding to expand touch targets without increasing visual size
  - Verify icon button color contrast achieves at minimum 3:1 ratio (icon color vs button background)
  - _Requirements: 3.2, 3.4, 3.6_

- [x] 4. Canonical Tab Pattern
- [x] 4.1 Define canonical tab CSS classes with all states and count badge
  - Add `.cc-tabs` container (flex, gap: 2px, padding: 3px, border, radius) and `.cc-tab` individual tab (mono font, 0.72rem, 500 weight, rounded, transition) to `globals.css`
  - Define inactive (transparent bg, `--text-secondary`), hover (`--bg-hover`, `--text-primary`), active (`--cyan` bg, inverse text) states
  - Add `.cc-tab-count` sub-pattern for inline count badges (0.7rem, pill shape, opacity 0.85; higher opacity in active tab)
  - Set minimum tab height: 28px desktop, 36px mobile; add `flex: 1` modifier for mobile full-width distribution
  - _Requirements: 4.1, 4.6, 4.7_

- [x] 4.2 Replace all existing tab and filter implementations with the canonical pattern
  - Migrate `.filter-pills` / `.filter-pill` in ProjectsGrid, DiffPanel, RightPane, and SessionDiffViewer — make the "Archived" button use the same `.cc-tab` treatment as other filter pills
  - Migrate `.convo-sidebar-tabs` / `.convo-sidebar-tab` in ConversationSidebar to `.cc-tabs` / `.cc-tab`
  - Migrate `.git-panel-tabs` / `.git-panel-tab` in SessionGitPanel from underline style to pill style
  - Migrate `.spec-browser-tabs` / `.spec-browser-tab` and `.spec-browser-pills` / `.spec-browser-pill` in SpecBrowser
  - Migrate `.mobile-panel-tabs` / `.mobile-tab` in SessionDetailPage with `flex: 1` modifier for mobile
  - Remove all old tab CSS class definitions from `globals.css` after updating React component class references
  - _Requirements: 4.2, 4.3, 4.4, 4.5_

- [x] 5. Canonical Section Header Pattern
- [x] 5.1 Define canonical section header CSS classes
  - Add `.cc-section-header` container (flex, align-items center, gap: `var(--space-sm)`), `.cc-section-chevron` (16px, rotate animation 0.15s ease), `.cc-section-label` (mono, 0.72rem, 600 weight, uppercase, 0.08em tracking, `--text-secondary`), `.cc-section-count` (mono, 0.7rem, 400 weight, `--text-tertiary`, parenthesized), and `.cc-section-actions` (margin-left auto, flex, gap) to `globals.css`
  - _Requirements: 5.1, 5.6, 5.7, 5.8_

- [x] 5.2 Replace all section header implementations with the canonical pattern
  - Migrate PINNED section header in ProjectsGrid (no collapse, label "Pinned", pinned count, no trailing actions) — remove the star icon, rely on label plus amber card borders for the visual cue
  - Migrate ROADMAP section header in RoadmapItemsPanel (collapse, label "Roadmap", active count, archive toggle + add button as trailing actions)
  - Migrate CONVERSATIONS section header in ConversationSidebar (collapse, label "Conversations", no count, collapse button as trailing action)
  - Migrate GIT section header in SessionGitPanel (collapse, label "Git", commit/file count, view diff + actions as trailing)
  - Upgrade label color from `--text-tertiary` to `--text-secondary` in all instances
  - Remove all old section header CSS class definitions from `globals.css`
  - _Requirements: 5.2, 5.3, 5.4, 5.5_

- [x] 6. Canonical Badge System
- [x] 6.1 Define canonical badge CSS with status, type, count tiers and subtle variant
  - Add `.cc-badge` base (inline-flex, mono, 0.7rem, 600 weight, pill shape, 2px 8px padding) and tier modifiers (`.cc-badge--status`, `.cc-badge--type`, `.cc-badge--count`, `.cc-badge--subtle`) to `globals.css`
  - Implement status color mapping: cyan for running/active, green for merged/ready, amber for awaiting, neutral for idle
  - Implement type color mapping: cyan for feature, red for bug, amber for idea
  - Implement count badge: neutral default (`--bg-raised`, `--text-secondary`), cyan variant when parent has running sessions
  - Implement subtle variant at 50% background opacity for repetitive contexts
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 6.2 Replace all badge implementations with the canonical pattern
  - Migrate `.project-badge` in ProjectCard to `.cc-badge .cc-badge--status` or `.cc-badge--count`
  - Migrate `.session-badge` in SessionsTable to `.cc-badge .cc-badge--status` with `.cc-badge--subtle` applied when the current filter/view context makes the badge redundant (e.g., all MERGED in archived view)
  - Migrate `.roadmap-type` in RoadmapItemsPanel to `.cc-badge .cc-badge--type`
  - Keep session creation mode badge (FAST/FOCUS) at normal weight since it varies between rows
  - Remove all old badge CSS class definitions from `globals.css`
  - _Requirements: 6.6, 6.7, 6.8, 10.3_

- [x] 7. Empty States, Null Values, and Card Differentiation
- [x] 7.1 Standardize null value display across project cards and session tables
  - Replace "—" with "0" for count fields (sessions, prompts) in ProjectCard and SessionsTable
  - Keep "—" for temporal fields (last active) but apply `.stat-value--empty` class with explicit `--text-tertiary` color and `font-style: normal`, making the placeholder clearly intentional
  - Ensure consistent null value treatment across all views (project card stats, session table cells, metadata strips)
  - _Requirements: 7.4, 7.5_

- [x] 7.2 Ensure all empty views use the canonical empty-state pattern
  - Verify conversation panel "No messages yet" state uses the existing `.empty-state` pattern (centered flex, icon at 2rem with 40% opacity, display font title, mono description)
  - Apply canonical empty state to empty session list, empty diff panel, and empty roadmap views
  - _Requirements: 7.1, 7.2, 7.3_

- [x] 7.3 Add activity-based visual hierarchy to project cards
  - Add at-rest CSS for `.project-card.active`: 3px left cyan border with subtle cyan glow (`box-shadow`), intensified glow on hover
  - Add CSS for `.project-card.has-sessions`: standard border, full opacity, normal hover enhancement
  - Add CSS for `.project-card.idle`: `opacity: 0.65`, dimmed border, opacity lifts to 0.85 on hover
  - Enhance `.project-card.pinned` amber border tint to be more visible at rest, with stacking behavior when combined with active or idle states
  - Update ProjectCard component to apply the correct activity-state CSS class based on session count and running status
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [x] 8. Page Composition and Control Placement
- [x] 8.1 Fix merged session view layout and conversation sidebar width
  - Add `max-width: 800px` to the merged session content container (only when session status is merged) to prevent content from stretching across full viewport
  - Reduce spacing between metadata strip, merge banner, git section, and conversation cards in merged view
  - Increase conversation sidebar minimum width to 220px and default width to 240px in the session detail layout grid template columns
  - Ensure sparse content is anchored to the top with natural vertical flow, not floating in empty space
  - _Requirements: 9.1, 9.2, 9.5_

- [x] 8.2 Relocate TDD toggle from session info strip to topbar
  - Remove the TDD toggle from the session info strip in SessionDetailPage
  - Add the TDD toggle (compact variant) to the topbar right-side area, positioned before the layout switcher
  - Keep the per-row TDD toggle in the sessions table unchanged — it is appropriately placed as a per-session control
  - _Requirements: 10.1_

- [x] 8.3 Reduce roadmap action button weight and define button weight hierarchy
  - Change roadmap action buttons (start, reorder, delete) from filled cyan to ghost style (transparent background, `--border-default`, `--bg-hover` on hover)
  - Define CSS for the 4-tier button weight hierarchy: primary (cyan bg, inverse text), secondary (outline with `--border-default`, `--text-secondary`), tertiary (ghost, transparent bg, `--text-tertiary`, border on hover), danger (red outline with red text)
  - Ensure session table "Delete" button uses danger treatment while "Unarchive" uses secondary (outline) treatment
  - Apply consistent container treatment for roadmap and sessions table on the project sessions page (both bordered panels or both open layout)
  - _Requirements: 9.3, 10.2, 10.4, 10.5_

- [x] 9. Apply spacing tokens consistently across all views
  - Replace arbitrary pixel spacing between PINNED and unpinned sections on the projects page with `--space-section`
  - Apply `--space-section` between roadmap and filter/table area on the sessions page
  - Apply `--space-header-content` from table headers to first row on the sessions page
  - Apply `--space-section` between info strip and content area on the session detail page
  - Apply `--space-header-content` from section headers to panel content on the session detail page
  - Apply `--space-section` between metadata, banner, git, and conversations in the merged view
  - _Requirements: 9.4, 11.2, 11.3_

- [x] 10. Design System Spec Synchronization
- [x] 10.1 Update token values and typography reference in the design spec
  - Update `--text-tertiary` hex value in all token tables in `.kiro/specs/ui-design-system/design.md`
  - Add `--red-text` token documentation to the color tokens section
  - Update the Typography Patterns Quick Reference to reflect the 5-tier font-size system with 0.7rem floor
  - _Requirements: 2.5, 12.1_

- [x] 10.2 Add Canonical Patterns, Accessibility Minimums, and Spacing Patterns sections
  - Add "Accessibility Minimums" section documenting: WCAG AA contrast ratio requirements, 0.7rem font-size floor, 20px icon minimum, 44px touch target minimum, 24px icon button minimum
  - Add "Canonical Patterns" section documenting each pattern (tabs `.cc-tabs`/`.cc-tab`, section headers `.cc-section-header`, badges `.cc-badge` tiers, empty states, null value treatment) with visual specification, state definitions, and usage locations
  - Add "Spacing Patterns" section documenting `--space-section`, `--space-header-content`, `--space-item` tokens and where they apply across views
  - Add button weight hierarchy (primary, secondary, tertiary, danger) to Implementation Rules
  - _Requirements: 11.4, 12.2, 12.3, 12.4, 12.5_
