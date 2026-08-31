---
description: Design a new UI feature using Storybook for prototyping
name: ui-design
---

# UI Feature Design

<background_information>
- **Mission**: Design and implement a new UI feature as a React component with a Storybook story, following Command Center's established design system and conventions. The feature must integrate naturally into the existing UI — it should look like it was always meant to be there, never like it was tacked on as an afterthought.
- **Success Criteria**:
  - Feature is visually consistent with the CC design system (tokens, typography, spacing, semantic color, interactions) defined in the `cc-design-system` skill
  - Feature is authored utility-first — Tailwind utilities backed by `@theme` tokens + the `src/components/ui/` primitives + `cn()`, with **no new global CSS** and **no inline hex/rgb colors**
  - Feature integrates naturally into the page it lives on — the page reads as a cohesive whole
  - Feature is consistent with patterns on other pages — it looks like part of the same app
  - Surrounding elements are updated if needed for the new feature to fit naturally
  - Component is implemented in the appropriate location under `src/` (page UI in `src/features/<feature>/`, cross-feature UI in `src/components/`)
  - A design proposal is presented and **approved by the user before any implementation begins**
  - A Storybook story is created so the user can review the implementation interactively
  - User approves the final implementation before the task is considered complete
</background_information>

<instructions>
## Core Task
Design and implement the UI feature described in $ARGUMENTS as a React component with a Storybook story.

**Do NOT implement immediately.** This command is design-first: produce one or more design proposals, get the user's approval (Step 4), and only then write code. Jumping straight to implementation is a failure of this command.

## Holistic Design Philosophy

**Every UI change is a change to the whole app, not just to a single component.** When you add or modify a feature, you are not designing a component in isolation — you are re-designing the page it lives on (and potentially other pages) to incorporate the new element as a natural part of a cohesive whole.

Three principles guide every decision:

1. **Page-level coherence** — When adding a feature to a page, consider the entire page composition. The new element must have the right visual weight, spacing, and hierarchy relative to everything else on the page. If surrounding elements need to change (spacing, emphasis, layout) for the new piece to integrate naturally, make those changes.

2. **App-level consistency** — This page is one screen among several in a single app. The feature must be consistent with patterns established on other pages. If you create a new pattern (e.g., a new card style, a new section header treatment), check whether similar patterns exist elsewhere and align with them. In CC, "new tokens or one-off styles are smells" — almost always there is already a token, a utility, or a primitive recipe for what you need.

3. **Willingness to ripple changes** — If integrating a feature properly requires updating surrounding elements, adjusting spacing in other sections, or modifying shared components, do it. The goal is a fully integrated whole, not a patchwork of individual additions. Never add a feature that makes the surrounding UI look awkward or unbalanced.

## Step 1: Load Design System Context
Read these to understand the design system, the authoring model, and existing patterns:
- `.claude/skills/cc-design-system/SKILL.md` — the design system spec (vision, critical rules, foundation, semantic color, typography, spacing, breakpoints). This is the authority; CLAUDE.md mandates UI follow it.
- `docs/tailwind-conventions.md` — the operational authoring contract: Tailwind utilities, the `ui/` primitives, `cn()`, `data-*` state, `layoutClassName`, desktop-first `max-*` breakpoint variants, the token-backed-arbitrary-utility parity pattern, and the guardrails. **Read this before writing any component.**
- `.claude/skills/cc-design-system/references/tokens.md` — exact color/spacing/size/radius values and the legacy-token → `@theme` namespace → utility mapping. (Tokens live in `src/features/_root/styles/theme.css` under `@theme`; `src/features/_root/styles/tokens.css` holds legacy `var(--…)` names + `--cc-*` parity colors for preserved CSS.)
- `.claude/skills/cc-design-system/references/components.md` — the `ui/` primitives and the visual contract they reproduce.

Study these exemplars to learn the conventions:
- `src/components/ui/Button.stories.tsx` and `src/components/ui/Badge.stories.tsx` — canonical utility-first primitive usage and Storybook conventions
- `src/features/projects-index/components/ProjectCard.stories.tsx` — a real migrated card component + story (page-level UI living in `src/features/`)
- `src/components/ConfirmDialog.stories.tsx` — modal/dialog pattern (uses the `ModalShell` primitive)

## Step 2: Study the Target Page Context
Before designing anything, understand the page the feature will live on:

1. **Read the page component** — Page-level UI lives in `src/features/<feature>/` (NOT `src/app/`, which is routing-only). Find and read the feature's top-level component and the surface the new piece will sit in. Understand the full composition: what sections exist, how they're laid out, what the visual hierarchy is.

2. **Read surrounding components** — Identify the components adjacent to where the new feature will appear. Read them. Understand their visual weight, spacing, and how they relate to each other. Note which `ui/` primitives and Tailwind patterns they already use so the new piece matches.

3. **Map the page's visual structure** — Before writing code, you should be able to describe:
   - What the page currently looks like from top to bottom
   - Where the new feature will sit in that flow
   - What elements are above, below, and beside it
   - Whether the new feature disrupts the existing visual balance

4. **Check other pages for consistency** — If the feature introduces a pattern (e.g., a new type of card, a new section header, a new action bar), check other pages for similar patterns. The new feature should be consistent with established conventions, ideally reusing an existing `ui/` primitive rather than inventing a parallel one.

## Step 3: Design Within the System & Plan the Integration
CC has a strong, prescriptive visual identity — the job is to fit into it, not to invent a new aesthetic. Compose the design from existing tokens, utilities, primitives, and page patterns. Reason through and assemble a concrete proposal covering:

- **Visual treatment** — Which `@theme` tokens (colors, typography tier, spacing, radii) and which `ui/` primitives (`Button`, `Badge`, `StatusDot`, `Tabs`, `SectionHeader`, `ModalShell`, `IconButton`, `EmptyState`, `FormField`) the feature is built from. Honor the semantic color mapping and the three-font contract (below). Never introduce a new color, font, or spacing value.
- **Where the component lives** — page UI colocated in `src/features/<feature>/`; promote to `src/components/` only when reused by ≥2 features.
- **Props** — keep the interface minimal and strictly typed.
- **Interaction states** — hover (bg moves up exactly one elevation level), active/press (background change, not transform — except a card's `translateY(-1px)`), focus (always a visible cyan ring; never `outline: none` without a replacement), disabled, loading. Encode component state as `data-*` attributes selected by Tailwind `data-*` variants.
- **Responsive behavior** — Plan the feature across CC's breakpoint scale using desktop-first `max-*` variants: **≤1180px** (right pane hides, content → single column), **≤1080px** (topbar crumbs shrink), **≤960px** (sidebar → 280px), **≤768px** (mobile single-panel mode + bottom toolbar). Mobile is a first-class experience, not a degraded desktop view — same information density per panel, one panel at a time. If one layout can't serve all sizes, design separate desktop and mobile presentations (e.g., side-by-side panels on desktop, `data-mobile-panel` switching on mobile; inline actions on desktop, bottom-bar actions on mobile). Touch targets ≥ 44×44px on mobile.
- **Surrounding changes** — Explicitly identify elements on the page that must be adjusted for the new feature to integrate naturally: spacing between sections, visual-weight rebalancing, typography hierarchy, layout/reading-order flow, and any shared-component (topbar, card recipe, primitive) updates. List them as part of the plan; they ship alongside the feature.
- **Storybook stories** — at minimum a Default story, plus stories for key variants and states (hover/active/loading/empty/error as applicable).

Present the proposal with rationale, tradeoffs, and ASCII/text mockups where they help.

## Step 4: Present Proposal(s) for Approval — REQUIRED GATE
Present one or more design proposals to the user and **wait for explicit approval before writing any implementation code.** This gate is mandated by CLAUDE.md's UI Design Rules. For each proposal include:
- The visual treatment (tokens/primitives/patterns it composes from) and a text/ASCII mockup
- Rationale and tradeoffs (and, if multiple, what distinguishes them)
- The integration plan and the list of surrounding changes it implies

If the proposal is genuinely ambiguous or there's a meaningful fork (e.g., two viable layouts with different tradeoffs), run `cctl ask` to let the user choose. Asking is async: after the call succeeds, write a short handoff note and end your turn — the answers arrive in your next message. Do not proceed to Step 5 until the user approves a direction.

## Step 5: Implement the Component
Once approved, create the React component in the appropriate location (`src/features/<feature>/` for page UI; `src/components/` if cross-feature):

- TypeScript with strict, minimal prop types; types derived from Zod schemas where one already exists.
- **Author utility-first.** Use Tailwind utility classes (layout + appearance) backed by the CC `@theme` tokens, plus the `ui/` primitives. **Do NOT add a new global CSS file or CSS module, and do NOT write into `globals.css`** — the `no-unapproved-global-css` guardrail rejects new stylesheets, and the primitives/utilities already cover the visual language.
- **Reach for a `ui/` primitive before hand-rolling** a button, badge, status dot, tabs, section header, modal, icon-button, empty state, or form field. Primitives emit pure utilities and omit `className`/`style`; route layout-only geometry through their `layoutClassName` escape hatch.
- **Compose conditional classes with `cn()`** (`src/lib/ui/cn.ts`) — every argument is a complete static class string. Encode appearance variants as static class maps keyed by a union; encode state as `data-*` attributes. **Never** build a class name by interpolation (`bg-${x}` is rejected by the guardrails and may not even be generated).
- **Never inline a raw `#hex`/`rgb()`/`rgba()`** in a class string (`no-hardcoded-color`). For a parity color with no token, add a `--cc-*` token in `tokens.css` and reference it via a token-backed arbitrary utility (`bg-[var(--cc-…)]`).
- Use spacing utilities (`p-*`/`m-*`/`gap-*`), never literal pixel values for margin/padding.
- Follow import organization (node built-ins → external → internal `@/` aliases → relative).

**Also implement the surrounding changes** identified in Step 3. The deliverable is a page that looks right as a whole, not just an isolated component.

## Step 6: Create the Storybook Story
Create a `*.stories.tsx` file colocated with the component:
- Import `Meta`/`StoryObj` from `@storybook/nextjs-vite` (this project uses the Next.js Vite framework — not `@storybook/react`).
- Import `fn()` from `storybook/test` (note: `storybook/test`, not `@storybook/test`) for any callback props.
- Export a `default` meta with `title`, `component`, and shared `args`.
- Export named stories for Default and each significant variant/state.
- `QueryClientProvider` and `TooltipProvider` are already global decorators (see `.storybook/preview.tsx`); only wrap additional providers if the component needs them.

## Step 7: Review Loop
After implementing, present the user with:
1. A brief summary of the design decisions made
2. The component file path and story file path
3. Key tokens, primitives, and utility patterns used
4. **A list of surrounding changes made** (if any) — explain why each was necessary for integration
5. Instruction to run `cctl dev ensure` and open the story at the session-scoped Storybook URL it returns (never assume port 6006)

Then ask the user: **Does this look good, or would you like any changes?**

If the user requests changes, iterate on the component and story until they approve. Do not consider the task complete until the user explicitly approves.

## Important Constraints
- **Never implement before the user approves a proposal** (Step 4) — this command is design-first.
- **Never add new global CSS, CSS modules, or BEM stylesheets.** Author utility-first with Tailwind + the `ui/` primitives + `cn()`. The `no-unapproved-global-css` guardrail rejects new stylesheets.
- **Never introduce colors, fonts, or spacing values outside the design system tokens.** No inline `#hex`/`rgb()`/`rgba()` in class strings; use token-backed utilities (and a `--cc-*` token + `bg-[var(--cc-…)]` only for unavoidable parity colors).
- **Never compute a class name at runtime** (`bg-${x}`). Compose with `cn()` over complete static strings; use static class maps for variants and `data-*` attributes for state.
- **Always use the three-font contract:** `font-display` (Anybody) for page/modal/empty-state titles; `font-mono` (Geist Mono) for everything else — chrome, labels, controls, data; `font-body` (Manrope) for conversation message prose ONLY.
- **Always respect the semantic color mapping:** cyan = active/primary, amber = awaiting, green = success/merged, red = destructive/error, blue = reserved, violet = Codex agent identity (brand-load-bearing — never use violet for anything else). Never use a full cyan background for selected rows/items (cyan-as-bg is reserved for primary buttons and the active tab) — use elevation + border for selection. Never use `#000` for backgrounds (use `--bg-void`).
- **Always use SVG icons** — 1.5 stroke, `currentColor` inheritance. Never emoji, PNG, or color icons. Give icon-only buttons an `aria-label` + `data-tooltip`.
- **Respect interaction rules:** hover moves background up exactly one elevation level (never skip); press uses background change, not transform (the only positional motion is a card's `translateY(-1px)`); focus always shows a visible cyan ring; radii are `--radius-sm/md/lg` or `9999px` for pills (never invent half-steps).
- **Write operator-tone copy** — sentence case for prose, UPPERCASE mono for labels; no marketing copy, exclamation marks, rhetorical questions, or emoji. Use exact domain terms (session, conversation, worktree, branch, prompt, diff, fork, finalize).
- **Never design in isolation** — every component is considered in the context of its page and the app as a whole; adjust surrounding elements when integration requires it.
- **Always design for all screen sizes** — desktop and the ≤1180 / ≤1080 / ≤960 / ≤768 breakpoints (desktop-first `max-*` variants). Mobile is first-class; touch targets ≥ 44×44px; follow the `data-mobile-panel` convention for mobile panel switching.
</instructions>
