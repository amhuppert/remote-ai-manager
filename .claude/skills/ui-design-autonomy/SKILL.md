---
name: ui-design-autonomy
description: Use when designing new UI, reworking existing UI, or making other UI changes in this project. Grants design autonomy and requires screenshot-based inspection of correctness and aesthetic quality.
---

# UI design autonomy

Deliver UI that is useful, immediately understandable, and beautiful. Usability matters, and beauty matters: both are part of correctness for this work.

## Decision authority

You are granted a high level of autonomy to make UI design decisions within Alex's requested scope. Use your judgment to choose useful content, layout, hierarchy, interaction patterns, copy, spacing, and visual polish. Make routine, reversible choices and carry implementation requests through verification without asking Alex to art-direct each decision. A request for assessment or proposals stays an assessment or proposal task.

Infer intent from the conversation and the existing product. Ask only when missing information materially changes the intended outcome and cannot reasonably be inferred, or an explicit approval boundary applies. Honor existing authorization; do not request the same approval again.

Apply this guidance alongside the project's design system and task-specific workflow. The explicit proposal and final-review gates in `/ui-design` still apply when that workflow is invoked; prepare the concrete proposal or implementation for the relevant gate and exercise design autonomy within each authorized stage. Explicit user instructions take precedence over skill guidelines, subject to higher-priority instructions and tool permissions. If an instruction requires pausing, identify its source and quote the exact requirement rather than inventing an approval gate.

## Don't make me think

Make the purpose of the screen, its current state, and the next useful action apparent at a glance. Prefer familiar conventions, clear labels, visible feedback, and sensible defaults. Reduce unnecessary decisions, competing emphasis, and information the user must remember. Keep needed capabilities discoverable; simplicity should help users accomplish their task.

Judge the whole composition: hierarchy, typography, spacing, alignment, density, contrast, and consistency with neighboring UI. Give the primary task appropriate visual weight and make secondary details easy to scan. Polish surrounding elements when needed for the requested change to fit naturally, keeping the work within scope.

Read `.claude/skills/cc-design-system/SKILL.md` and the references relevant to the change; follow `docs/tailwind-conventions.md` when implementing. Use established tokens and primitives to achieve a cohesive result. Use Storybook for UI prototyping and the `ui-primitive` skill when changing shared primitives.

## Visual verification and completion

Before browser or screenshot tooling, run `cctl dev ensure` and use this session's returned URL. Consult the `nextjs-mcp` skill for browser tooling and diagnostics.

Take screenshots of the rendered UI and open them for visual inspection. Inspect the changed surface in its surrounding page, or in its Storybook context for a prototype. Choose representative states and viewport sizes based on the change, including narrow layouts and empty, loading, error, or expanded states where affected.

Evaluate both:

- **Correctness and usability:** intended content and state, readable text, clear actions and feedback, responsive layout, and absence of clipping, overflow, or overlap. Exercise affected interactions and keyboard behavior in the browser; screenshots alone cannot establish these.
- **Aesthetic quality:** coherent hierarchy, balanced spacing and alignment, considered typography, appropriate visual weight, and consistency with the design system. Ask whether the rendered result feels intentional and makes the user's task obvious.

Fix issues found during inspection, then capture and inspect the affected states again. Finish when the requested behavior works, relevant checks pass, and the final screenshots show no unresolved correctness or aesthetic issues within scope. Broaden or repeat verification only for a change, failure, or unresolved concern. If visual verification is blocked, report the concrete blocker and what remains unverified.

Report the result concisely, with consequential design decisions, the pages or stories and states inspected, screenshot paths or links, and any remaining limitations. Claim visual verification only for images you actually inspected.
