---
name: ui-design
description: Design a Command Center UI feature through proposals, user review, and a Storybook prototype. Use when the user invokes /ui-design or explicitly requests that design review workflow.
---

# UI feature design

Deliver a feature that fits its page and Command Center's design system, with an interactive Storybook prototype. This is the explicit design review workflow: present a concrete proposal before implementation, then present the verified prototype for review. Existing approval in the conversation satisfies its stage; explicit user instructions can change skill guidelines within the project's permission policy.

## Understand the surface

Read `.claude/skills/cc-design-system/SKILL.md` and `docs/tailwind-conventions.md`. Load the design references needed for the feature rather than every reference. Inspect the target feature under `src/features/`, its surrounding components, and an existing analogous pattern. Routing stays in `src/app/`; reusable cross-feature UI belongs in `src/components/`.

Study one relevant story, such as `src/features/projects-index/components/ProjectCard.stories.tsx`, `src/components/ConfirmDialog.stories.tsx`, or a primitive's story in `src/components/ui/`.

## Propose and obtain the design decision

Present one recommended proposal, or alternatives when their tradeoffs matter. Include:

- The layout, content hierarchy, interactions, and meaningful states.
- The tokens and existing primitives it composes; a text mockup when helpful.
- Responsive behavior and the surrounding changes required for integration.
- Rationale, material tradeoffs, and which stories will make it reviewable.

Wait for Alex's approval of the proposal before implementing this workflow. Use `cctl ask` when presenting a decision through CC; follow its end-turn instruction. If a proposal is already approved, proceed with that direction. Routine details within the approved direction are yours to resolve.

## Implement and prototype

Implement the approved scope, including surrounding changes needed to integrate it. Keep unrelated page or shared-component redesigns outside the change.

- Compose existing `src/components/ui/` primitives, Tailwind utilities backed by `@theme` tokens, and `cn()` over complete static class strings. Use `data-*` for state and `layoutClassName` for a primitive's external geometry. The design system and Tailwind contract own styling details.
- Use the `ui-primitive` skill for new or changed shared primitives. Check the current exports before choosing an API; dialogs use the `Dialog`/`AlertDialog` parts.
- Create colocated `*.stories.tsx` stories covering the feature's significant states. Import `Meta`/`StoryObj` from `@storybook/nextjs-vite` and callback `fn()` from `storybook/test`. Check `.storybook/preview.tsx` for existing providers and add only missing ones.

## Verify and present for review

Run the checks relevant to the change. Use `cctl dev ensure storybook` yourself and open the returned session URL; the `nextjs-mcp` skill covers diagnostics and browser tools. Inspect screenshots of representative states and affected narrow layouts, and exercise the interactions and keyboard behavior. Use [.agents/skills/ui-design-autonomy/SKILL.md](../ui-design-autonomy/SKILL.md) for visual quality.

Fix issues found, then recheck the affected states. Once checks pass, repeat or broaden them only for a change, failure, or unresolved concern.

Present the verified prototype with the story URL, component/story paths, consequential design decisions, screenshot evidence, and limitations. This workflow's final review is complete when Alex accepts the prototype; if feedback asks for changes, implement and verify those changes within the approved direction.
