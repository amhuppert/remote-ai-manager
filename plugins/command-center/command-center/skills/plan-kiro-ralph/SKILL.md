---
name: plan-kiro-ralph
description: >-
  This skill should be used when planning a Ralph Loop to implement a Kiro
  specification. Applicable when the user says "implement this spec with ralph",
  "plan a kiro ralph loop", "use ralph for the spec tasks", "autonomous spec
  implementation", "run the spec autonomously", or when combining Kiro
  spec-driven development with Ralph Loop autonomous execution. Also applies when a Kiro
  spec already exists and the user wants a Ralph Loop to execute the
  implementation and validation phases.
---

# Kiro Spec Ralph Loop Planning

Plan a Ralph Loop that drives a Kiro specification end-to-end — from
`spec-init` through final validation. Each Kiro workflow step becomes a
separate Ralph Loop task, with a dynamic validation cycle that catches and
fixes gaps before declaring completion.

**Key constraint**: Each Ralph Loop iteration gets a fresh conversation with no
memory of previous iterations. Task descriptions are the only mechanism for
communicating intent — make them self-contained with specific file paths,
commands, and verification steps. For general Ralph Loop planning guidance
(task sizing, grouping, pitfall avoidance), also consult the `plan-ralph-loop`
skill.

## Critical Rules

These rules prevent a known failure mode where the Ralph Loop agent validates
against its own narrow objective instead of the full spec, resulting in
incomplete implementations signed off as complete.

### Rule 1 — Scope Comes from the Spec, Not the Codebase

ALWAYS read `.kiro/specs/<feature>/tasks.md` before determining which Ralph
Loop tasks to create. Never infer "remaining work" by scanning source files.
The task list in tasks.md is the single source of truth for implementation
scope.

### Rule 2 — Every Spec Task Gets a Ralph Loop Task

Map every unchecked task (`- [ ]`) in tasks.md to a Ralph Loop task.
Cross-reference the two lists before calling `initialize_ralph_loop`. If any
spec task has no corresponding Ralph Loop task, the plan is incomplete.

### Rule 3 — Validation Checks All Requirements

Validation tasks must validate against ALL requirements in the spec — not the
Ralph Loop's stated objective or the tasks from recent iterations. The
validation prompt must explicitly instruct the agent to read `requirements.md`,
`design.md`, and `tasks.md` and check every item.

### Rule 4 — Validation Creates Fix Tasks Dynamically

When a validation task finds issues, it must call `update_fix_plan` to add new
fix tasks (with specific file paths and required changes) followed by a
re-validation task. This cycle repeats until validation passes clean. A
validation task must NEVER report status `"complete"` while issues remain.

### Rule 5 — Final Codex Validation is Mandatory

The last task must use `mcp__codex-tool__run_codex` with the
`$kiro--validate-impl` skill for comprehensive independent validation. Codex
operates outside the Ralph Loop agent's context, preventing self-referential
bias.

## Planning Process

### Step 1: Assess Current State

Read `.kiro/specs/<feature>/` to determine the starting point:

| State | Start From |
|---|---|
| No spec directory | Phase 1 — Specification |
| spec.json exists, no tasks.md | Whichever phase is missing |
| tasks.md exists, unchecked tasks | Phase 2 — Implementation |
| All tasks checked | Phase 3 — Validation only |

### Step 2: Plan Specification Tasks (if needed)

Add one Ralph Loop task per Kiro command. Use sequential groups — each step
depends on the previous. Pass `-y` to auto-approve phases since the Ralph Loop
runs autonomously.

| Group | Command | Notes |
|---|---|---|
| 1 | `/kiro:spec-init "<description>"` | |
| 2 | `/kiro:spec-requirements <feature>` | |
| 3 | `/kiro:validate-gap <feature>` | Recommended for brownfield |
| 4 | `/kiro:spec-design <feature> -y` | Auto-approves requirements |
| 5 | `/kiro:validate-design <feature>` | |
| 6 | `/kiro:spec-tasks <feature> -y` | Auto-approves design |
| 7 | **Bridge task** | Reads generated tasks.md, adds impl tasks |

The **bridge task** (Group 7) is required when spec generation is part of the
plan. Its description must instruct the agent to read the generated `tasks.md`,
map each task to a Ralph Loop task using `update_fix_plan`, and add the
validation cycle tasks. Read `references/task-templates.md` for the template.

### Step 3: Plan Implementation Tasks

Read `tasks.md` and create one Ralph Loop task per spec task (or per small
group of tightly coupled subtasks). Each task runs
`/kiro:spec-impl <feature> <task-numbers> -y`.

Assign groups matching the dependency order in tasks.md. Tasks with parallel
markers can share a group.

### Step 4: Plan Validation Cycle

After all implementation tasks, add two validation tasks in the next group:

1. **Validate-impl task** — Runs `/kiro:validate-impl <feature>` with
   instructions to check every requirement and dynamically add fix tasks if
   issues are found. Read `references/task-templates.md` for the full template.

2. **Codex validation task** (final group) — Calls
   `mcp__codex-tool__run_codex` with the `$kiro--validate-impl` skill. If
   Codex finds gaps, add fix tasks and another Codex validation task.

### Step 5: Write the Objective

The objective must:
- Name the feature and spec path
- State which phases are included
- Explicitly state that ALL tasks in the spec must be completed and validated

### Step 6: Call the Tool

Call `initialize_ralph_loop` with the complete plan. Include spec files as
references:
- `.kiro/specs/<feature>/requirements.md`
- `.kiro/specs/<feature>/design.md`
- `.kiro/specs/<feature>/tasks.md`

## Anti-Patterns

| Anti-Pattern | Consequence | Prevention |
|---|---|---|
| Infer scope from codebase scan | Agent sees UI work done, skips backend tasks | Read tasks.md as source of truth (Rule 1) |
| Objective says "remaining work" | Ralph Loop scope is a subset of the spec | Objective references the full spec (Rule 2) |
| Validation checks own objective | Passes because it validates the narrow scope | Validation reads requirements.md (Rule 3) |
| Validation reports issues and exits | Issues noted but never fixed | Must add fix tasks via update_fix_plan (Rule 4) |
| Single validation pass at end | Gaps found too late or not fixable | Validate-impl + Codex cycle (Rules 4-5) |

## Reference Files

- **`references/task-templates.md`** — Complete Ralph Loop task description
  templates for every Kiro command, including the bridge task, validation cycle
  tasks, and Codex validation task. Read this for exact wording when writing
  task descriptions.
