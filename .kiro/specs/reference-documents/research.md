# Research & Design Decisions

## Summary
- **Feature**: reference-documents
- **Discovery Scope**: Extension
- **Key Findings**:
  - MCP tool server pattern in `roadmap-tools.ts` is directly replicable — Context/Deps/defaultDeps/createSdkMcpServer
  - `mutateSession()` provides session-level atomic mutations; reference documents are session-scoped arrays like `conversations`
  - Focus tab is conditionally shown only for `focus` creation mode; Docs tab replaces it unconditionally for all sessions

## Research Log

### MCP Tool Server Pattern
- **Context**: Need to understand the DI pattern for MCP tool servers
- **Sources Consulted**: `src/lib/roadmap-tools.ts`, `src/lib/actor-implementations.ts`
- **Findings**:
  - `RoadmapToolContext` carries `projectPath`; reference documents need `projectPath`, `sessionName`, `worktreePath`
  - `RoadmapToolDeps` uses method syntax for DI (bivariant parameter checking)
  - `defaultDeps` maps to real state functions
  - `createSdkMcpServer()` returns `McpSdkServerConfigWithInstance`
  - Tool handlers use `z` schemas for input validation and return `{ content: [{ type: "text", text }] }`
- **Implications**: Reference document tools follow the same pattern but with session-scoped context

### State Mutation Pattern
- **Context**: How to store/retrieve reference documents in session state
- **Sources Consulted**: `src/lib/state-store/`, `src/lib/reference-documents/schemas.ts`
- **Findings**:
  - `mutateSession()` takes `projectPath`, `sessionName`, `label`, and a mutation callback
  - Roadmap items use `mutateState()` (project-level); reference documents use `mutateSession()` (session-level)
  - `readState()` + property access for reads; `mutateSession()` for writes
  - Schema defaults ensure backward compat: `z.array(...).default([])`
- **Implications**: Add `referenceDocuments` field with `.default([])` to `sessionStateSchema`

### Focus Tab Architecture
- **Context**: Understanding what needs to be replaced
- **Sources Consulted**: `RightPane.tsx`, `SessionDetailPage.tsx`, `session-detail.store.ts`, `queries.ts`, `query-keys.ts`
- **Findings**:
  - Focus tab is conditionally rendered only when `creationMode === "focus"`
  - Docs tab should be unconditional (visible for all sessions)
  - `RightPaneTab` type: `"diff" | "focus" | "specs"` → `"diff" | "docs" | "specs"`
  - `MobilePanel` type: `"chat" | "diff" | "focus" | "specs" | "info"` → `"chat" | "diff" | "docs" | "specs" | "info"`
  - `sessionKeys.focusDoc()` → replace with `referenceDocumentKeys`
  - `useFocusDocQuery` → replace with `useReferenceDocumentsQuery` + `useReferenceDocumentContentQuery`
  - `focus-doc/route.ts` → replace with `reference-documents/route.ts` + `reference-documents/[id]/content/route.ts`
- **Implications**: Clean replacement — no gradual migration needed

### System Prompt Integration
- **Context**: How to inject reference document list into system prompt
- **Sources Consulted**: `actor-implementations.ts` lines 729-740
- **Findings**:
  - `systemPromptParts` is an array of string|null, filtered and joined with `\n\n`
  - Needs `getSessionState()` call (already available via `deps.getSessionState`) to read reference documents
  - Auto-registration of focus.md happens before building system prompt parts
- **Implications**: Add reference documents section builder + focus.md auto-registration before prompt

## Design Decisions

### Decision: Session-level storage for reference documents
- **Context**: Where to store document metadata
- **Alternatives Considered**:
  1. Project-level (like roadmapItems) — simpler but wrong scope
  2. Session-level (in SessionState) — matches worktree isolation
- **Selected Approach**: Session-level array in `SessionState`
- **Rationale**: Each session has its own worktree; documents are written into session directories
- **Trade-offs**: Cannot share documents across sessions (acceptable — each has own files)

### Decision: Idempotent registration by filePath
- **Context**: How to handle re-registration of the same file
- **Alternatives Considered**:
  1. Error on duplicate — strict but unfriendly
  2. Update description on duplicate — idempotent and safe
- **Selected Approach**: Find by filePath, update description if exists, create if not
- **Rationale**: Simplifies auto-registration logic and agent behavior

### Decision: delete_document removes file from disk
- **Context**: Whether delete should only remove metadata or also the file
- **Alternatives Considered**:
  1. Metadata only — safer but leaves orphaned files
  2. Metadata + file — complete cleanup
- **Selected Approach**: Remove both metadata and file; tolerate missing file gracefully
- **Rationale**: Registry owns the lifecycle of reference documents

## Risks & Mitigations
- Risk: Stale reference documents after file deletion outside CC → Mitigation: UI shows error when content fetch fails
- Risk: Auto-registration runs on every conversation start → Mitigation: Idempotent operation, no-op if already registered
