# Research & Design Decisions

## Summary
- **Feature**: `roadmap-item-tracker`
- **Discovery Scope**: Extension (CRUD on established patterns)
- **Key Findings**:
  - All CRUD patterns have direct analogs in the existing codebase (sessions, conversations)
  - Archiving follows the `archived: boolean` field pattern (not a separate array like projects)
  - Focus mode transition reuses `createSessionFocus()` directly with no new infrastructure

## Research Log

### State Storage Pattern for Roadmap Items
- **Context**: Where to store roadmap items — ManagerState level, ProjectState level, or SessionState level
- **Sources Consulted**: `src/lib/schemas.ts` (lines 355-382), `src/lib/state.ts` (lines 112-158)
- **Findings**:
  - Items are inherently project-scoped (bugs/features/ideas belong to a codebase)
  - Focus mode transition requires a project context (sessions belong to projects)
  - ProjectState currently only has `rootPath` and `sessions`
  - Adding a `roadmapItems` array to ProjectState follows the same nesting as `conversations` in SessionState
- **Implications**: Extend `projectStateSchema` with `roadmapItems: z.array(roadmapItemSchema).default([])`

### Archiving Pattern Selection
- **Context**: Projects use an array (`archivedProjects`), while conversations/sessions use an inline `archived: boolean` field
- **Sources Consulted**: `src/lib/state.ts` (lines 289-337), `src/lib/conversations.ts` (lines 101-125)
- **Findings**:
  - The array pattern is used only because projects are keyed by path in `ManagerState.projects` record
  - Roadmap items are stored in an array (like conversations), so inline `archived: boolean` is the natural fit
  - UI filtering uses `useMemo` with `showArchived` Zustand toggle — same pattern applies
- **Implications**: Use inline `archived: boolean` field, matching conversation pattern

### Focus Mode Objective Composition
- **Context**: How to compose the Focus session objective from a roadmap item
- **Sources Consulted**: `src/lib/sessions.ts` (lines 317-337), `src/lib/prompt-templates.ts`
- **Findings**:
  - `createSessionFocus(projectPath, objective)` takes a single string objective
  - The objective is used to generate a session name and written to `memory-bank/focus.md`
  - Title alone may be too terse; combining title + description provides better context
- **Implications**: Compose as `title + "\n\n" + description` (when description exists), otherwise title alone

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Extend existing files + new routes | Add schema/state/query/mutation code to existing shared files; create new API routes and UI component | Follows all established patterns; minimal learning curve | Increases size of shared files | **Selected** — gap analysis recommended this |
| Separate roadmap module | New `src/lib/roadmap.ts` for all logic | Clean isolation | Adds a new module pattern not used elsewhere | Rejected — overengineered for CRUD |

## Design Decisions

### Decision: Per-Project Storage
- **Context**: Roadmap items need a storage location in state.json
- **Alternatives Considered**:
  1. Global (ManagerState level) — single roadmap across all projects
  2. Per-project (ProjectState level) — items scoped to a project
- **Selected Approach**: Per-project in `ProjectState.roadmapItems`
- **Rationale**: Items (bugs, features, ideas) are inherently project-specific. Focus mode transition requires a project context.
- **Trade-offs**: No cross-project view, but matches the hierarchical state model
- **Follow-up**: None — straightforward extension

### Decision: Combined PATCH Endpoint
- **Context**: Items need status updates and archive toggling
- **Alternatives Considered**:
  1. Separate endpoints: `/archive` and `/status` routes
  2. Single PATCH with optional fields
- **Selected Approach**: Single PATCH endpoint accepting `{ status?, archived? }`
- **Rationale**: Reduces route count. Both are simple field updates on the same entity. Follows REST convention of partial updates via PATCH.
- **Trade-offs**: Slightly more complex validation (at least one field required)
- **Follow-up**: None

### Decision: Focus Transition as Dedicated Endpoint
- **Context**: Starting a Focus session from a roadmap item involves creating a session and marking the item done
- **Alternatives Considered**:
  1. Client-side orchestration (two separate API calls)
  2. Server-side endpoint that does both atomically
- **Selected Approach**: Dedicated `POST /api/projects/[name]/roadmap-items/[id]/focus` endpoint
- **Rationale**: Atomicity — item status and session creation happen in one request. Prevents partial state (session created but item not marked done). Simpler client code.
- **Trade-offs**: One more route, but cleaner separation of concerns
- **Follow-up**: None

## Risks & Mitigations
- **State file growth** — Each item adds ~200 bytes to state.json. Even 100 items per project is negligible. No mitigation needed.
- **No ordering guarantee** — Array order in state.json is insertion order. Sufficient for MVP; explicit sort order can be added later if needed.
