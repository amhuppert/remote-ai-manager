# Gap Analysis — Custom Roadmap Item Tools for Claude Conversations

## Analysis Summary

- **Scope**: Extend the existing roadmap item tracker to provide all Claude conversations in Command Center with MCP tools for adding and removing roadmap items scoped to the session's project
- **Key finding**: The codebase already has a **well-established pattern** for creating custom MCP tools via `createSdkMcpServer()` and injecting them into Claude SDK `query()` calls — three working examples exist in the Ralph Loop subsystem
- **Existing assets**: Roadmap CRUD functions (`createRoadmapItem`, `deleteRoadmapItem`) already exist in `state.ts`; schemas and types are defined; the prompt executor (`prompt.ts`) already accepts `mcpServers` in its options
- **Effort**: S (1–3 days) — follows established patterns with minimal new infrastructure
- **Risk**: Low — extend familiar patterns, no architectural changes, clear scope

---

## 1. Current State Investigation

### Existing Roadmap Item Implementation (Complete)

| Asset | Location | Relevance |
|-------|----------|-----------|
| Zod schemas | `src/lib/schemas.ts:363-379` | `roadmapItemSchema`, type/status enums, request schemas |
| State mutations | `src/lib/state.ts:466-555` | `createRoadmapItem()`, `deleteRoadmapItem()`, `updateRoadmapItem()`, `getRoadmapItems()` |
| API routes | `src/app/api/projects/[name]/roadmap-items/` | Full REST endpoints (GET/POST/PATCH/DELETE + focus) |
| UI panel | `src/app/projects/[name]/RoadmapItemsPanel.tsx` | List, add form, status toggle, archive, focus transition |
| Query/mutation hooks | `src/lib/queries.ts`, `src/lib/mutations.ts` | TanStack React Query integration |
| Types | `src/types/index.ts` | Re-exported `RoadmapItem`, `RoadmapItemType`, `RoadmapItemStatus` |

### Custom MCP Tool Pattern (Established)

The codebase has **three working custom MCP tool servers** that serve as direct templates:

| Server | Location | Tools Provided |
|--------|----------|---------------|
| `ralph-loop-init` | `src/lib/ralph-loop/init-tool.ts:28-184` | `initialize_ralph_loop` |
| `ralph-loop` | `src/lib/ralph-loop/mcp-tools.ts:24-170` | `report_status`, `update_fix_plan` |
| `ralph-plan-generator` | `src/lib/ralph-loop/plan-generator.ts:98-136` | `submit_plan` |

**Established pattern**:
```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

export function createToolServer(context): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "server-name",
    version: "1.0.0",
    tools: [
      tool("tool_name", "description", { /* Zod params */ }, async (args) => {
        // Handler using context closure
        return { content: [{ type: "text" as const, text: "result" }] };
      }),
    ],
  });
}
```

### Prompt Executor MCP Integration

**`src/lib/prompt.ts:299-419`** — The `executePrompt()` function already:
- Accepts `mcpServers` in the `query()` options object
- Conditionally injects tool servers (e.g., `ralph-loop-init` only when no workflow exists)
- Has access to `projectPath`, `sessionName`, and `session` context needed to scope tools

**MCP server injection point** (`prompt.ts:~329`):
```typescript
mcpServers: { "ralph-loop-init": initToolServer },
```

### SSE Broadcasting

`src/lib/sse-broadcaster.ts` — Broadcasts typed events to connected UI clients. Existing event types cover conversation status, jobs, notifications, workflows. Adding roadmap events would follow the same pattern if real-time UI updates are needed (though React Query polling at 30s already handles this).

---

## 2. Requirements Feasibility — Requirement-to-Asset Map

| Capability Needed | Existing Asset | Gap |
|-------------------|----------------|-----|
| Add roadmap item from Claude conversation | `createRoadmapItem()` in `state.ts` | **Missing**: MCP tool definition wrapping the function |
| Remove roadmap item from Claude conversation | `deleteRoadmapItem()` in `state.ts` | **Missing**: MCP tool definition wrapping the function |
| List roadmap items from Claude conversation | `getRoadmapItems()` in `state.ts` | **Missing**: MCP tool (optional — useful for Claude to see existing items) |
| MCP tool server creation | `createSdkMcpServer()` + `tool()` from SDK | Exists — well-established pattern |
| Inject tools into SDK query | `mcpServers` option in `prompt.ts` | Exists — needs roadmap server added |
| Scope tools to session's project | `projectPath` available in `executePrompt()` | Exists — context already available |
| Input validation | Zod schemas for roadmap items | Exists — reuse `roadmapItemTypeSchema` |
| Real-time UI update after tool use | SSE broadcaster + React Query polling | Exists — polling sufficient; SSE optional |

### Missing Capabilities

1. **MCP tool server file** — New file defining roadmap item tools (`add_roadmap_item`, `remove_roadmap_item`, optionally `list_roadmap_items`)
2. **Tool registration in prompt executor** — Wire the new server into the `mcpServers` object in `executePrompt()`
3. **SSE event for roadmap changes** (optional) — Broadcast when Claude modifies items so UI updates instantly rather than waiting for next poll

### Constraints

- Tools must scope all operations to the session's `projectPath` — Claude should not access other projects' roadmap items
- Tools run within the Claude SDK async generator — they must be non-blocking and handle errors gracefully
- The `mutateState()` mutex ensures atomic writes, so concurrent tool calls from Claude are safe

### Complexity Signals

- **Simple CRUD**: Tools are thin wrappers around existing state mutation functions
- **No external integrations**: Everything is local state file operations
- **No new patterns**: Follows the established `createSdkMcpServer()` + `tool()` pattern exactly

---

## 3. Implementation Approach Options

### Option A: Extend Existing Files (Minimal)

**Files to modify**:
- `src/lib/prompt.ts` — Import and register roadmap tool server
- New: `src/lib/roadmap-tools.ts` — Define MCP tool server (single new file)

**Approach**: Create one new file with the tool server definition, import and inject it in `prompt.ts`.

**Trade-offs**:
- Minimal change footprint (1 new file, 1 modified file)
- Follows the Ralph Loop pattern directly
- Tools always available to every conversation (simplest approach)
- No SSE events — relies on existing React Query 30s polling for UI refresh

### Option B: Feature-Scoped Module with SSE

**Files to create/modify**:
- New: `src/lib/roadmap-tools.ts` — MCP tool server
- `src/lib/prompt.ts` — Register tool server
- `src/lib/sse-broadcaster.ts` — Add roadmap event types
- `src/lib/schemas.ts` — Add SSE event schemas for roadmap changes

**Approach**: Same as Option A plus SSE broadcasting so the UI updates immediately when Claude adds/removes items.

**Trade-offs**:
- Instant UI feedback when Claude modifies roadmap
- More files touched (schemas, SSE broadcaster)
- SSE events require new Zod schemas and client-side event handling
- May be over-engineering given 30s polling already exists

### Option C: Conditional Registration (Opt-in)

**Approach**: Only inject roadmap tools when a configuration flag is enabled or when the project has roadmap items.

**Trade-offs**:
- More control over which conversations get tools
- Adds complexity for minimal benefit
- The tools are lightweight; always-on is simpler

---

## 4. Effort and Risk Assessment

**Effort: S (1–3 days)**
- Single new file following an established pattern
- One modification to `prompt.ts` to register the server
- Existing CRUD functions handle all business logic
- No new infrastructure, no migrations, no external dependencies

**Risk: Low**
- All patterns are established with working examples
- State mutations are mutex-protected (no race condition risk)
- Tools are read/write to local JSON state file (no external calls)
- Claude SDK MCP integration is proven in three existing tool servers

---

## 5. Recommendations for Design Phase

### Preferred Approach

**Option A (Minimal)** — Create a single `src/lib/roadmap-tools.ts` file and register it in `prompt.ts`. This is the lowest-risk path that follows proven patterns exactly.

### Key Design Decisions

1. **Tool surface**: Should the tool server provide just `add`/`remove`, or also `list` and `update_status`? A `list` tool would let Claude see existing items before adding duplicates.
2. **Always-on vs conditional**: Should tools be available in every conversation, or only when enabled? (Recommendation: always-on — tools are lightweight and useful context)
3. **SSE broadcasting**: Should the tool trigger SSE events for instant UI updates? (Recommendation: defer — 30s polling is adequate; can add later if latency matters)
4. **Tool naming**: Follow SDK conventions — descriptive names like `add_roadmap_item`, `remove_roadmap_item`, `list_roadmap_items`

### Research Items

- **None identified** — all required APIs and patterns exist in the codebase with working examples
