---
name: plan-ralph-loop
description: >-
  This skill should be used when planning a Ralph Loop autonomous workflow.
  Use when the user wants to start a Ralph Loop, says "initialize ralph loop",
  "start autonomous workflow", "create a ralph loop", "plan the tasks for
  ralph", or when you need to call the initialize_ralph_loop MCP tool. This
  skill produces a high-quality task plan that avoids common pitfalls.
---

# Ralph Loop Task Planning

You are planning a Ralph Loop autonomous workflow. Ralph Loop runs Claude Code in isolated iterations — each iteration gets a fresh conversation, sees only the objective and task plan, and has no memory of previous iterations beyond a brief summary. Your task plan is the primary mechanism for ensuring the objective is completed correctly.

**Your job**: Break the user's objective into a structured task plan, then call the `initialize_ralph_loop` MCP tool with the plan.

## Planning Process

Work through these steps before calling the tool:

### Step 1: Understand the Objective

Read the user's request carefully. If the session has a Focus mode objective, use that. Identify:
- What is the deliverable? (app, feature, fix, refactoring, etc.)
- What does "done" look like from the user's perspective?
- What technology stack is involved?

If critical information is missing and you cannot infer it from the codebase, ask the user before proceeding. Otherwise, make reasonable decisions and proceed.

### Step 2: Survey the Codebase

Before planning, understand what already exists:
- Read key config files (package.json, tsconfig, framework configs)
- Check directory structure for conventions
- Look at existing code patterns the tasks should follow

This context is essential for writing self-contained task descriptions.

### Step 3: Decompose into Tasks

Break the objective into discrete tasks. Each task must be:

- **Self-contained**: The executing agent sees only the objective, task list, and codebase. It has NO access to this conversation. Every task description must include the specific "what", "why", which files are involved, and how to verify.
- **Achievable in one iteration**: Target 10-30 minutes of work per task. If a task would require 40+ minutes, split it.
- **Independently verifiable**: The agent should be able to confirm the task is done (tests pass, types check, app builds, etc.).

### Step 4: Assign Groups

Group tasks by dependency order:
- **Group 1**: Foundation tasks with no dependencies (project setup, types, schemas, configuration)
- **Group 2**: Tasks that depend on Group 1 outputs
- **Group N+1**: Tasks that depend on Group N

Rules:
- Tasks within the same group MUST be independent of each other.
- The number of tasks per group does not matter — iterations are not expected to complete an entire group. Progress is measured in completed tasks, not completed groups.

### Step 5: Add Integration and Validation Tasks

**CRITICAL — do not skip this step.**

Add tasks to the highest group that verify the work is integrated end-to-end:

- If the objective produces a runnable app/feature: add a task to verify all components are wired together and the app works as a whole.
- If the objective involves multiple files that must work together: add a task to verify they are properly connected (imports, routing, configuration).
- If earlier tasks create stubs/placeholders: add explicit tasks to replace them with real implementations.

The validation task should describe specific checks, not just "verify everything works."

### Step 6: Review for Common Pitfalls

Before calling the tool, review your plan against these failure modes:

<pitfall name="stub-orphaning">
**Problem**: Task A creates stub/placeholder files. Task B creates the real implementations in separate files. Neither task updates the stubs to use the real implementations.

**Fix**: Task B must explicitly say "update [stub file] to import and render [real component]" — not just "create [real component]."

**Example**:
- BAD: Task 1: "Set up app routes (stubs only)." Task 2: "Build the Dashboard screen component."
- GOOD: Task 1: "Set up app routes (stubs only)." Task 2: "Build the Dashboard screen component in src/features/Dashboard.tsx AND update app/dashboard/page.tsx to import and render it."
</pitfall>

<pitfall name="missing-wiring-tasks">
**Problem**: Individual components are built and tested in isolation, but nothing connects them into a working whole. Tests pass because they test components directly, not through the app's actual entry points.

**Fix**: Always include an explicit wiring/integration task in the final group. This task should verify that the app's entry points (routes, main function, CLI commands) actually invoke the implemented components.
</pitfall>

<pitfall name="vague-task-descriptions">
**Problem**: Task descriptions like "implement the feature" or "set up the database" leave too much to the executing agent's interpretation. Different iterations may make incompatible decisions.

**Fix**: Specify file paths, function signatures, data formats, and conventions. Reference existing patterns in the codebase. The executing agent should not need to make architectural decisions.
</pitfall>

<pitfall name="testing-without-integration">
**Problem**: Every component has unit tests that pass, but the app doesn't work because components aren't connected. The Ralph Loop exits successfully because "all tests pass."

**Fix**: The final validation task should include integration-level checks: build the project, verify entry points render real content (not placeholder text), run the app if applicable.
</pitfall>

### Step 7: Write the Objective

Write a concise objective string (1-3 sentences) that captures:
- What is being built
- Key constraints or requirements
- What "done" looks like

This objective is shown to every iteration agent. Keep it focused.

### Step 8: Prepare References (Optional)

If you have design documents, specs, or architectural decisions that executing agents should reference, create files in `memory-bank/ralph-reference/` within the worktree and include them as references. This is useful for:
- Product specifications or requirements
- Design system documentation
- API contracts
- Architecture decisions

### Step 9: Call the Tool

Call `initialize_ralph_loop` with:
- `objective`: Your concise objective string
- `tasks`: Array of `{ description, group }` entries
- `references`: (Optional) Array of `{ filePath, description }` entries

After calling the tool, tell the user to review the plan in the CC UI and confirm when ready.

## Task Description Template

Each task description should follow this pattern:

```
[Action verb] [what to create/modify] in [specific files/directories].

[2-3 sentences of context: what this component does, what patterns to follow,
what existing code to reference.]

[Verification steps: how to confirm the task is done.]
```

Example:
```
Implement the TaskRepository in src/repositories/taskRepository.ts using the
Database interface from src/db/database.ts. Follow the existing pattern in
tagRepository.ts: constructor takes a Database instance, methods return
Result<T> types, use branded TaskId for type safety.

Write tests in src/repositories/__tests__/taskRepository.test.ts using an
in-memory SQLite database. Test CRUD operations, hierarchy queries
(getChildren, getAncestors), and error cases.

Verify: bun run test -- taskRepository passes, bun run typecheck succeeds.
```

## Anti-Patterns to Avoid

| Do NOT | Do Instead |
|---|---|
| Say "build the screens" without specifying wiring | Explicitly state which route files to update |
| Assume the agent remembers previous conversations | Make every task description self-contained |
| Include meta-tasks like "review all work" | Make each task include its own verification |
| Leave architectural decisions to the executing agent | Specify patterns, file paths, conventions |
| Skip the final validation task | Always include end-to-end verification |
| Create a task that only creates tests without implementation | Pair testing with implementation in the same task |
