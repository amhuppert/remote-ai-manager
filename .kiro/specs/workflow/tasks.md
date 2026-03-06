# Implementation Plan

- [x] 1. Expand init tool schema and handler to accept structured tasks
- [x] 1.1 Update the tool's Zod schema to accept both `objective` and `tasks` parameters, where each task has a `description` (non-empty string) and `group` (positive integer), and the array requires at least one element
  - Add the `tasks` parameter to the existing `tool()` call with `.describe()` annotations that guide the conversation agent on task granularity (single-iteration scope, ~10-30 minutes) and group semantics (group 1 = no dependencies, group 2+ = depends on previous groups)
  - Update the `objective` parameter description to instruct the agent to provide a concise summary of the development goal
  - _Requirements: 1.1, 1.4, 1.5, 4.1, 4.2, 4.3_

- [x] 1.2 Update the tool description text to instruct the agent on how to break work into discrete, actionable tasks grouped by dependencies
  - Replace the current single-line description with guidance on analyzing the user's request, task independence within groups, and excluding meta-tasks like "review" or "test everything"
  - _Requirements: 4.1, 4.2, 4.3_

- [x] 1.3 Update the handler to convert submitted tasks into full fix plan entries and create the workflow with a pre-populated plan
  - Import and use the existing task factory function from the fix plan manager module to convert each `{description, group}` tuple into a complete task record with UUID, pending status, timestamp, and null metadata fields
  - Set the workflow's `generatingPlan` flag to `false` since no background generation is needed
  - Remove the `dispatchPlanGeneration()` import and the fire-and-forget call that previously triggered background plan generation
  - Remove the second `getSession()` call that was only needed to pass fresh state to the plan generator
  - _Requirements: 1.2, 1.3, 2.1, 2.2, 2.3, 7.1, 7.2, 7.3_

- [x] 1.4 (P) Update SSE broadcasts to reflect the pre-populated task plan
  - Update the `workflow-status` broadcast to compute `taskProgress` from the generated fix plan entries (total, pending counts) instead of hardcoding zeros
  - Add a second broadcast call for the `workflow-fix-plan-updated` event containing the full fix plan array with `source: "tool"`
  - _Requirements: 5.1, 5.2_

- [x] 2. Update existing tests and add new test coverage for plan-first initialization
- [x] 2.1 Update existing test cases that assert on the old behavior
  - Update the test that verifies `dispatchPlanGeneration` is called — it should now verify it is NOT called when tasks are provided
  - Update the test that checks `generatingPlan: true` — it should now assert `generatingPlan: false`
  - Update the test that checks `fixPlan: []` — it should now assert the plan is populated from submitted tasks
  - Update the `workflow-status` broadcast assertion to verify accurate task progress counts instead of all zeros
  - _Requirements: 1.2, 1.3, 2.1, 2.2_

- [x] 2.2 (P) Add new test cases for task validation and SSE events
  - Test that calling the handler with a valid objective and tasks array creates a workflow with correctly constructed fix plan entries (UUIDs, pending status, timestamps, null metadata)
  - Test that an empty tasks array is rejected (Zod validation error or handler-level error)
  - Test that the `workflow-fix-plan-updated` SSE event is broadcast with the full plan and `source: "tool"`
  - Test that tasks with invalid group values (zero, negative, non-integer) are rejected
  - _Requirements: 1.4, 1.5, 5.2, 7.1, 7.2, 7.3_

- [x] 3. Verify backward compatibility of API-created workflows and plan regeneration
  - Confirm that the `POST /workflow` API route still creates workflows with an empty fix plan and optional objective (no code changes needed — this is a verification task)
  - Confirm that the `POST /workflow/generate-plan` endpoint still triggers plan regeneration independently of the init tool changes
  - Confirm that the `POST /workflow/confirm` endpoint still rejects confirmation when the fix plan is empty
  - _Requirements: 3.1, 3.2, 3.3, 6.1, 6.2, 6.3_
