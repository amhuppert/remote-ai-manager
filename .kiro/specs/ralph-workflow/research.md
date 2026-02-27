# Research & Design Decisions

## Summary
- **Feature**: ralph-workflow (initialization redesign)
- **Discovery Scope**: Extension
- **Key Findings**:
  - All required patterns (in-process MCP tools, fire-and-forget dispatch, state mutation, SSE broadcast) are well-established in the codebase — no new technology research needed
  - `ConnectedWorkflowPanel` is fully reusable for the dedicated page without modification; it accepts `projectName` and `sessionName` props and manages all state internally
  - `prompt.ts` currently uses zero `mcpServers` — the `initialize_ralph_loop` tool will be the first conditional MCP server registered on standard conversation prompts

## Research Log

### MCP Tool Registration in Standard Prompts
- **Context**: Need to understand how to conditionally register an MCP tool server on standard conversation prompts
- **Sources Consulted**: `src/lib/prompt.ts`, `src/lib/ralph-loop/orchestrator.ts`, `src/lib/ralph-loop/plan-generator.ts`
- **Findings**:
  - `prompt.ts` `executePromptStream()` builds a `Query` via `query()` with `options` object
  - The `options` parameter accepts `mcpServers: Record<string, McpSdkServerConfigWithInstance>`
  - `orchestrator.ts` uses `mcpServers: { "ralph-loop": toolServer }` — exact same pattern needed
  - `plan-generator.ts` uses `mcpServers: { "ralph-plan-generator": planToolServer }` — same pattern
  - The tool server is created via `createSdkMcpServer()` + `tool()` from `@anthropic-ai/claude-agent-sdk`
- **Implications**: Adding `mcpServers` to the `prompt.ts` query options is a straightforward extension — approximately 5 lines of conditional logic

### ConnectedWorkflowPanel Reusability
- **Context**: Need to verify the existing panel component works as a full-page view
- **Sources Consulted**: `ConnectedWorkflowPanel.tsx`, `WorkflowPanel.tsx`
- **Findings**:
  - `ConnectedWorkflowPanel` accepts only `{ projectName: string; sessionName: string }` — minimal interface
  - It self-manages all state via React Query hooks and local state
  - The component uses flex layout and will expand to fill its container
  - Currently renders inside a `display: flex; flex: 1; overflow: auto` container in `RightPane.tsx`
  - Handles null workflow state internally (shows activation UI)
- **Implications**: The component can be rendered directly in a page with appropriate layout wrapper. No modifications to the component itself are required. The "no workflow" empty state may need adjustment since the current one shows an "Activate" button (the old flow) which should be replaced with a message about starting from a conversation.

### Workflow Creation Logic Duplication
- **Context**: The `POST /workflow` route handler contains the workflow creation shape — determine whether to extract shared logic or duplicate
- **Sources Consulted**: `src/app/api/.../workflow/route.ts`, `src/lib/ralph-loop/circuit-breaker.ts`
- **Findings**:
  - Workflow creation is ~20 lines of property initialization
  - The route handler also does HTTP-specific validation (project/session lookup, 409 check)
  - The init tool needs the same creation shape but with different context (in-process closure vs HTTP request)
- **Implications**: Inline the creation logic in the tool handler rather than extracting a shared function. The duplication is small and the contexts are different enough that a shared function would need awkward parameterization.

## Design Decisions

### Decision: Inline Tool Handler vs Shared Workflow Creation Function
- **Context**: The `initialize_ralph_loop` tool handler needs the same workflow creation shape as `POST /workflow`
- **Alternatives Considered**:
  1. Extract a shared `createWorkflow()` function used by both the API route and the tool handler
  2. Inline the creation logic in the tool handler (accepting small duplication)
- **Selected Approach**: Inline duplication in tool handler
- **Rationale**: The API route includes HTTP concerns (request parsing, response formatting, project/session resolution) that don't apply to the in-process tool. Extracting shared logic would require awkward parameterization. The creation shape is ~20 lines of simple property assignment.
- **Trade-offs**: Small duplication vs. cleaner separation of HTTP and in-process concerns
- **Follow-up**: If a third creation path emerges, extract at that point

### Decision: Workflow Card Data Source
- **Context**: The session overview workflow card needs real-time status data
- **Alternatives Considered**:
  1. Use `useSessionQuery` (already fetched in ConversationList) — derives workflow from session data
  2. Use `useWorkflowBySession()` from `workflow.store.ts` — SSE-driven, truly real-time
  3. Combine both: session query for initial data, workflow store for live updates
- **Selected Approach**: Option 3 (combine both)
- **Rationale**: Session query provides the authoritative initial state (including objective, task plan). The workflow store provides instant SSE-driven updates for status changes during running workflows. Merging both gives the best UX — instant page load from the session query, real-time updates from SSE.
- **Trade-offs**: Slightly more complex data merging vs. single source of truth

### Decision: WorkflowPanel "No Workflow" Empty State
- **Context**: The existing `WorkflowPanel` shows an "Activate Workflow" button when `workflow === null`, which is the old initialization flow
- **Alternatives Considered**:
  1. Modify `WorkflowPanel` to accept a `showActivateButton` prop and conditionally show it
  2. Handle the no-workflow state in the page wrapper, only rendering `ConnectedWorkflowPanel` when workflow exists
- **Selected Approach**: Option 2 — page wrapper handles empty state
- **Rationale**: Keeps the existing `WorkflowPanel` component unchanged. The page wrapper shows a simple empty state message when no workflow exists, and renders `ConnectedWorkflowPanel` when one does.
- **Trade-offs**: Page-level empty state is simpler but adds a conditional branch in the page component

## Risks & Mitigations
- **Race condition on tool invocation**: Two concurrent conversations could both call `initialize_ralph_loop` before either persists — mitigated by `mutateSession()` serialized writes and the tool handler checking session state before creating
- **CSS layout shift for workflow card**: The workflow card appearing/disappearing could cause layout shift on the session overview — mitigated by reserving space or using smooth transitions
- **ConnectedWorkflowPanel "Activate" button**: The existing component shows an activate button in the null workflow state which is part of the old flow — mitigated by handling empty state at the page level, not rendering the panel when no workflow exists

## References
- `@anthropic-ai/claude-agent-sdk` `createSdkMcpServer` / `tool()` — in-process MCP tool creation
- Existing patterns: `src/lib/ralph-loop/mcp-tools.ts`, `plan-generator.ts`, `orchestrator.ts`
- Gap analysis: `.kiro/specs/ralph-workflow/gap-analysis.md`
