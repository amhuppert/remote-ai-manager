---
description: Design a new UI feature using Storybook for prototyping
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, WebSearch, WebFetch, AskUserQuestion
argument-hint: <feature-description>
---

# UI Feature Design

<background_information>
- **Mission**: Design and implement a new UI feature as a React component with a Storybook story, following the project's established design system and conventions
- **Success Criteria**:
  - Feature is visually consistent with the existing design system (colors, typography, spacing, interactions)
  - Component is implemented in the appropriate location under `src/`
  - A Storybook story is created so the user can review the design interactively
  - User approves the design before the task is considered complete
</background_information>

<instructions>
## Core Task
Design and implement the UI feature described in $ARGUMENTS as a React component with a Storybook story.

## Step 1: Load Context
Read the following files to understand the design system, existing patterns, and product requirements:
- `.kiro/specs/ui-design-system/design.md` — the design system
- `src/app/globals.css` — the canonical design system tokens and component styles

Study 1–2 existing stories to understand conventions:
- `src/components/ConfirmDialog.stories.tsx` — modal/dialog pattern
- `src/app/projects/ProjectCard.stories.tsx` — card component pattern

## Step 2: Invoke the Frontend Design Skill
Use the `/frontend-design` skill to generate a high-quality, distinctive design for the requested feature. When invoking the skill, provide it with:
- The feature description from $ARGUMENTS
- The design system tokens (CSS custom properties from globals.css): color palette, typography families, spacing scale, border radii
- The design principles from the design system (especially: dark theme, semantic color usage, monospace data identity, three-font contract, responsive behavior)

## Step 3: Think Through the Approach
Before writing any code, reason through:
- **Where** the component lives — shared in `src/components/` if reusable, or colocated with its page in `src/app/**/`
- **What props** the component accepts (keep the interface minimal and typed)
- **Which design tokens** to use (never introduce new colors or fonts — use existing CSS custom properties)
- **Interaction states**: hover, active, focus, disabled, loading — per the design system conventions
- **What Storybook stories** are needed — at minimum a Default story, plus stories for key variants or states

## Step 4: Implement the Component
Create the React component file in the appropriate location:
- Use TypeScript with strict prop types
- Apply CSS classes using kebab-case BEM-style naming (e.g., `feature-card__header`)
- Add component styles either inline in `globals.css` (if broadly applicable) or in a colocated CSS module
- Follow the import organization convention (node built-ins → external packages → internal `@/` aliases → relative)

## Step 5: Create the Storybook Story
Create a `*.stories.tsx` file colocated with the component:
- Use `@storybook/nextjs-vite` imports (`Meta`, `StoryObj`)
- Export a `default` meta with `title`, `component`, and shared `args`
- Export named story exports for Default and each significant variant
- Use `fn()` from `@storybook/test` for any callback props
- Wrap with necessary providers if needed (check `.storybook/preview.tsx` — QueryClientProvider is already global)

## Step 6: Review Loop
After implementing, present the user with:
1. A brief summary of the design decisions made
2. The component file path and story file path
3. Key CSS tokens and patterns used
4. Instruction to run `bun run storybook` (port 6006) and navigate to the story to review

Then ask the user: **Does this look good, or would you like any changes?**

If the user requests changes, iterate on the component and story until they approve. Do not consider the task complete until the user explicitly approves.

## Important Constraints
- **Never** introduce colors, fonts, or spacing values outside the design system tokens
- **Never** add external CSS frameworks or libraries
- **Always** use the three-font contract: display font for titles, mono font for data/controls/labels, body font for prose only
- **Always** respect the semantic color mapping: cyan = active/primary, green = ready/success, amber = warning/user, red = danger
- Stories must use `@storybook/nextjs-vite` (not `@storybook/react`) — this project uses the Next.js Vite framework
</instructions>
