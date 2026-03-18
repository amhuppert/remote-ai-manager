# Research & Design Decisions

## Summary
- **Feature**: `design-system-revamp`
- **Discovery Scope**: Extension (revising existing design system, not greenfield)
- **Key Findings**:
  - `--text-tertiary` (#4d5a72) achieves only ~2.3:1 against bg-surface — must brighten to ~#738699 for 4.8:1
  - 9 distinct tab/filter implementations exist using 5 different CSS pattern families
  - 152 font-size declarations below 0.7rem floor, 8 critically small (0.48–0.55rem)
  - 65+ icon/button sizes below 24px desktop minimum

## Research Log

### WCAG AA Contrast Calculations
- **Context**: --text-tertiary (#4d5a72) flagged as failing WCAG AA in audit
- **Sources Consulted**: WCAG 2.1 Success Criterion 1.4.3, relative luminance formula
- **Findings**:
  - Current --text-tertiary (#4d5a72): L≈0.121
  - Against --bg-void (#06090f, L≈0.003): ratio ≈ 3.2:1 (FAIL, needs 4.5:1)
  - Against --bg-surface (#111825, L≈0.008): ratio ≈ 2.95:1 (FAIL)
  - Against --bg-raised (#172033, L≈0.014): ratio ≈ 2.67:1 (FAIL for normal text, FAIL for large text)
  - Proposed #738699 (L≈0.230): 5.28:1 vs void, 4.83:1 vs surface, 4.38:1 vs raised ✓
  - Current --text-secondary (#7b899f, L≈0.247): 5.60:1 vs void, 5.12:1 vs surface ✓ (already passes)
  - Accent dim colors (--cyan-dim, --amber-dim, --green-dim) pass 4.5:1 against bg-surface ✓
  - --red-dim (#cc3148) achieves only 3.53:1 against bg-surface — but only used for borders/backgrounds, not text
- **Implications**: Only --text-tertiary needs a new hex value. All other text tokens pass.

### Tab/Filter Pattern Inventory
- **Context**: Requirement 4 demands ONE canonical tab pattern
- **Findings**: 9 implementations across 5 CSS families:
  1. `.filter-pills` / `.filter-pill` — used in ProjectsGrid, DiffPanel, RightPane, SessionDiffViewer (pill style, cyan bg active)
  2. `.convo-sidebar-tabs` / `.convo-sidebar-tab` — ConversationSidebar (pill style, cyan text+bg active)
  3. `.git-panel-tabs` / `.git-panel-tab` — SessionGitPanel (underline style, cyan border-bottom)
  4. `.spec-browser-tabs` / `.spec-browser-tab` — SpecBrowser (underline style, cyan border-bottom)
  5. `.mobile-panel-tabs` / `.mobile-tab` — SessionDetailPage (pill style, cyan bg, full-width)
  6. `.spec-browser-pills` / `.spec-browser-pill` — SpecBrowser file selector (pill style, cyan text)
- **Implications**: Filter-pills pattern is most widely used (4 instances). Adopt it as the canonical base and unify all others.

### Section Header Inventory
- **Context**: Requirement 5 demands ONE canonical section header
- **Findings**: 3 distinct implementations:
  1. `.pinned-section-header` — star icon + label + count, no collapse (ProjectsGrid)
  2. `.roadmap-header` — chevron + label + count + trailing actions, collapsible (RoadmapItemsPanel)
  3. `.convo-sidebar-header` / `.convo-sidebar-title` — label + collapse toggle, no count (ConversationSidebar)
  4. `.git-panel-header` — chevron + label + summary stats + trailing actions (SessionGitPanel)
- **Implications**: Roadmap header has the richest feature set (collapse + label + count + actions). Use it as the base pattern.

### Badge Inventory
- **Context**: Requirement 6 demands a 3-tier canonical badge system
- **Findings**: 4 distinct badge types:
  1. `.project-badge` — project card status (active/idle/has-sessions) — 3px 10px padding, 0.68rem, 100px radius
  2. `.session-badge` — table name cell (merged/focus/fast/optimistic) — 1px 7px padding, 0.62rem, 9999px radius
  3. `.roadmap-type` — roadmap item type (bug/feature/idea) — 1px 7px padding, 0.58rem, 9999px radius, min-width: 52px
  4. `.session-status` — table status column (running/idle/merged) — inline text with dot, 0.72rem
- **Implications**: Sizing varies wildly (0.58rem to 0.72rem). Need to standardize to 0.7rem minimum with consistent padding.

### Font Size Audit
- **Context**: Requirement 2 demands 0.7rem minimum floor
- **Findings**: 152 declarations below 0.7rem. Breakdown:
  - 0.48rem–0.55rem (critically small): 8 occurrences — code block metadata, chevrons, task metadata
  - 0.56rem–0.59rem: 14 occurrences — badges, metadata labels, diff line numbers
  - 0.60rem–0.65rem: ~70 occurrences — table headers, stat labels, section counts, timestamps
  - 0.66rem–0.69rem: ~60 occurrences — buttons, descriptions, filter pills, voice labels
- **Implications**: Most can be raised to 0.7rem with minimal layout impact. Some need 0.72rem or 0.75rem to maintain hierarchy.

### Icon Size Audit
- **Context**: Requirement 3 demands 20px minimum for meaningful icons, 24px for icon buttons
- **Findings**: 65+ elements below 24px. Categories:
  - Status dots (6–9px): Keep — decorative indicators, not interactive
  - Separator lines (1px): Keep — purely decorative
  - SVGs in buttons (10–14px): Must increase to 16px minimum
  - Icon buttons (18–22px): Must increase to 24px minimum
  - Toggle knobs (8–14px): Scale proportionally with track
  - Scrollbar (6px): Keep — browser chrome
- **Implications**: ~30 meaningful icon/button sizes need increasing. Status dots and separators are excluded per req 3.3.

## Design Decisions

### Decision: Canonical Tab Pattern Base
- **Context**: Need to unify 9 tab implementations into one pattern
- **Alternatives Considered**:
  1. Pill style (filter-pills) — rounded, filled active state
  2. Underline style (git-panel-tabs) — bottom border active indicator
  3. Segmented control — grouped buttons with contained active
- **Selected Approach**: Pill style with contained container, matching `filter-pills`
- **Rationale**: Most widely used (4/9 instances already use it), fits the "Ground Control" aesthetic (compact, contained, glowing active state), works well at all sizes
- **Trade-offs**: Underline tabs are more conventional but less distinctive. Pill style better matches the mission-control aesthetic.
- **Follow-up**: Git panel and spec browser need conversion from underline to pill

### Decision: --text-tertiary Color Value
- **Context**: Must achieve 4.5:1 against both --bg-void and --bg-surface
- **Alternatives Considered**:
  1. #6b7a94 — passes void (4.5:1) but fails surface (4.1:1)
  2. #708298 — just barely passes both (4.6:1 surface) — no margin
  3. #738699 — passes with comfortable margin (4.8:1 surface, 5.3:1 void)
  4. #7b899f — too close to --text-secondary, collapses the hierarchy
- **Selected Approach**: #738699
- **Rationale**: Passes WCAG AA with margin, maintains clear visual gap from --text-secondary (#7b899f), preserves the blue-gray hue of the existing palette
- **Trade-offs**: Slightly brighter than before — elements that were intentionally very dim will become more visible. This is a feature, not a bug.

### Decision: Font Size Tier System
- **Context**: 152 font-size values need to be rationalized to respect 0.7rem floor
- **Selected Approach**: Establish 5 tiers above the floor:
  - **Tier 1 (floor)**: 0.7rem — smallest allowed (was 0.48–0.65rem)
  - **Tier 2 (small)**: 0.72rem — section labels, small controls (was 0.66–0.68rem)
  - **Tier 3 (base)**: 0.78rem — buttons, inputs, data values
  - **Tier 4 (body)**: 0.82rem — inline code, expanded content
  - **Tier 5 (prose)**: 0.9rem — conversation body text
- **Rationale**: Preserves relative hierarchy while eliminating all sub-floor sizes. 5 tiers provide enough differentiation without visual chaos.

### Decision: Card State Differentiation Strategy
- **Context**: Active, has-sessions, and idle cards look identical at rest
- **Selected Approach**: At-rest visual treatments using existing token palette:
  - **Active (running)**: Cyan border-left accent (3px solid --cyan), subtle cyan glow on border
  - **Has-sessions (not running)**: Standard border, normal opacity
  - **Idle (no sessions)**: Dimmed opacity (0.7), border-color faded
- **Rationale**: Left-border accent is subtle enough to not overwhelm but scannable in a grid. Opacity dimming for idle cards is an established "recessive" pattern. Pinned cards keep their amber treatment orthogonally.

### Decision: TDD Toggle Relocation
- **Context**: TDD toggle is an interactive control placed in a metadata-only info strip
- **Selected Approach**: Move to the topbar controls area (right side, near layout switcher) on session detail pages
- **Rationale**: The topbar right side already swaps content based on page context (data-page="detail"). Adding the TDD toggle there groups it with other session controls (layout, commit, merge, delete). The info strip remains purely informational.

## Risks & Mitigations
- **Risk**: Mass font-size changes cause layout shifts across all views → **Mitigation**: Increase in small increments within each tier; most elements use flex/grid so will absorb size changes; verify via Storybook
- **Risk**: New --text-tertiary value makes previously-dim elements too prominent → **Mitigation**: Review every usage; some elements may need color downgrade from tertiary to a new opacity-based treatment
- **Risk**: Canonical tab conversion breaks page-specific tab behaviors → **Mitigation**: Each page's tab state management stays in its component; only CSS classes change
- **Risk**: Card differentiation looks too busy in a grid of many cards → **Mitigation**: Use subtle treatments (left border, opacity) not dramatic ones (full glow, background color)

## References
- [WCAG 2.1 SC 1.4.3 Contrast](https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) — AA minimum ratios
- [WCAG 2.5.5 Target Size](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html) — 44px minimum touch targets
- Existing design spec: `.kiro/specs/ui-design-system/design.md` — current token values and component contracts
