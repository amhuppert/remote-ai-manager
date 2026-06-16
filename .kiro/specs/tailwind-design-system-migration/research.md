# Gap Analysis — tailwind-design-system-migration

_Generated 2026-06-15. Brownfield migration; informs design phase. Information over decisions._

## 1. Current State (verified)

**Build / tooling**
- Next.js 16 (App Router), React 19, bun. Next 16 dev defaults to **Turbopack**.
- `next.config.ts` is minimal: `experimental.optimizePackageImports` (incl. `@xyflow/react`, `@tiptap/*`) + `serverExternalPackages`. **No PostCSS config, no `postcss.config.*`, no Tailwind/autoprefixer/stylelint.** Clean slate.
- **No class helper exists** (`clsx`/`classnames`/`tailwind-merge`/`cn`/CVA all absent) — `cn()` is net-new.
- Scripts present and usable as gates: `lint` (eslint flat config), `typecheck` (`tsc --noEmit`), `test`/`test:ai` (vitest, **multi-project** — note `--project unit`), `build` (`next build`), **`build-storybook` (`storybook build`)**, `format` (prettier). Pre-commit hook was removed (recent commit), so the full suite does not run per-commit.

**Styling system**
- Design tokens are CSS custom properties in `src/features/_root/styles/tokens.css`; consumed via `globals.css → _root/styles/index.css → 16 partials`. State via `[data-*]`, appearance via kebab-case BEM + canonical `.cc-*`.
- **CSS ownership map (the wave plan, verified):**
  - `src/app/globals.css` (entry; large appended utility/component block)
  - `src/features/_root/styles/` — **16 files** (tokens, reset, typography, shell, topbar, sidebar-nav, keyboard-shortcuts-modal, session, conversation, conversation-tabs, conversation-panes, prompt, sidebar, dialogs, approval-gate, index)
  - `src/components/workflow-graph/` — 1 (large; React Flow)
  - Feature-local single files: `config`, `projects-index`, `project-detail`, `project-detail/composer`, `project-detail/cockpit`, `workflows-catalog`, `workflows-builder`, `session/sidebar`, `session-workflow`, `session-diff`, `_root/spawn-card`

**Storybook (the verification harness)**
- `@storybook/nextjs-vite` (Vite). `.storybook/preview.tsx` imports `../src/app/globals.css` (single CSS entry point).
- Addons: `@chromatic-com/storybook` (installed, **deferred per decision 3**), **`@storybook/addon-vitest`** (stories execute as Vitest tests — this is what "affected Storybook tests" means in gates), **`@storybook/addon-a11y`** (`test: "todo"`).
- `.storybook/main.ts` exposes a `viteFinal(config)` hook — the clean injection point if `@tailwindcss/vite` proves necessary.

**Generated/vendor DOM (must stay scoped CSS — decision 4):** `@xyflow/react@12` (React Flow; `ContextEdge.tsx`, stories import `@xyflow/react/dist/base.css`), `@tiptap/*@3` (`.ProseMirror` styling in `conversation.css` **and** `sidebar/styles/PeekPopover.css`), react-markdown/syntax-highlighter + `mermaid@11` output, body atmospherics.

**CSS-asserting tests (R5 surface — ~7 files):** `src/lib/shared/design-system-compliance.test.ts` (mixed: WCAG-contrast + 0.7rem font-floor + `.cc-*` class-existence regex), `McpConfigPopover.styles.test.ts` (background-token-defined guard), `cockpit-design-system.test.ts`, `spawn-card-design-system.test.ts`, `ModelSelector.test.tsx` + workflows-builder `InspectorConfigBlock.test.tsx` / `WorkflowDefinitionsSidebar.test.tsx` (className assertions). (The broader `readFileSync` grep hits are non-CSS — logging/fixtures.)

## 2. Requirement → Asset Map (gaps tagged)

| Req | Existing assets to leverage | Gap |
|---|---|---|
| R1 Toolchain coexistence | `next.config.ts`, `.storybook/main.ts` `viteFinal`, `preview.tsx` globals import | **Missing**: `tailwindcss@4` + `@tailwindcss/postcss` (+ maybe `@tailwindcss/vite`), `postcss.config.mjs`. **Unknown**: Tailwind v4 ↔ Next 16 **Turbopack** PostCSS wiring; PostCSS-vs-Vite for Storybook. **Constraint**: Preflight must start disabled (existing `reset.css`). |
| R2 Token bridge | `tokens.css` `:root` vars; `design-system-compliance.test.ts` patterns | **Missing**: `@theme` block + aliases; theme-surface namespace test. **Constraint**: `--text-*` are colors → must map to `--color-text-*`. **Unknown**: `@theme inline` behavior aliasing to legacy `var(--…)`. |
| R3 Visual parity | 107 stories + `addon-vitest` browser project; Playwright/Next-Chrome MCP | **Constraint**: Chromatic deferred → parity verified manually/Playwright, higher per-slice burden. |
| R4 Shippability & discipline | BEM/`.cc-*` + `[data-*]` already map to v4 `data-*` variants; `src/components/` primitives | **Missing**: `cn()` (clsx), React primitives (`<Button>`, `<Badge>`, …). **Constraint**: full-component migration, no mixed ownership. |
| R5 Test strategy | the ~7 CSS-asserting tests; `addon-vitest` + `addon-a11y` | **Missing**: re-homed contrast/font-floor assertions on the `@theme` surface / computed styles. **Decision**: delete class/structure assertions, don't re-add. |
| R6 Preserve generated/vendor CSS | React Flow base.css, Tiptap `.ProseMirror`, markdown/mermaid CSS | **Constraint**: not convertible to call-site utilities (DOM not authored in JSX). |
| R7 Sequencing | CSS ownership map above | **Constraint**: spike+tokens→primitives→pilot→waves; graph/builder last; lint/sort tooling only after pilot. |
| R8 Progress + guardrails | eslint flat config (`eslint.config.mjs`); knip present | **Missing**: owner-level ratcheting CSS report; `eslint-plugin-tailwindcss`(/better) + prettier-plugin (post-pilot); no-hardcoded-color / no-dynamic-class / no-new-global-CSS rules. |
| R9 Cleanup & finalize | `cc-design-system` SKILL.md + references; `reset.css` | **Constraint**: remove alias bridge (time-bounded); adopt Preflight (reconcile vs `reset.css` — risky); update docs. |

## 3. Implementation Approach Options

**Option A — Coexist & convert in place (token-alias bridge, no new component abstraction).**
Layer `@theme` over the existing vars, convert surfaces to raw utilities in place, keep canonical patterns as bare utility strings.
- ✅ Smallest conceptual surface; closest to "just utilities."
- ❌ Scatters canonical recipes (button/badge) as duplicated utility soup at call sites; weakens the design system as a *system*. Conflicts with decision 5.

**Option B — New parallel Tailwind system + swap.**
Author a fresh token config + component library and migrate wholesale.
- ❌ Big-bang; violates "no rewrite" + "shippable per PR"; breaks all CSS-reading tests at once; abandons token continuity. **Rejected.**

**Option C — Hybrid (recommended; matches locked decisions).**
Token-alias bridge (A's coexistence) **+** a thin React-primitive layer (`cn` + static class maps + `data-*`) for canonical patterns **+** permanent scoped CSS for generated/vendor DOM **+** end-state cleanup to a single source of truth.
- ✅ Preserves the design system as a system; incremental + shippable; honors every locked decision.
- ✅ Maps cleanly onto existing assets (`viteFinal`, globals entry, `[data-*]`, addon-vitest).
- ❌ Most planning/coordination; transitional dual CSS bundle until cleanup.

## 4. Effort & Risk (per area)

| Area | Effort | Risk | Justification |
|---|---|---|---|
| Phase 0 toolchain spike | M | **Medium** | Tailwind v4 ↔ Next 16 Turbopack + Storybook wiring is the key unknown; resolved on a throwaway branch. |
| Phase 1 token bridge | M | Medium | ~200 vars; `--text-*` collision; `@theme inline` semantics. |
| Phase 2 primitives | M | Low–Med | Net-new `cn()` + primitives, but well-bounded, story-covered. |
| Phase 3 pilot | S | Low | Single well-covered surface (ProjectCard + leaf). |
| Phase 4 feature waves | L | Medium | The bulk; many small PRs; parity burden without Chromatic. |
| Complex surfaces (conversation/session/sidebar; graph last) | L–XL | **High** | Dense behavior + React Flow/Tiptap vendor DOM; highest drift risk. |
| R5 test re-homing | S–M | Medium | Re-home contrast/font-floor onto theme surface / computed styles. |
| R9 cleanup + Preflight | M | Med–High | Preflight reconciliation vs bespoke reset can cause broad drift. |
| **Overall** | **XL** | **Medium–High** | Multi-week, ~28k lines, many PRs; de-risked by spike + ratchet + per-slice parity. |

## 5. Recommendations for Design Phase

- **Adopt Option C (hybrid).** It is the only option consistent with the six locked decisions.
- **Front-load the Phase 0 spike's two unknowns** (below) before committing the toolchain shape — they're the highest-leverage risks.
- **Design the `cn()` + primitive seam** (Button/Badge/StatusDot/Tabs/SectionHeader/ModalShell) so call sites stop owning canonical recipes; specify the static-class-map + `data-*` convention concretely.
- **Specify the R5 re-homing mechanism**: where do WCAG-contrast + 0.7rem-floor assertions live post-migration — a Vitest test reading generated `:root`/`@theme` tokens, or a computed-style check in the `addon-vitest` browser project (possibly alongside `addon-a11y`)? Pick one in design.
- **Define the owner-level ratchet** (R8): data source (the CSS ownership map above), where counts are stored, how CI enforces monotonic decrease.
- **Treat graph/builder + Tiptap surfaces as a distinct late workstream** with explicit keep-bespoke criteria.

### Research Needed (carry into design)
1. **Tailwind v4 + Next 16 Turbopack**: does `@tailwindcss/postcss` via `postcss.config.mjs` work under Turbopack dev *and* `next build`, or is different wiring required?
2. **Storybook wiring**: does the existing `preview.tsx` globals import get PostCSS-processed (Tailwind "just works"), or is `@tailwindcss/vite` needed in `viteFinal`?
3. **`@theme inline` semantics** when aliasing theme tokens to legacy `var(--…)` — which utilities require `inline`.
4. **Cascade layers**: confirm legacy unlayered CSS vs Tailwind `@layer` ordering on a shared-element fixture (the "no mixed ownership" backstop).
5. **R5 re-homing home**: generated-token assertion vs computed-style (browser) assertion; feasibility within the multi-project Vitest setup.
6. Minor: interaction of CSS pipeline with `optimizePackageImports`/`serverExternalPackages` (expected none; confirm).

---

# Design Discovery & Synthesis (2026-06-15)

## Technology alignment (light discovery + targeted web verification)

- **Next 16 + Tailwind v4**: official path is `tailwindcss@4` + `@tailwindcss/postcss` + `postcss`, a `postcss.config.mjs` (`{ plugins: { "@tailwindcss/postcss": {} } }`), and a single `@import "tailwindcss"` in CSS (theme + preflight + utilities). Turbopack-compatible. _Sources: tailwindcss.com/docs/guides/nextjs, tailwindcss.com/docs/installation/using-postcss._
- **Disabling Preflight in v4**: import layers individually and omit preflight, e.g. `@layer theme, base, components, utilities; @import "tailwindcss/theme.css" layer(theme); @import "tailwindcss/utilities.css" layer(utilities);`. This is how decision 6 ("Preflight off initially") is realized without forking the framework.
- **Storybook `@storybook/nextjs-vite` + Tailwind v4**: add `@tailwindcss/vite` to `.storybook/main.ts` `viteFinal` (dynamic import to avoid startup issues); PostCSS-processing of the already-imported `globals.css` is a fallback. A known Vite+Storybook+Nx edge case exists, so this stays a Phase 0 spike confirmation. _Sources: storybook.js.org/recipes/tailwindcss, tailwindlabs/tailwindcss discussion #16451._
- **`@theme`**: defining `--color-brand` generates `bg/text/border/ring-brand`; CSS-first config replaces `tailwind.config.js`. `@theme inline` is used where alias indirection (`--color-x: var(--legacy)`) would otherwise block utility generation — exact cases confirmed in Phase 0.

## Synthesis outcomes

- **Generalization**: the 9 requirements reduce to four general capabilities — a token bridge, a thin primitive layer, a per-slice migration protocol, and a verification/guardrail surface. The reusable interface is `cn()` + static class maps + `data-*` variants (generalize the interface, not the implementation).
- **Build vs adopt**: ADOPT Tailwind v4 (`@tailwindcss/postcss`, `@tailwindcss/vite`), `clsx`, and (post-pilot) the Tailwind ESLint/Prettier plugins. BUILD only the owner-level progress ratchet (`scripts/css-migration-progress.ts`) — no off-the-shelf tool reports remaining CSS by CC's ownership taxonomy, and it is a small script. REJECT `class-variance-authority` (decision 5) and `tailwind-merge` (defer until conflicting overrides appear).
- **Simplification**: no migration framework, no feature flags (coexistence is inherent), no layout-primitive system (utilities cover layout), no barrel exports (structure.md). Primitives are built as the core set in Phase 2 and extended only as waves require.

## Boundary decisions
- Spec owns toolchain wiring, the `@theme` bridge, the primitive layer, the migration protocol, the re-homed guarantee tests, guardrails/ratchet, and cleanup. It does NOT own visual/UX changes, generated/vendor DOM styling, or Chromatic adoption. Alias bridge is explicitly time-bounded (removed in cleanup). Enabling Preflight is a revalidation trigger (full visual re-check).
