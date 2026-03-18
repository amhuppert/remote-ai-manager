---
description: Design a new UI feature using Storybook for prototyping
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, WebSearch, WebFetch, AskUserQuestion
argument-hint: <feature-description>
---

# UI Feature Design

<background_information>
- **Mission**: Design and implement a new UI feature as a React component with a Storybook story, following the project's established design system and conventions. The feature must integrate naturally into the existing UI — it should look like it was always meant to be there, never like it was tacked on as an afterthought.
- **Success Criteria**:
  - Feature is visually consistent with the existing design system (colors, typography, spacing, interactions)
  - Feature integrates naturally into the page it lives on — the page reads as a cohesive whole
  - Feature is consistent with patterns on other pages — it looks like part of the same app
  - Surrounding elements are updated if needed for the new feature to fit naturally
  - Component is implemented in the appropriate location under `src/`
  - A Storybook story is created so the user can review the design interactively
  - User approves the design before the task is considered complete
</background_information>

<instructions>
## Core Task
Design and implement the UI feature described in $ARGUMENTS as a React component with a Storybook story.

## Holistic Design Philosophy

**Every UI change is a change to the whole app, not just to a single component.** When you add or modify a feature, you are not designing a component in isolation — you are re-designing the page it lives on (and potentially other pages) to incorporate the new element as a natural part of a cohesive whole.

Three principles guide every decision:

1. **Page-level coherence** — When adding a feature to a page, consider the entire page composition. The new element must have the right visual weight, spacing, and hierarchy relative to everything else on the page. If surrounding elements need to change (spacing, emphasis, layout) for the new piece to integrate naturally, make those changes.

2. **App-level consistency** — This page is one screen among several in a single app. The feature must be consistent with patterns established on other pages. If you create a new pattern (e.g., a new card style, a new section header treatment), check whether similar patterns exist elsewhere and align with them.

3. **Willingness to ripple changes** — If integrating a feature properly requires updating surrounding elements, adjusting spacing in other sections, or modifying shared components, do it. The goal is a fully integrated whole, not a patchwork of individual additions. Never add a feature that makes the surrounding UI look awkward or unbalanced.

## Step 1: Load Design System Context
Read the following files to understand the design system, existing patterns, and product requirements:
- `.kiro/specs/ui-design-system/design.md` — the design system specification (vision, principles, tokens, component contracts)
- `src/app/globals.css` — the canonical CSS tokens and component styles

Study 1–2 existing stories to understand Storybook conventions:
- `src/components/ConfirmDialog.stories.tsx` — modal/dialog pattern
- `src/app/projects/ProjectCard.stories.tsx` — card component pattern

## Step 2: Study the Target Page Context
Before designing anything, understand the page the feature will live on:

1. **Read the page component** — Find and read the page file (`page.tsx`) and its main feature component (e.g., `ProjectsGrid.tsx`, `SessionsList.tsx`, `ConversationList.tsx`). Understand the full composition: what sections exist, how they're laid out, what the visual hierarchy is.

2. **Read surrounding components** — Identify the components adjacent to where the new feature will appear. Read them. Understand their visual weight, spacing, and how they relate to each other.

3. **Map the page's visual structure** — Before writing code, you should be able to describe:
   - What the page currently looks like from top to bottom
   - Where the new feature will sit in that flow
   - What elements are above, below, and beside it
   - Whether the new feature disrupts the existing visual balance

4. **Check other pages for consistency** — If the feature introduces a pattern (e.g., a new type of card, a new section header, a new action bar), check other pages for similar patterns. The new feature should be consistent with established conventions.

## Step 3: Invoke the Frontend Design Skill
Use the `/frontend-design` skill to generate a high-quality, distinctive design for the requested feature. When invoking the skill, provide it with:
- The feature description from $ARGUMENTS
- The design system tokens (CSS custom properties from globals.css): color palette, typography families, spacing scale, border radii
- The design principles from the design system (especially: dark theme, semantic color usage, monospace data identity, three-font contract, responsive behavior)
- **Page context** — Describe the page the feature will live on: what's above it, what's below it, what the overall page composition looks like. This is critical so the design accounts for integration, not just the component in isolation.
- **Existing patterns** — If similar UI patterns exist elsewhere in the app, describe them so the design is consistent.

## Step 4: Plan the Integration
Before writing any code, reason through:
- **Where** the component lives — shared in `src/components/` if reusable, or colocated with its page in `src/app/**/`
- **What props** the component accepts (keep the interface minimal and typed)
- **Which design tokens** to use (never introduce new colors or fonts — use existing CSS custom properties)
- **Interaction states**: hover, active, focus, disabled, loading — per the design system conventions
- **What Storybook stories** are needed — at minimum a Default story, plus stories for key variants or states
- **Responsive behavior** — Plan how the feature works at all three breakpoints (desktop >900px, tablet ≤900px, mobile ≤768px). If the same layout can't work across all sizes, design separate desktop and mobile presentations. Check how existing elements on the page adapt at each breakpoint and ensure the new feature follows the same patterns (e.g., `data-mobile-panel` for panel switching, bottom bar for mobile actions, 44×44px touch targets).
- **What surrounding changes are needed** — Explicitly identify elements on the page that need to be adjusted for the new feature to integrate naturally. Common adjustments include:
  - Spacing between sections (does the new element create too much or too little breathing room?)
  - Visual weight rebalancing (does the new element overshadow or get lost among existing elements?)
  - Typography hierarchy (does the new element create confusion about information hierarchy?)
  - Layout flow (does the page's top-to-bottom reading order still make sense?)
  - Shared component updates (does the Topbar, a shared card style, or other cross-page element need adjustment?)

If surrounding changes are needed, list them as part of the implementation plan and implement them alongside the new feature.

## Step 5: Implement the Component
Create the React component file in the appropriate location:
- Use TypeScript with strict prop types
- Apply CSS classes using kebab-case BEM-style naming (e.g., `feature-card__header`)
- Add component styles either inline in `globals.css` (if broadly applicable) or in a colocated CSS module
- Follow the import organization convention (node built-ins → external packages → internal `@/` aliases → relative)

**Also implement any surrounding changes** identified in Step 4. If the feature requires adjusting spacing, rebalancing visual weight, or modifying adjacent components, make those changes now. The deliverable is not just a component — it's a page that looks right as a whole.

## Step 6: Create the Storybook Story
Create a `*.stories.tsx` file colocated with the component:
- Use `@storybook/nextjs-vite` imports (`Meta`, `StoryObj`)
- Export a `default` meta with `title`, `component`, and shared `args`
- Export named story exports for Default and each significant variant
- Use `fn()` from `@storybook/test` for any callback props
- Wrap with necessary providers if needed (check `.storybook/preview.tsx` — QueryClientProvider is already global)

## Step 7: Review Loop
After implementing, present the user with:
1. A brief summary of the design decisions made
2. The component file path and story file path
3. Key CSS tokens and patterns used
4. **A list of surrounding changes made** (if any) — explain why each was necessary for integration
5. Instruction to run `bun run storybook` (port 6006) and navigate to the story to review

Then ask the user: **Does this look good, or would you like any changes?**

If the user requests changes, iterate on the component and story until they approve. Do not consider the task complete until the user explicitly approves.

## Important Constraints
- **Never** introduce colors, fonts, or spacing values outside the design system tokens
- **Never** add external CSS frameworks or libraries
- **Always** use the three-font contract: display font for titles, mono font for data/controls/labels, body font for prose only
- **Always** respect the semantic color mapping: cyan = active/primary, green = ready/success, amber = warning/user, red = danger
- **Never** design in isolation — every component must be considered in the context of its page and the app as a whole
- **Always** be willing to adjust surrounding elements if needed for integration — the page should look right as a whole, not just the new feature
- **Always** design for all screen sizes — every feature must work on desktop (>900px), tablet (≤900px), and mobile (≤768px). Mobile is a first-class experience, not a degraded desktop view. If the same layout doesn't work across all sizes, implement separate desktop and mobile presentations (e.g., side-by-side panels on desktop, stacked/tabbed panels on mobile; inline actions on desktop, bottom bar actions on mobile). Touch targets must be at least 44×44px on mobile. Reference existing responsive patterns in `globals.css` and follow the `data-mobile-panel` attribute convention for mobile panel switching.
- Stories must use `@storybook/nextjs-vite` (not `@storybook/react`) — this project uses the Next.js Vite framework
</instructions>
