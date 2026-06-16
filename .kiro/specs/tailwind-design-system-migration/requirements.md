# Requirements Document

## Project Description (Input)

Incrementally migrate Command Center's hand-written CSS to Tailwind CSS v4 (CSS-first `@theme`), as a **staged design-system migration — not a visual redesign**.

**Who has the problem / current situation.** CC styles itself with a hand-written CSS-variable design system (tokens in `src/features/_root/styles/tokens.css`) — roughly ~28k lines across ~29 files: `globals.css`, the `_root/styles/` modular files, feature-local `styles/` folders, and a large shared `workflow-graph.css`. There is no Tailwind/PostCSS integration today. State is driven by `[data-*]` attributes; appearance by kebab-case BEM and canonical `.cc-*` classes. The design system is documented as a contract in `.claude/skills/cc-design-system/SKILL.md` + references, and several tests parse CSS directly.

**What should change.** Introduce Tailwind v4 as the implementation mechanism for the existing CC console language so new and touched UI is authored with Tailwind utilities / small shared primitives backed by the existing tokens, while the app stays shippable after every PR (no big-bang rewrite). "Tailwind migrated" means Tailwind-backed tokens + route/component migration — **not** "zero CSS files."

### Locked decisions (Alex, 2026-06-15)

1. **Tailwind v4 CSS-first** — its `@theme` model maps onto the existing CSS custom properties, so this is coexistence, not a rewrite.
2. **Temporary token-alias bridge with eventual cleanup** — keep legacy CC variable names authoritative during the transition with `@theme` aliases over them; the final cleanup phase promotes `@theme` to the sole source of truth and removes legacy names. This is a time-bounded, explicitly-approved backward-compat shim — NOT a permanent dual surface.
3. **Chromatic deferred** — visual verification is local Storybook review + Playwright / Next-Chrome MCP screenshots at desktop + mobile. The `@chromatic-com/storybook` dependency stays installed but unused for now; adopting it as a required gate is a later decision.
4. **Pragmatic hybrid end-state** — keep as scoped CSS the body atmospherics, genuinely dynamic inline styles, and "DOM we don't author in JSX": React Flow (`@xyflow/react`) vendor DOM, Tiptap `.ProseMirror`, and react-markdown / syntax-highlighter + Mermaid output. `workflow-graph.css` may stay bespoke.
5. **Component pattern** — React primitives + static class maps as the default; `data-*` variants for state; `@layer components`/`@apply` reserved only for generated/vendor DOM you can't attach classNames to, or canonical recipes reused across unrelated call sites. No `class-variance-authority` until proven needed; `cn()` = clsx only, defer `tailwind-merge` until a component API permits conflicting utility overrides.
6. **Adopt Tailwind Preflight later** — disable Preflight initially (CC's `reset.css` is the single base reset); reconcile toward adopting Preflight in the cleanup phase.

### Phase sequence

- **Phase 0 — Inventory, baseline & integration spike.** Inventory CSS by owner + taxonomy (foundation / canonical primitives / feature layout / generated-content / third-party-vendor / animations / one-off), recorded via repeatable commands. Establish Storybook baselines; screenshots for non-story routes. Throwaway spike proves: Tailwind v4 works in both Next and Storybook (validate PostCSS vs `@tailwindcss/vite`), utilities render, Preflight disabled, cascade order understood, token aliases generate correct utilities (incl. `@theme inline`), no visual drift. Document the class rules (no dynamic class construction; explicit maps for variants; no mixed ownership on one element).
- **Phase 1 — Token bridge.** `@theme` aliases over authoritative CC variables. Text colors under `--color-text-*`, NOT `--text-*` (Tailwind v4 reads `--text-*` as font-size, but CC's `--text-*` are colors). Theme-surface test asserts correct namespaces (`--color-*`, `--spacing-*`, `--radius-*`, `--font-*`, `--animate-*`). Update CSS-reading tests in lockstep.
- **Phase 2 — Shared primitives.** Buttons, icon buttons, badges, tabs, section headers, modal/dialog shell, empty states, spinners, status dots, card menus.
- **Phase 3 — Pilot slice.** `ProjectCard` + a leaf control (e.g. `BackendToggle` / `ContextFillIndicator`) end-to-end. Add lint/sort enforcement (`prettier-plugin-tailwindcss` + `eslint-plugin-tailwindcss`) AFTER the pilot proves the patterns.
- **Phase 4 — Feature waves by ownership.** Shared leaves from `globals.css` → small route CSS (`session-diff`, `session-workflow`) → projects index → config editor → workflows catalog → project-detail shell → cockpit/composer → session/conversation/prompt/sidebar/dialogs. Workflow graph + builder/execution LAST.
- **Phase 5 — Preserve complex/generated/vendor CSS** (per decision 4).
- **Phase 6 — Harden & cleanup.** Owner-level ratcheting CSS progress report; guardrails against dynamic class construction / hard-coded colors / new global CSS outside approved areas; reconcile the reset and adopt Preflight; resolve the token end-state by removing legacy names; update `.claude/skills/cc-design-system/SKILL.md` + references to document Tailwind usage.

### Hard constraints

- Several tests parse CSS directly (`design-system-compliance.test.ts`, the `*-design-system.test.ts` files, `McpConfigPopover.styles.test.ts`, plus class assertions in `ModelSelector` and workflows-builder). Decision (Alex, 2026-06-15): **delete** the brittle CSS-class/structure assertions rather than maintaining them — tests should not assert about CSS. **Re-home, do not drop**, the genuine accessibility/legibility guarantees those files also contain (WCAG text-contrast thresholds; 0.7rem font-size floor) onto the Tailwind `@theme` token surface and/or computed styles. See Requirement 5.
- Per-PR verification: `bun run lint` + `bun run typecheck` + targeted Vitest + affected Storybook tests; larger waves also `bun run build` + `bun run build-storybook`.
- Never mix legacy class selectors and Tailwind utilities on the same element (full-component migration).
- Stack: Next.js 16, React 19, bun, Storybook `@storybook/nextjs-vite`.

## Introduction

This feature incrementally migrates Command Center's hand-written CSS-variable design system to Tailwind CSS v4 (CSS-first `@theme`). It is a **staged design-system migration, not a visual redesign**: Tailwind becomes the implementation mechanism for the existing CC console language while the rendered UI stays visually unchanged and the app remains shippable after every PR. The requirements below describe the observable outcomes and constraints of that migration; the per-phase architecture and task breakdown are deferred to the design and tasks phases.

## Boundary Context

- **In scope**: introducing the Tailwind v4 toolchain in coexistence with existing CSS; exposing every CC design token through the Tailwind theme; migrating shared primitives and feature surfaces to Tailwind utilities / React primitives; deleting brittle CSS-class/structure test assertions while re-homing the genuine accessibility/legibility guarantees onto the theme surface; keeping per-PR verification gates green; an end-state cleanup that finalizes the token system, adopts Preflight, and updates design-system documentation.
- **Out of scope**: any visual redesign or layout change; adopting a third-party component library (e.g. shadcn); a big-bang rewrite; adopting Chromatic as a required visual-regression gate during this effort (the dependency remains installed but unused); converting "DOM we do not author in JSX" (React Flow vendor DOM, Tiptap editor DOM, rendered markdown/Mermaid output) to utilities; maintaining or re-adding tests that assert specific CSS class names or CSS-rule structure.
- **Adjacent expectations**: the existing Storybook suite and stories are relied on as the visual-verification harness; the `cc-design-system` skill + references are the design-system contract and are expected to be updated at completion; the existing `[data-*]` state convention is preserved and mapped onto Tailwind data variants.

## Requirements

### Requirement 1: Tailwind toolchain coexistence
**Objective:** As a CC maintainer, I want Tailwind v4 to build and serve utilities in both the Next app and Storybook without altering the current UI, so that the migration can begin on a proven, low-risk foundation.

#### Acceptance Criteria
1. When the production build runs, the Command Center build shall compile successfully with Tailwind v4 integrated.
2. When Storybook builds or serves, the Storybook build shall apply the same Tailwind theme and utilities as the Next app.
3. While Tailwind is integrated and Preflight is disabled, the Command Center UI shall render with no visual difference from the pre-integration baseline.
4. Where a Tailwind utility class is applied to an element, the system shall produce the corresponding styling in both the Next app and Storybook.
5. If Tailwind's base reset (Preflight) would override the existing reset, the toolchain shall keep Preflight disabled until the reset is explicitly reconciled in the cleanup phase.

### Requirement 2: Token bridge and single source of truth
**Objective:** As a CC maintainer, I want every design token exposed through the Tailwind theme while existing CSS keeps working, so that legacy CSS and Tailwind utilities share one source of truth during the transition.

#### Acceptance Criteria
1. The Tailwind theme layer shall expose a utility-generating token for every CC design token, covering colors, backgrounds, borders, spacing, radii, font families, sizing floors, z-index tiers, breakpoints, and animations.
2. While the alias bridge is in place, the system shall continue to resolve all existing `var(--…)` references so that legacy CSS renders identically.
3. The Tailwind theme layer shall register text-color tokens under the color namespace rather than the font-size namespace, so that color utilities (not font-size utilities) are generated for them.
4. When the theme-surface test runs, the design-system test suite shall assert that each token is registered under its correct Tailwind namespace.
5. If a token is absent from the theme layer or registered under the wrong namespace, the design-system test suite shall fail.

### Requirement 3: Visual parity preservation
**Objective:** As a CC maintainer, I want the migration to preserve the existing CC visual language exactly, so that users see no change while the implementation moves to Tailwind.

#### Acceptance Criteria
1. When a surface is migrated to Tailwind, the migrated surface shall be visually equivalent to its pre-migration baseline at desktop and mobile breakpoints.
2. Before a UI-bearing slice is migrated, the migration process shall capture a visual baseline via Storybook review and/or route screenshots for later comparison.
3. If a migrated surface shows an unintended visual difference from its baseline, the migration process shall treat the slice as incomplete until the difference is resolved or explicitly accepted.
4. The migration shall not introduce new visual design, layout changes, or component restructuring beyond what is required to preserve parity.

### Requirement 4: Incremental shippability and migration discipline
**Objective:** As a CC maintainer, I want every change to be small, shippable, and to fully own each element it touches, so that the app stays releasable throughout and cascade conflicts are avoided.

#### Acceptance Criteria
1. The migration shall be delivered as a series of independently shippable changes, each leaving the application fully functional.
2. When a component is migrated, the migration process shall convert that component fully to Tailwind utilities or primitives and remove its obsolete legacy selectors in the same change.
3. If both legacy class selectors and Tailwind utilities would style the same element, the migration process shall not ship that element with mixed style ownership.
4. Where a reusable UI pattern is migrated, the system shall implement it as a React primitive with static class maps and `data-*` state variants by default.
5. Where generated or vendor DOM cannot receive className props, the system shall be permitted to use a component-layer class (`@layer components` / `@apply`) instead of inline utilities.

### Requirement 5: Test strategy — remove brittle CSS assertions, re-home guarantees
**Objective:** As a CC maintainer, I want brittle CSS-structure assertions deleted and genuine design-system guarantees re-homed onto the token/theme surface, so that the suite verifies behavior and guarantees rather than CSS implementation detail.

#### Acceptance Criteria
1. When a surface is migrated, the migration process shall delete tests that assert specific CSS class names or CSS-rule structure (for example "class X is defined" or component `className` string assertions) rather than updating them, and shall not introduce new CSS-structure assertions.
2. The migration process shall preserve the design system's accessibility and legibility guarantees that are currently checked by reading CSS — specifically the WCAG text-contrast thresholds for text tokens and the minimum font-size floor — by asserting them against the Tailwind `@theme` token surface and/or computed styles rather than against raw CSS text.
3. If a deleted structural test was the only coverage for a migrated surface, the migration process shall rely on Storybook and visual verification for that surface rather than re-adding a CSS-structure assertion.
4. Before a migration PR is merged, the PR shall pass lint, typecheck, targeted unit tests, and affected Storybook tests.
5. While a larger migration wave is in progress, the PR shall also pass the production build and the Storybook build.

### Requirement 6: Preservation of generated and vendor DOM
**Objective:** As a CC maintainer, I want DOM we do not author and atmospheric effects to remain scoped CSS, so that the migration improves locality without degrading surfaces that cannot be cleanly expressed as utilities.

#### Acceptance Criteria
1. The migration shall retain scoped CSS for DOM not authored in CC's JSX, including React Flow vendor DOM, the Tiptap editor DOM, and rendered markdown, syntax-highlighter, and Mermaid output.
2. The migration shall retain scoped CSS for body atmospherics, scrollbars, keyframes, reduced-motion behavior, portal positioning, and dense pseudo-element effects.
3. Where styling targets DOM that CC does not author, the system shall not require conversion of that styling to Tailwind utilities.
4. The migration shall treat completion as "Tailwind-backed tokens plus route and component migration", not as the elimination of all CSS files.

### Requirement 7: Migration sequencing
**Objective:** As a CC maintainer, I want the migration ordered from foundation to highest-risk, so that patterns are proven on safe surfaces before complex ones.

#### Acceptance Criteria
1. The migration process shall complete the toolchain spike and the token bridge before migrating any feature surface.
2. The migration process shall migrate shared design-system primitives before feature call sites.
3. When primitives are in place, the migration process shall complete a single pilot slice before opening broad feature waves.
4. The migration process shall migrate the workflow graph and the workflow builder/execution surfaces last.
5. While the first pilot slice has not yet proven the patterns, the migration process shall not add Tailwind lint or class-sort enforcement tooling.

### Requirement 8: Progress visibility and anti-stall guardrails
**Objective:** As a CC maintainer, I want migration progress to be measurable and protected against regressions, so that the effort cannot silently stall or accrue new styling debt.

#### Acceptance Criteria
1. The migration progress check shall report remaining un-migrated CSS by owner.
2. While the migration is in progress, the migration progress check shall enforce that remaining-CSS counts may only decrease.
3. If a change introduces dynamically-constructed Tailwind class strings, hard-coded color values in migrated code, or new global CSS outside approved foundation or vendor areas, the guardrails shall flag the change.
4. When the pilot slice has proven the patterns, the migration process shall add class-sorting and Tailwind lint enforcement.

### Requirement 9: End-state cleanup and token finalization
**Objective:** As a CC maintainer, I want the temporary alias bridge and bespoke reset reconciled at the end, so that the codebase converges on a single, documented Tailwind-backed system.

#### Acceptance Criteria
1. When the cleanup phase runs, the system shall promote the Tailwind theme tokens to the single source of truth and remove the legacy token-name aliases.
2. When legacy token names are removed, the migration process shall update all dependent CSS-reading tests and references accordingly.
3. During the cleanup phase, the migration process shall reconcile the base reset and adopt Tailwind Preflight.
4. When the migration completes, the design-system documentation (the `cc-design-system` skill and references) shall describe Tailwind tokens, utilities, component classes, and the remaining CSS exceptions.
5. The alias bridge shall be treated as temporary and shall be removed by the cleanup phase rather than retained as a permanent compatibility layer.
