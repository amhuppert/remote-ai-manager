---
description: Design a new UI feature in the static HTML prototype
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, WebSearch, WebFetch, AskUserQuestion
argument-hint: <feature-description>
---

# UI Feature Design

<background_information>
- **Mission**: Design and implement a new UI feature in the static HTML prototype (`ui-design/index.html`), following the project's established design system and conventions
- **Success Criteria**:
  - Feature is visually consistent with the existing design system (colors, typography, spacing, interactions)
  - Implementation lives in the static HTML prototype for review before any Next.js work
  - User approves the design before the task is considered complete
</background_information>

<instructions>
## Core Task
Design and implement the UI feature described in $ARGUMENTS within the static HTML prototype file.

## Step 1: Load Context
Read the following files to understand the design system, existing patterns, and product requirements:
- `.kiro/specs/ui-design-system/design.md` — the design system
- `src/app/globals.css` — the canonical design system tokens and component styles

This is the static prototype file:
- `ui-design/index.html` — the static HTML prototype (your canvas) - quite large, only read when needed and not all at once

## Step 2: Invoke the Frontend Design Skill
Use the `/frontend-design` skill to generate a high-quality, distinctive design for the requested feature. When invoking the skill, provide it with:
- The feature description from $ARGUMENTS
- The design system tokens (CSS custom properties from globals.css): color palette, typography families, spacing scale, border radii
- The design principles from UI_PRODUCT_REQUIREMENTS.md (especially: dark theme, semantic color usage, monospace data identity, three-font contract, responsive behavior)
- The existing HTML structure from the prototype so the new feature integrates seamlessly

## Step 3: Think Through the Approach
Before writing any code, reason through:
- **Where** in the prototype the new feature belongs (which view/section)
- **How** it interacts with existing components (topbar, cards, panels, modals)
- **Which design tokens** to use (never introduce new colors or fonts — use the existing palette)
- **Responsive behavior**: how the feature adapts across desktop (>900px), tablet (768–900px), and mobile (<=768px)
- **Interaction states**: hover, active, focus, disabled, loading — per the design system conventions

## Step 4: Implement in the Prototype
Edit `ui-design/index.html` to add the new feature:
- Add CSS within the existing `<style>` block, using the established custom properties
- Add HTML in the appropriate section of the document
- Follow existing code patterns and naming conventions in the file
- Ensure the feature works standalone in the static prototype (no external JS dependencies beyond what's already there)

## Step 5: Review Loop
After implementing the feature, present the user with:
1. A brief summary of the design decisions made
2. Key CSS tokens and patterns used
3. How the feature behaves across breakpoints
4. Ask the user to open `ui-design/index.html` in their browser to review

Then ask the user: **Does this look good, or would you like any changes?**

If the user requests changes, iterate on the design until they approve. Do not consider the task complete until the user explicitly approves.

## Important Constraints
- **Never** introduce colors, fonts, or spacing values outside the design system tokens
- **Never** add external CSS frameworks or libraries
- **Always** use the three-font contract: display font for titles, mono font for data/controls/labels, body font for prose only
- **Always** respect the semantic color mapping: cyan = active/primary, green = ready/success, amber = warning/user, red = danger
- Keep the prototype self-contained — all styles inline in the `<style>` block
</instructions>
