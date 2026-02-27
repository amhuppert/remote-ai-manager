# Gap Analysis: Ralph Loop Initialization Redesign

## Requirement-to-Asset Map

### Requirement 1: Conversation-Based Workflow Initialization via Custom Tool

| Need | Existing Asset | Gap |
|------|---------------|-----|
| In-process MCP tool for `initialize_ralph_loop` | `src/lib/ralph-loop/mcp-tools.ts` — pattern for creating in-process MCP servers with `createSdkMcpServer` + `tool()` | **New file needed** — `init-tool.ts` following same pattern |
| Register MCP server on conversation prompts | `src/lib/prompt.ts` — `executePromptStream()` builds SDK `query()` with options; currently no `mcpServers` option | **Extend** — add `mcpServers` option when `session.workflow` is null |
| Tool creates workflow in "planning" status | `POST /workflow` route (`src/app/api/.../workflow/route.ts`) — contains exact workflow creation shape | **Reuse logic** — extract shared creation function or duplicate inline |
| Tool dispatches plan generation | `src/lib/ralph-loop/plan-generator.ts` — `dispatchPlanGeneration()` already fire-and-forget | **Reuse directly** — call with objective from tool parameter |
| Guard against duplicate creation | `POST /workflow` route checks `session.workflow` exists → 409 | **Reuse pattern** — tool handler checks session.workflow before creating |
| Broadcast SSE event on creation | `src/lib/sse-broadcaster.ts` — `broadcast()` function with typed events; `workflow-status` event type exists | **Reuse directly** |

**Missing capabilities:**
- No existing mechanism to conditionally register MCP servers on standard conversation prompts (prompt.ts currently has zero `mcpServers`)
- Need to pass `session` reference into tool closure so handler can check/mutate workflow state

### Requirement 2: Dedicated Workflow Page

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Route at `/projects/[name]/[session]/workflow` | `src/app/projects/[name]/[session]/conflicts/page.tsx` — existing sub-page pattern | **New page** — follows same pattern |
| Full workflow management UI | `src/app/projects/[name]/[session]/workflow/ConnectedWorkflowPanel.tsx` + `WorkflowPanel.tsx` — complete UI already exists | **Reuse directly** — render as page content instead of sidebar panel |
| React Query hooks for workflow data | `src/lib/queries.ts` — `useWorkflowQuery()`, `src/lib/mutations.ts` — all workflow mutations | **No gap** — already exist |
| Empty state when no workflow | N/A | **New UI** — simple empty state message |

**Constraint:** `ConnectedWorkflowPanel` is currently sized for a sidebar panel. May need layout adjustments (max-width, padding) for full-page rendering. The component itself should work without changes since it uses flex layout.

### Requirement 3: Session Overview Workflow Card

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Workflow status card with equal prominence | `src/app/projects/[name]/[session]/ConversationList.tsx` — renders conversation cards in `.convo-card-grid` | **New component** — workflow card above or alongside conversation grid |
| Status, objective, task progress display | `src/stores/workflow.store.ts` — `TrackedWorkflow` has `status`, `taskProgress`, `haltReason` | **Reuse store** — or derive from `useSessionQuery` which already returns `session.workflow` |
| Navigate to dedicated page | Next.js `Link` component — used throughout | **No gap** |
| Real-time SSE updates | `workflow.store.ts` handles SSE events; `useWorkflowBySession()` hook exists | **Reuse directly** |
| Remove "Ralph Loop" button | Button at `ConversationList.tsx:311-321` | **Remove** — straightforward deletion |
| Remove `useStartWorkflowMutation` import | `ConversationList.tsx:17` | **Remove** — cleanup |

**Missing capabilities:**
- No existing "workflow card" component — needs new UI design with CSS
- Session overview CSS (`.convo-list-layout`) doesn't have a section for non-conversation content with equal prominence

### Requirement 4: Remove Workflow Tab from Right Panel

| Need | Existing Asset | Gap |
|------|---------------|-----|
| Remove Workflow tab button | `RightPane.tsx:61-69` — conditional workflow tab button | **Remove** — delete JSX block |
| Remove ConnectedWorkflowPanel from panel body | `RightPane.tsx:107-122` — conditional workflow panel rendering | **Remove** — delete JSX block |
| Remove `hasWorkflow` prop | `RightPane.tsx:20` (prop def), `SessionDetailPage.tsx:1417` (prop passing) | **Remove** — delete prop from interface, remove from parent |
| Remove `"workflow"` from RightPaneTab type | `session-detail.store.ts:15` — `type RightPaneTab = "diff" \| "focus" \| "workflow" \| "specs"` | **Remove** — update type union |
| Remove ConnectedWorkflowPanel import | `RightPane.tsx:7` | **Remove** — delete import |

**No missing capabilities** — purely subtractive changes.

## Implementation Approach Options

### Option A: Extend Existing Components (Not Recommended)

Would embed the MCP tool creation directly in `prompt.ts` and the workflow card inline in `ConversationList.tsx`.

**Trade-offs:**
- ✅ Fewer files
- ❌ `prompt.ts` is already 615 lines — adding MCP tool creation bloats it
- ❌ `ConversationList.tsx` at 467 lines would grow with workflow card UI
- ❌ Violates the project's pattern of domain-specific modules in `src/lib/ralph-loop/`

### Option B: Create New Components (Not Recommended)

Would create new files for everything including a new page component that doesn't reuse `ConnectedWorkflowPanel`.

**Trade-offs:**
- ✅ Maximum separation
- ❌ Duplicates existing workflow panel UI
- ❌ More files than necessary

### Option C: Hybrid Approach (Recommended)

Create new files where responsibility is distinct, reuse existing components where they already serve the purpose.

**New files:**
1. `src/lib/ralph-loop/init-tool.ts` — MCP tool factory (distinct domain responsibility, follows `mcp-tools.ts` pattern)
2. `src/app/projects/[name]/[session]/workflow/page.tsx` — dedicated page (new route, minimal: wraps `ConnectedWorkflowPanel`)
3. `src/app/projects/[name]/[session]/WorkflowCard.tsx` — session overview card (colocated with ConversationList per project structure conventions)

**Extended files:**
4. `src/lib/prompt.ts` — add ~10 lines to conditionally register MCP server from init-tool.ts
5. `src/app/projects/[name]/[session]/ConversationList.tsx` — remove Ralph Loop button, add WorkflowCard rendering

**Removed from files:**
6. `src/app/projects/[name]/[session]/RightPane.tsx` — remove workflow tab + panel + hasWorkflow prop
7. `src/app/projects/[name]/[session]/SessionDetailPage.tsx` — remove hasWorkflow prop threading
8. `src/stores/session-detail.store.ts` — remove `"workflow"` from RightPaneTab type

**Trade-offs:**
- ✅ New MCP tool module follows existing `ralph-loop/` pattern
- ✅ Reuses ConnectedWorkflowPanel as-is for the dedicated page
- ✅ Colocated WorkflowCard component follows project structure conventions
- ✅ Minimal changes to prompt.ts (conditional registration only)
- ✅ Clean subtractive changes for right panel removal
- ❌ Slightly more planning than pure extension

## Effort and Risk

**Effort: S–M (2–4 days)**
- Backend (init-tool + prompt.ts wiring): ~0.5 day — follows established MCP tool pattern exactly
- Dedicated page: ~0.5 day — thin wrapper around existing ConnectedWorkflowPanel
- Workflow card UI: ~1 day — new component + CSS styling for equal prominence
- Right panel removal: ~0.5 day — purely subtractive, low risk
- Testing + integration: ~0.5–1 day

**Risk: Low**
- All backend patterns are established (MCP tools, fire-and-forget dispatch, state mutation)
- Existing `ConnectedWorkflowPanel` reused as-is for the dedicated page
- Right panel changes are purely subtractive
- No architectural shifts or unfamiliar technology
- Main risk: CSS/layout work to make workflow card feel "equally prominent" to conversations — design question, not technical risk

## Recommendations for Design Phase

### Preferred Approach
**Option C (Hybrid)** — new `init-tool.ts` + page + card component, with minimal extension of `prompt.ts` and subtractive changes elsewhere.

### Key Design Decisions Needed
1. **Workflow card visual design** — How to achieve "equal prominence" with conversations. Options: side-by-side layout, card above conversation grid, or tabbed sections (Conversations | Workflow)
2. **ConnectedWorkflowPanel layout adaptation** — May need a wrapper or CSS adjustments for full-page rendering vs. sidebar
3. **Tool response message** — What exactly to tell Claude after the tool succeeds (guidance for the user about the workflow page)

### Research Items
- None identified — all technologies and patterns are well-established in the codebase
