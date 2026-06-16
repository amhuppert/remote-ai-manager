# Workflow Charter

## Mission
Make Tailwind CSS v4 the authoring mechanism for Command Center's existing console UI, replacing hand-written CSS incrementally with ZERO visual change. This workflow is Stage A only: the toolchain integration, the @theme token bridge, the re-homed accessibility/legibility guarantees, the shared cn()+primitive layer, the single pilot slice, post-pilot lint/guardrails, and the owner-level progress ratchet — establishing and proving the patterns before any broad feature-wave migration (Stage B, a later workflow). Every context must leave the app shippable (green lint/typecheck/targeted tests); toolchain/integration work must also pass next build and storybook build. Visual parity is human-judged because Chromatic is deferred — agents capture before/after screenshots at fixed desktop+mobile dimensions but must never claim parity they cannot evidence.

## Ownership map
Stage A owns: Tailwind toolchain integration; the @theme token bridge + theme-surface namespace test; the re-homed WCAG/font-floor guarantees and removal of brittle CSS assertions; the cn()+primitive layer and its stories; the single pilot slice; post-pilot lint/sort + guardrail rules; and the owner-level progress ratchet. Stage A does NOT own any feature-surface migration, vendor/generated-DOM styling, legacy-alias removal, or Preflight adoption — all deferred to a later Stage B workflow.

## Conventions
- Never mix legacy class selectors and Tailwind utilities on the same element (full-component migration). This includes the descendant-selector case: a migrated primitive must not remain the target of a surviving .parent .child legacy rule.
- Primitives omit className/style; the only style escape hatch is a layout-only layoutClassName slot (external geometry only: margin, grid/flex placement, order-*, self-*/justify-self-*, width/basis-*), appended AFTER appearance utilities and never overriding them.
- Breakpoints stay desktop-first via max-* custom variants — never invert to mobile-first min-width.
- No dynamically-constructed Tailwind class strings; encode variants as static class maps and state as data-* variants.
- Text-color tokens go under the color namespace (--color-text-*), never --text-* (Tailwind reads --text-* as font-size).
- Keep legacy var(--…) names resolving (alias bridge) — do not remove them in Stage A.
- Preflight stays OFF in Stage A (CC's existing reset governs).

## Non-goals
- No visual redesign, layout change, or component restructuring beyond parity.
- No component library (shadcn), no class-variance-authority, no tailwind-merge (until a real conflicting-override case appears).
- No Chromatic gate.
- Do not convert DOM CC does not author (React Flow vendor DOM, Tiptap .ProseMirror, markdown/syntax-highlighter/Mermaid output) or body atmospherics/scrollbars/keyframes.
- Do NOT migrate any feature surface in Stage A — only the single pilot slice, and only in the pilot context.
- Do NOT remove legacy var(--…) token names or adopt Preflight in Stage A — both are Stage B cleanup.

## Vocabulary
- alias lane / extract lane (token bridge two lanes)
- token bridge (@theme over legacy vars)
- preserved-CSS catalog (DOM we don't author, stays scoped CSS)
- owner-level ratchet / residual floor (selector-count per owner, monotonic decrease toward a floor)
- same-slice parent rule (a container positioning a primitive migrates in the same slice)
- layoutClassName (the layout-only primitive slot)
- no mixed ownership (one element, one styling source)

## Test strategy
Delete brittle CSS-class/structure and className assertions rather than updating them; never re-add CSS-structure assertions. Re-home the genuine WCAG text-contrast and minimum-font-size-floor guarantees onto the @theme token surface and/or computed styles — never delete a guarantee to pass. Assert token namespace correctness with the theme-surface test across all ten families. Unit-test cn() composition and primitive variant×data-* parity. The per-context deterministic gate is the project preMergeCommand (scripts/pre-merge-validate.sh = scoped prettier/eslint/vitest + full tsc); it does NOT run builds, so next build and storybook build verification is an explicit implementer step in the toolchain context.

## Known ambiguities
- Visual parity is human-judged; there is no pixel-threshold gate (Chromatic deferred). The pilot context carries a human-approval gate for this reason.
- Exact @theme inline cases, Storybook PostCSS-vs-@tailwindcss/vite wiring, and Tailwind-v4 ↔ Next-16 Turbopack PostCSS wiring are resolved in the toolchain context's spike (research.md items 1–3); follow what the spike proves.

## Source-of-truth hierarchy (highest authority first)

### 1. Spec requirements (WHAT)
- id: `requirements`
- type: spec
- locator: `.kiro/specs/tailwind-design-system-migration/requirements.md`
- access policy: worktree-relative

The authoritative acceptance outcomes and constraints. When design or tasks conflict with a requirement, the requirement wins.

### 2. Spec design (HOW)
- id: `design`
- type: spec
- locator: `.kiro/specs/tailwind-design-system-migration/design.md`
- access policy: worktree-relative

The architecture: token bridge two-lane model, the UI primitive contract (layoutClassName layout-only slot + same-slice parent rule), desktop-first max-* breakpoints, preserved-CSS boundary, guarantee tests, ratchet. Authoritative for implementation approach.

### 3. Spec tasks (Stage A work breakdown)
- id: `tasks`
- type: spec
- locator: `.kiro/specs/tailwind-design-system-migration/tasks.md`
- access policy: worktree-relative

Task-level breakdown. Stage A covers tasks 1.x–6.x; tasks 7.x–10.x are Stage B and OUT OF SCOPE here.

### 4. CC design-system contract
- id: `design-system-skill`
- type: document
- locator: `.claude/skills/cc-design-system/SKILL.md`
- access policy: worktree-relative

The design-system contract (tokens, component classes, iconography, voice). Source for what parity-equivalent means; updated only in Stage B cleanup.

### 5. Engineering steering
- id: `engineering-principles`
- type: document
- locator: `.kiro/steering/engineering-principles.md`
- access policy: worktree-relative

Project-wide rules: type safety (no any/ts-ignore), Zod-first, dependency injection over vi.mock for internal modules, TDD. Always applies.