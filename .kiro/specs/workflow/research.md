# Research & Design Decisions

## Summary
- **Feature**: Ralph Loop Plan-First Initialization
- **Discovery Scope**: Extension
- **Key Findings**:
  - The init tool (`init-tool.ts`) and plan generator (`plan-generator.ts`) are cleanly separated — modifying the init tool schema and removing the `dispatchPlanGeneration()` call is straightforward
  - The `createTask()` function in `fix-plan-manager.ts` already handles UUID/timestamp generation for raw `{description, group}` input — it is the correct place to convert agent-submitted tasks into `FixPlanTask` objects
  - The XState machine's `planning` state supports both `GENERATE_PLAN` and `CONFIRM_PLAN` events — the machine does not need changes since the init tool operates before the XState actor is created

## Research Log

### Init Tool → Plan Generator Coupling
- **Context**: Understanding how tightly the init tool depends on plan generation
- **Findings**:
  - `init-tool.ts` imports `dispatchPlanGeneration` from `plan-generator.ts` — this is the only coupling point
  - `dispatchPlanGeneration` is fire-and-forget (void return, caught errors) — removing the call has no downstream effect on the init tool's return value
  - The `generatingPlan: true` flag is set in init-tool.ts line 107 and cleared by the plan generator on completion/failure
  - When tasks are pre-submitted, `generatingPlan` should be `false` from the start
- **Implications**: Removing the `dispatchPlanGeneration()` call and setting `generatingPlan: false` is the only change needed to satisfy Requirement 2

### FixPlanTask Construction Path
- **Context**: Ensuring agent-submitted tasks produce valid `FixPlanTask` objects
- **Findings**:
  - `createTask({description, group})` in `fix-plan-manager.ts` is the canonical factory — generates UUID, sets `status: "pending"`, `createdAt`, and null fields
  - The plan generator already uses `createTask()` to convert raw `{description, group}` tuples (plan-generator.ts lines 186-188 and 317-321)
  - The init tool should use the same function to maintain consistency
- **Implications**: The init tool can reuse `createTask()` directly — no new data transformation logic needed

### SSE Broadcast Pattern
- **Context**: Understanding what events to broadcast when tasks are pre-populated at init time
- **Findings**:
  - Current init tool broadcasts `workflow-status` event (lines 126-143) with `taskProgress: {total: 0, ...}`
  - The plan generator separately broadcasts `workflow-fix-plan-updated` when tasks are generated (lines 342-353)
  - With pre-submitted tasks, both events should fire during init: `workflow-status` with accurate counts, and `workflow-fix-plan-updated` with the full plan
- **Implications**: The init tool needs to broadcast one additional SSE event (`workflow-fix-plan-updated`) and update the `taskProgress` counts in the existing `workflow-status` event

### XState Machine Independence
- **Context**: Verifying the XState machine does not need changes
- **Findings**:
  - The XState actor is created only at confirmation time via `startWorkflow()` (workflow-route-handlers.ts line 323)
  - The init tool runs before any XState actor exists — it writes directly to `state.json`
  - The machine reads `fixPlan` from its input at creation time (types.ts line 74)
  - The `generatingPlan` flag in the machine context (types.ts line 45) is set from state but only used for UI display
- **Implications**: No XState machine changes required. The pre-populated `fixPlan` in `state.json` is picked up naturally when the user confirms and `startWorkflow()` is called

### API Route Backward Compatibility
- **Context**: Ensuring POST /workflow API route remains functional
- **Findings**:
  - `workflowPOST` in `workflow-route-handlers.ts` (lines 152-210) creates workflows with `fixPlan: []` and optional `objective`
  - This route does NOT call `dispatchPlanGeneration()` — it was always a manual creation path
  - Users add tasks via `PUT /workflow/fix-plan` or trigger generation via `POST /workflow/generate-plan`
  - The confirm endpoint (lines 303-308) already validates `fixPlan.length > 0`
- **Implications**: No changes needed to API routes — they are a separate creation path from the MCP init tool

## Design Decisions

### Decision: Reuse createTask() for Task Construction
- **Context**: Agent submits `{description, group}` pairs — need to produce full `FixPlanTask` objects
- **Alternatives Considered**:
  1. Inline UUID generation and field assignment in init-tool.ts
  2. Reuse `createTask()` from `fix-plan-manager.ts`
- **Selected Approach**: Reuse `createTask()`
- **Rationale**: Single source of truth for task construction; already validated in existing tests; consistent with plan-generator.ts usage
- **Trade-offs**: Adds import dependency from init-tool.ts to fix-plan-manager.ts (acceptable — same domain)

### Decision: Source "tool" for SSE Event
- **Context**: The `workflow-fix-plan-updated` event has a `source` field with values `"tool"` or `"user"`
- **Selected Approach**: Use `source: "tool"` when the init tool broadcasts the plan
- **Rationale**: The plan was generated by a tool (the conversation agent called the MCP tool), consistent with how the plan generator uses `source: "tool"`

## Risks & Mitigations
- **Agent plan quality**: The conversation agent might not break tasks down as well as a dedicated planner with unlimited SDK turns. Mitigation: users can still regenerate plans via the UI (Requirement 3). The tool description includes explicit guidance on task granularity and grouping.
- **Large tool payloads**: An agent could submit many tasks. Mitigation: Zod validation with `z.array()` handles this; no explicit cap needed since the UI already handles variable-length plans.

## References
- `src/lib/ralph-loop/init-tool.ts` — Current init tool implementation
- `src/lib/ralph-loop/plan-generator.ts` — Plan generation logic (preserved for regeneration)
- `src/lib/ralph-loop/fix-plan-manager.ts` — `createTask()` factory function
- `src/lib/ralph-loop/workflow-route-handlers.ts` — API route handlers
- `src/lib/schemas.ts` — SSE event schemas, FixPlanTask schema
