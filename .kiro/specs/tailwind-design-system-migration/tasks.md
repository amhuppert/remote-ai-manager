# Implementation Plan

> **Per-slice protocol (applies to every feature-wave sub-task in groups 7–9).** Each wave follows the design's per-slice migration protocol: capture the baseline → convert the full component to primitives/utilities → map state to `data-*` + static class maps → pull in and reattach parent-context layout (same-slice parent rule, via `layoutClassName` or parent flex/grid) → delete obsolete selectors, imports, and brittle CSS/`className` assertions for that surface → pass per-PR gates (lint, typecheck, targeted unit + affected stories) → verify desktop + mobile parity. No element ships with mixed style ownership; larger waves also run the production and Storybook builds.

- [ ] 1. Foundation: inventory, toolchain spike, and Tailwind integration
- [ ] 1.1 Inventory CSS by owner and taxonomy, and seed the preserved-CSS catalog
  - Produce a repeatable, command-driven report of every CSS owner mapped to its taxonomy (foundation / canonical primitive / feature layout / generated-content / vendor / animation / one-off)
  - Classify and catalog the "DOM we do not author" surfaces (React Flow vendor DOM, the Tiptap editor DOM, rendered markdown / syntax-highlighter / Mermaid output) plus body atmospherics, scrollbars, keyframes, and portal effects that remain scoped CSS
  - Observable: a checked-in inventory + preserved-CSS catalog listing each owner, its taxonomy, and its expected preserved residual, regenerable by a documented command
  - _Requirements: 6.1, 6.2, 7.1, 8.1_

- [ ] 1.2 Prove the Tailwind v4 toolchain on a throwaway spike
  - On a throwaway branch, confirm Tailwind v4 generates utilities under Next 16 Turbopack (dev + build) via the PostCSS plugin and in Storybook via the Vite plugin, with Preflight disabled
  - Resolve the open research items: Turbopack PostCSS wiring, Storybook PostCSS-vs-Vite-plugin, inline-alias `@theme` semantics, and cascade-layer ordering
  - Observable: a recorded spike result showing utilities rendering in both hosts with no visual drift and Preflight off, naming the exact wiring choices to commit in 1.3
  - _Requirements: 1.1, 1.2, 1.4, 1.5, 7.1_

- [ ] 1.3 Commit the proven Tailwind integration to Next and Storybook
  - Install the toolchain dependencies and add the PostCSS config, the layered theme + utilities imports (Preflight omitted), the theme-file import, and the Storybook Vite-plugin wiring proven in 1.2
  - Observable: the production build and the Storybook build both succeed with Tailwind integrated, a sample utility resolves identically in app and Storybook, and the existing UI renders with no visual difference from the pre-integration baseline
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_
  - _Depends: 1.2_

- [ ] 1.4 Establish the cascade-order no-mixed-ownership backstop fixture
  - Add a fixture/test proving a legacy unlayered rule and a Tailwind utility on the same element resolve in the specified order (legacy wins where both touch an element)
  - Observable: a passing fixture that fails if the cascade order regresses, documented as the backstop for the no-mixed-ownership rule
  - _Requirements: 4.3_
  - _Depends: 1.3_

- [ ] 1.5 Author the Tailwind conventions and per-slice protocol document
  - Capture the spike-proven class rules (no dynamically-constructed classes, explicit static variant maps, no mixed ownership on one element), the `layoutClassName` layout-only allowlist, the desktop-first `max-*` breakpoint convention, the per-slice migration protocol/checklist with fixed desktop/mobile viewport dimensions and visual-evidence location, and the preserved-CSS do-not-convert catalog
  - Observable: a checked-in conventions doc an implementer can follow to migrate a slice without further design input
  - _Requirements: 3.4, 4.3_
  - _Depends: 1.1, 1.2_

- [ ] 2. Token bridge and theme surface
- [ ] 2.1 Alias existing token categories into the `@theme` surface
  - Define utility-generating `@theme` tokens that alias the existing color, background, border, accent, spacing, radius, and font-family variables 1:1, mapping text colors under the color namespace (not the font-size namespace), using inline aliasing where indirection would otherwise block utility generation
  - Give the sizing floors (font-size floor, icon/touch minimums) a deliberate namespace separate from the font-size scale, and keep every existing `var(--…)` reference resolving unchanged
  - Observable: color / spacing / radius / font utilities generate from the aliased tokens while legacy CSS renders identically (no visual diff on a sample route)
  - _Requirements: 2.1, 2.2, 2.3_
  - _Depends: 1.3_

- [ ] 2.2 Extract and centralize the z-index tier scale
  - Collapse the scattered ad-hoc z-index literals into a small ordered named tier scale exposed as `@theme` tokens, preserving relative stacking order, and re-home the dropdown/panel/tooltip ordering guarantee onto the tier tokens
  - Remove only the brittle regex-based z-index ordering assertion that reads the global stylesheet; leave the host component's behavioral tests intact (its remaining className/structure assertions are deleted when that component migrates in 7.8)
  - Observable: a `z-*` utility family generates from ordered tier tokens, the ordering guarantee passes against the tokens (not raw CSS), and the regex z-index assertion is gone while the host component's behavioral tests still pass
  - _Requirements: 2.1, 5.1_
  - _Depends: 2.1_

- [ ] 2.3 Extract breakpoints as frozen desktop-first `max-*` variants
  - Define the canonical breakpoint tokens and register desktop-first `max-*` custom variants (no inversion to mobile-first), tokenizing recurring one-offs and keeping genuinely single-use thresholds component-local
  - Observable: a frozen, enumerated breakpoint token + `max-*` variant set the theme-surface test asserts, with responsive rules transcribing 1:1 and no responsive rendering change
  - _Requirements: 2.1_
  - _Depends: 2.1_

- [ ] 2.4 Extract and dedupe the JSX-authored animations
  - Deduplicate the duplicate keyframes, pick canonical durations where one keyframe is invoked at many, and expose the shared JSX-authored animations as `@theme` animation tokens; mark graph/atmospheric/vendor keyframes as staying bespoke
  - Observable: an `animate-*` utility family generates for the tokenized animations, the matrix records which keyframes stay scoped, and no animation renders differently
  - _Requirements: 2.1, 6.2_
  - _Depends: 2.1_

- [ ] 2.5 Assert the theme-surface namespace contract
  - Add a test asserting every token across all ten families (alias and extract lanes) is registered under its correct Tailwind namespace, failing on any missing or mis-namespaced token
  - Observable: the test passes for the full token matrix and fails if a token is dropped or registered under the wrong namespace
  - _Requirements: 2.4, 2.5_
  - _Depends: 2.1, 2.2, 2.3, 2.4_

- [ ] 3. Re-home accessibility and legibility guarantees
- [ ] 3.1 Re-home WCAG contrast and font-floor guarantees onto the theme surface
  - Create the guarantee test asserting WCAG text-contrast thresholds and the minimum font-size floor against the `@theme` token surface and/or computed styles, and remove the brittle CSS class-existence/structure assertions from the existing compliance test without re-adding any CSS-structure assertion
  - Observable: the re-homed contrast + font-floor guarantees pass against the token surface, the old class-existence assertions are gone, and weakening a token below threshold fails the guarantee
  - _Requirements: 2.4, 5.1, 5.2, 5.3_
  - _Depends: 2.1, 2.5_

- [ ] 4. Shared UI primitive layer
- [ ] 4.1 Implement the `cn()` class-composition helper
  - Add the clsx-based `cn()` helper and unit-test conditional, array, and falsey composition
  - Observable: `cn()` unit tests pass covering conditional / array / falsey inputs
  - _Requirements: 4.4_
  - _Depends: 1.3_

- [ ] 4.2 Build the canonical primitives with static class maps and `data-*` state
  - Implement the full primitive set (button, badge, status dot, tabs, section header, modal/dialog shell) as React primitives with static (analyzable) variant/size class maps and `data-*` state variants, parity-equivalent to the legacy classes they replace
  - Omit `className`/`style`, expose the layout-only `layoutClassName` slot (appended after appearance, never overriding it), and permit a component-layer class only for generated/vendor DOM that cannot receive props
  - Observable: each primitive renders the parity-equivalent class set for every variant × `data-*` state and accepts layout-only `layoutClassName` without carrying any appearance override
  - _Requirements: 4.2, 4.4, 4.5, 7.2_
  - _Depends: 2.1, 4.1_

- [ ] 4.3 Cover every primitive with parity stories
  - Add a story per primitive exercising each variant × `data-*` state plus a `layoutClassName` placement case, and run the a11y addon clean
  - Observable: stories render every variant/state with the a11y addon reporting no violations, serving as the parity baseline harness for later waves
  - _Requirements: 3.1, 3.2, 4.4_
  - _Depends: 4.2_

- [ ] 5. Pilot slice and post-pilot tooling
- [ ] 5.1 Migrate the pilot slice (project card + a leaf control)
  - Capture the baseline, convert the pilot card and one leaf control fully to primitives/utilities, reattach any parent-context layout, delete their legacy CSS and brittle CSS/className assertions, and verify desktop + mobile parity
  - Observable: the pilot surface renders identically to baseline at both breakpoints, owns no legacy class on any migrated element, its legacy selectors are deleted, and per-PR gates pass — proving the pattern before broad waves open
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.3, 7.3_
  - _Depends: 4.2, 4.3_

- [ ] 5.2 Add post-pilot lint, class-sort, and guardrail rules
  - After the pilot proves the patterns, add the Tailwind class-sort (Prettier) and lint plugins plus guardrail rules flagging dynamically-constructed classes, hard-coded colors in migrated code, new global CSS outside approved foundation/vendor areas, and appearance utilities passed to `layoutClassName`
  - Observable: lint fails on a dynamic-class / hard-coded-color / disallowed-global-CSS / appearance-in-`layoutClassName` sample and passes on the migrated pilot
  - _Requirements: 7.5, 8.3, 8.4_
  - _Depends: 5.1_

- [ ] 6. Migration progress ratchet
- [ ] 6.1 Build the owner-level CSS progress ratchet
  - Implement the progress script reporting remaining CSS by owner using selector-count-per-owner, with a preserved-owner allowlist and per-owner residual floors derived from the catalog, enforcing monotonic decrease toward each floor; wire it into CI for larger waves and test it on a seeded fixture
  - Observable: the script reports per-owner counts and fails CI when any owner's tracked count increases or drops below its declared floor, verified on a seeded fixture
  - _Requirements: 6.4, 8.1, 8.2_
  - _Depends: 1.1, 5.1_

- [ ] 7. Feature waves — independent route and feature surfaces
- [ ] 7.1 Migrate shared leaves from the global stylesheet to primitives
  - Replace the remaining global leaf call sites (buttons, badges, status dots, tabs, etc.) with the primitives and delete the corresponding legacy leaf rules from the global stylesheet, applying the same-slice parent rule for any container-positioned controls
  - Observable: migrated leaf call sites use primitives, the global stylesheet's leaf rules are removed, parity holds at both breakpoints, and gates pass
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 7.2_
  - _Depends: 4.2, 5.1_
  - _Boundary: globals.css, UI Primitive Layer_

- [ ] 7.2 (P) Migrate the session diff and session workflow route surfaces
  - Convert both route surfaces per the per-slice protocol; delete their feature CSS and any brittle CSS/className assertions
  - Observable: both surfaces match baseline at desktop + mobile, their feature CSS is removed, this owner's ratchet count drops to its floor, and gates pass
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4_
  - _Depends: 7.1_
  - _Boundary: session-diff, session-workflow_

- [ ] 7.3 (P) Migrate the projects index surface
  - Convert the projects index per the per-slice protocol; delete its feature CSS and any brittle assertions
  - Observable: the projects index matches baseline at both breakpoints, its feature CSS is removed, its ratchet count drops to floor, and gates pass
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4_
  - _Depends: 7.1_
  - _Boundary: projects-index_

- [ ] 7.4 (P) Migrate the config editor surface
  - Convert the config editor per the per-slice protocol, including deleting that surface's background-token / className brittle assertions
  - Observable: the config editor matches baseline at both breakpoints, its feature CSS and brittle assertions are removed, its ratchet count drops to floor, and gates pass
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4_
  - _Depends: 7.1_
  - _Boundary: config_

- [ ] 7.5 (P) Migrate the workflows catalog surface
  - Convert the workflows catalog per the per-slice protocol; delete its feature CSS and any brittle assertions
  - Observable: the workflows catalog matches baseline at both breakpoints, its feature CSS is removed, its ratchet count drops to floor, and gates pass
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4_
  - _Depends: 7.1_
  - _Boundary: workflows-catalog_

- [ ] 7.6 (P) Migrate the project detail shell surface
  - Convert the project detail shell per the per-slice protocol; delete its feature CSS and any brittle assertions
  - Observable: the project detail shell matches baseline at both breakpoints, its feature CSS is removed, its ratchet count drops to floor, and gates pass
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4_
  - _Depends: 7.1_
  - _Boundary: project-detail_

- [ ] 7.7 (P) Migrate the cockpit and composer surfaces
  - Convert the cockpit and composer per the per-slice protocol, including deleting the cockpit/spawn-card design-system brittle assertions; run the production + Storybook builds for this larger wave
  - Observable: cockpit and composer match baseline at both breakpoints, their feature CSS and brittle assertions are removed, their ratchet counts drop to floor, and the full gate set (incl. both builds) passes
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4, 5.5_
  - _Depends: 7.1_
  - _Boundary: project-detail/cockpit, project-detail/composer, _root/spawn-card_

- [ ] 7.8 (P) Migrate the shared cross-feature components styled from the global stylesheet
  - Convert the shared components that live in the components directory and are styled by the global stylesheet (the model selector, the MCP config popover, and any peer shared components) to primitives/utilities per the per-slice protocol, applying the same-slice parent rule for their portal/positioning context
  - Delete those components' remaining brittle CSS/className assertions (the z-index ordering assertion is already re-homed in 2.2), and remove their selector regions from the global stylesheet
  - Observable: the shared components match baseline at both breakpoints, own no legacy class, their selector regions and brittle assertions are removed, and gates pass
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4_
  - _Depends: 7.1_
  - _Boundary: src/components (model selector, MCP config popover), globals.css (their selector regions)_

> Waves 7.2–7.8 are parallel-capable: each owns a distinct surface, consumes the primitives read-only, and updates only its own owner's entry in the ratchet. 7.2–7.7 touch only their feature-folder CSS; 7.8 edits its own dedicated regions of the global stylesheet (disjoint from the leaf rules 7.1 removed). All depend on 7.1, which is sequential because it edits the shared global stylesheet they build on.

- [ ] 8. Feature waves — shared root surfaces
- [ ] 8.1 Migrate the session and conversation surfaces
  - Convert the dense session/conversation root surfaces per the per-slice protocol; preserve the Tiptap editor DOM as scoped CSS; run the production + Storybook builds for this larger wave
  - Observable: session and conversation surfaces match baseline at both breakpoints, their authored CSS is removed down to the preserved Tiptap residual, and the full gate set (incl. both builds) passes
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4, 5.5, 6.1_
  - _Depends: 7.1_

- [ ] 8.2 Migrate the prompt, sidebar, dialogs, and shell chrome surfaces
  - Convert the prompt, sidebar, dialogs, topbar/shell, keyboard-shortcuts, and approval-gate root surfaces per the per-slice protocol; preserve any peek-popover editor DOM as scoped CSS
  - Observable: these surfaces match baseline at both breakpoints, their authored CSS is removed down to preserved residuals, and the full gate set (incl. both builds) passes
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 5.4, 5.5, 6.1_
  - _Depends: 8.1_

- [ ] 9. Workflow graph/builder (last) and vendor-DOM preservation
- [ ] 9.1 Migrate the authored workflow builder/execution chrome; keep the graph bespoke
  - Convert the JSX-authored workflow builder/execution chrome to primitives/utilities per the per-slice protocol and delete its className assertions, while leaving the React Flow vendor DOM and the workflow-graph stylesheet bespoke
  - Observable: the authored builder chrome matches baseline and uses no legacy classes, its className assertions are removed, the React Flow vendor DOM and graph stylesheet are untouched, and gates pass
  - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 4.5, 5.1, 6.1, 6.3, 7.4_
  - _Depends: 8.2_

- [ ] 9.2 Confirm and enforce the preserved-CSS boundary
  - Verify the React Flow vendor DOM, Tiptap editor DOM, markdown/syntax-highlighter/Mermaid output, and body atmospherics/scrollbars/keyframes remain scoped CSS, are recognized by the ratchet's preserved floors, and are not required to convert
  - Observable: the ratchet reports each preserved owner sitting at (not below) its declared floor, completion is recorded as "tokens + route/component migration" rather than zero CSS, and no preserved surface was converted
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Depends: 6.1, 9.1_

- [ ] 10. End-state cleanup and finalization
- [ ] 10.1 Remove the legacy token aliases and promote `@theme` to the sole source of truth
  - Remove the legacy token-name aliases, repoint or delete remaining consumers, and update all dependent CSS-reading tests and references in lockstep
  - Observable: the alias bridge is gone, the theme tokens are the only token source, and the full test suite passes against the de-aliased surface
  - _Requirements: 9.1, 9.2, 9.5_
  - _Depends: 9.1_

- [ ] 10.2 Adopt Tailwind Preflight by incremental reset reconciliation
  - Layer Preflight below the existing reset so the reset initially wins, then retire redundant reset rules one revertible slice at a time, each with a visual re-check
  - Observable: Preflight is enabled with the bespoke reset reconciled, and each retired reset rule shipped with a passing visual re-check showing no drift
  - _Requirements: 1.5, 9.3_
  - _Depends: 10.1_

- [ ] 10.3 (P) Update the design-system documentation
  - Update the `cc-design-system` skill and references to describe Tailwind tokens, utilities, component classes, and the remaining scoped-CSS exceptions
  - Observable: the design-system docs describe the Tailwind-backed system and enumerate the preserved CSS exceptions
  - _Requirements: 9.4_
  - _Depends: 10.1_

- [ ] 10.4 Post-migration parity spot-check of high-traffic flows
  - Spot-check the conversation/session high-traffic flow against its pre-migration baseline at desktop + mobile
  - Observable: the high-traffic flow renders with no visual difference from baseline at both breakpoints
  - _Requirements: 3.1, 6.1_
  - _Depends: 10.2_
