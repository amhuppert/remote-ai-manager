# Kiro Ralph Loop Task Templates

Complete task description templates for each Kiro workflow step in a Ralph
Loop. Copy and adapt these — the executing agent sees only the objective and
task description, with no memory of the planning conversation.

## Phase 1: Specification Tasks

### spec-init

```
Run `/kiro:spec-init "<DESCRIPTION>"` to initialize the specification
structure. This creates the directory at `.kiro/specs/<feature>/` with
spec.json and requirements.md scaffolds.

Verify: `.kiro/specs/<feature>/spec.json` exists and contains valid JSON.
```

### spec-requirements

```
Run `/kiro:spec-requirements <FEATURE>` to generate comprehensive
requirements for the specification.

Context: The spec was initialized in a previous iteration. Read
`.kiro/specs/<FEATURE>/spec.json` to confirm the feature name.

Verify: `.kiro/specs/<FEATURE>/requirements.md` contains numbered
requirements in EARS format (WHEN/THEN/SHALL).
```

### validate-gap

```
Run `/kiro:validate-gap <FEATURE>` to analyze the gap between the
generated requirements and the existing codebase.

Context: Requirements exist at `.kiro/specs/<FEATURE>/requirements.md`.
This step identifies existing patterns, reusable components, and
integration challenges to inform the design phase.

Verify: Gap analysis output is generated (written to design.md or
displayed). No file changes expected — this is an informational step.
```

### spec-design

```
Run `/kiro:spec-design <FEATURE> -y` to generate the technical design.
The `-y` flag auto-approves the requirements phase.

Context: Requirements at `.kiro/specs/<FEATURE>/requirements.md` define
WHAT to build. The design translates these into HOW — architecture,
components, interfaces, data models.

Verify: `.kiro/specs/<FEATURE>/design.md` exists and contains component
definitions, data models, and requirements traceability.
```

### validate-design

```
Run `/kiro:validate-design <FEATURE>` to review the technical design for
quality and completeness.

Context: Design at `.kiro/specs/<FEATURE>/design.md` was generated from
requirements. This validation checks for architectural issues, missing
components, and requirement coverage gaps.

If the validation produces a NO-GO decision:
1. For each issue identified, call `update_fix_plan` to add a fix task
   that edits `.kiro/specs/<FEATURE>/design.md` to address the specific
   concern (include the exact section and what needs to change)
2. Add a re-validation task (copy of this task) after the fix tasks
3. Report status as "in_progress" — do NOT report "complete"

Only report status "complete" if the validation produces a GO decision.
```

### spec-tasks

```
Run `/kiro:spec-tasks <FEATURE> -y` to generate implementation tasks from
the design. The `-y` flag auto-approves the design phase.

Context: Design at `.kiro/specs/<FEATURE>/design.md` defines components
and interfaces. Tasks break these into implementable units.

Verify: `.kiro/specs/<FEATURE>/tasks.md` exists and contains numbered,
checkboxed tasks (`- [ ]`) organized by dependency group.
```

## Bridge Task

The bridge task is required when spec generation precedes implementation in the
same Ralph Loop. It reads the generated tasks and dynamically extends the plan.

```
Read `.kiro/specs/<FEATURE>/tasks.md` and create Ralph Loop tasks for
implementation and validation.

Steps:
1. Parse all unchecked tasks (`- [ ]`) from tasks.md
2. Group them by their task numbering (e.g., all 1.x tasks, all 2.x tasks)
3. For each task group, call `update_fix_plan` to add a new task:
   - Description: "Run `/kiro:spec-impl <FEATURE> <TASK_NUMBERS> -y`
     to implement tasks <TASK_NUMBERS>. Read `.kiro/specs/<FEATURE>/design.md`
     for architecture guidance. Verify: the project's typecheck and test
     commands pass after implementation (check package.json scripts or
     project config for the correct commands)."
   - Group: assign sequentially based on task dependencies
4. After all implementation tasks, add a validation task (see validation
   template below) in the next group
5. After the validation task, add a Codex validation task (see Codex
   template below) in the group after that

CRITICAL: Every unchecked task in tasks.md MUST have a corresponding
Ralph Loop task. Cross-check the two lists before reporting complete.

Verify: The fix plan now contains implementation tasks covering ALL
unchecked items from tasks.md, plus validation and Codex tasks.
```

## Phase 2: Implementation Tasks

One task per spec task group. Adapt this template:

```
Run `/kiro:spec-impl <FEATURE> <TASK_NUMBERS> -y` to implement
task(s) <TASK_NUMBERS> from the specification.

Context: Read `.kiro/specs/<FEATURE>/design.md` for architecture and
component interfaces. Read `.kiro/specs/<FEATURE>/tasks.md` for the
specific task descriptions.

<TASK_SPECIFIC_CONTEXT — include relevant file paths, patterns to follow,
and key design decisions from design.md that apply to these tasks>

Verify:
- The project's typecheck command passes with zero errors (check
  package.json scripts or project config for the correct command)
- The project's test command passes with no regressions
- Tasks are marked `[x]` in tasks.md
```

## Phase 3: Validation Cycle Tasks

### validate-impl Task

```
Run `/kiro:validate-impl <FEATURE>` to validate the FULL implementation
against the specification at `.kiro/specs/<FEATURE>/`.

CRITICAL: Read ALL of these files before validating:
- `.kiro/specs/<FEATURE>/requirements.md` — check every requirement
- `.kiro/specs/<FEATURE>/design.md` — verify architecture matches
- `.kiro/specs/<FEATURE>/tasks.md` — confirm every task is implemented

Validate each requirement INDIVIDUALLY against the actual codebase. Do
not limit validation to recently completed tasks or the Ralph Loop
objective. Every requirement in the spec must be traceable to working
implementation code.

Also verify:
- The project's typecheck command passes (check package.json scripts or
  project config for the correct command)
- The project's test command passes
- No regressions in existing functionality

If issues are found:
1. For each issue, call `update_fix_plan` to add a fix task with:
   - The specific requirement or design element that is not met
   - The file paths that need changes
   - What the expected behavior or implementation should be
2. Add a re-validation task (copy of this task) after the fix tasks
3. Report status as "in_progress" — do NOT report "complete"

Only report status "complete" with exit_signal if every requirement
passes validation with zero issues.
```

### Codex Validation Task (Final)

```
Use the Codex tool (`mcp__codex-tool__run_codex`) to perform independent
final validation of the implementation.

Codex prompt:
  Use the "$kiro--validate-impl" codex skill for the "<FEATURE>" feature.
  Run a comprehensive validation of the implementation to determine what
  gaps exist.

After Codex returns, read any reference documents it generated (check the
`referenceDocuments` array in the response).

If the Codex validation report identifies ANY gaps or missing
implementations:
1. For each gap, call `update_fix_plan` to add a fix task with the
   specific files, requirements, and changes needed
2. Add another Codex validation task after the fix tasks
3. Report status as "in_progress"

Only report status "complete" with exit_signal if the Codex report
confirms the implementation is fully complete with no gaps.
```

## Dynamic Fix Task Template

When a validation task adds fix tasks, use this structure:

```
Fix <REQUIREMENT_OR_ISSUE>: <brief description of what is wrong>.

Requirement <NUMBER> in `.kiro/specs/<FEATURE>/requirements.md` requires
<WHAT_IS_EXPECTED>. Currently, <WHAT_IS_ACTUALLY_HAPPENING>.

Files to modify:
- `<FILE_PATH>` — <what to change>
- `<FILE_PATH>` — <what to change>

Implementation guidance from design.md:
<relevant excerpt from design.md>

Verify:
- The project's typecheck command passes
- The project's test command passes
- The specific behavior described above works correctly
```

## Example: Complete Plan Structure

For a feature `session-branching` where the spec already exists:

```
Group 1: /kiro:spec-impl session-branching 1 -y     (Schema extensions)
Group 2: /kiro:spec-impl session-branching 2 -y     (Git operations)
Group 3: /kiro:spec-impl session-branching 3 -y     (Session lifecycle)
Group 4: /kiro:spec-impl session-branching 4 -y     (Merge workflow)
Group 5: /kiro:spec-impl session-branching 5 -y     (API routes and UI)
Group 6: /kiro:validate-impl session-branching       (Full validation)
Group 7: Codex validation via $kiro--validate-impl   (Independent check)
```

If Group 6 finds issues, the iteration dynamically adds:
```
Group 8: Fix task for issue A
Group 8: Fix task for issue B
Group 9: /kiro:validate-impl session-branching       (Re-validation)
Group 10: Codex re-validation                        (If Group 9 passed)
```
