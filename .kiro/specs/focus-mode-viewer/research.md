# Research & Design Decisions

---
**Purpose**: Capture discovery findings for the focus-mode-viewer feature.
---

## Summary
- **Feature**: `focus-mode-viewer`
- **Discovery Scope**: Extension
- **Key Findings**:
  - The `creationMode` field already exists on `sessionStateSchema` (`"fast" | "focus"`), so no data model changes are needed for session mode tracking (Req 4.3)
  - The right-side pane is currently a single `DiffPanel` component; panel switching requires wrapping it in a container with tab controls
  - Markdown rendering needs a client-side library — `react-markdown` with `remark-gfm` is the standard choice for React/Next.js

## Research Log

### Existing Data Model for Session Mode
- **Context**: Requirement 4.3 requires a field to distinguish focus vs fast mode sessions
- **Findings**:
  - `sessionCreationModeSchema = z.enum(["fast", "focus"])` already defined in `src/lib/schemas.ts:116`
  - `creationMode` field exists on `sessionStateSchema` with `default("fast")` at `src/lib/schemas.ts:130`
  - `createSessionRequestSchema` uses a discriminated union on `mode` at `src/lib/schemas.ts:156-165`
  - Type `SessionCreationMode` already exported from `src/types/index.ts:41`
- **Implications**: No schema or API changes needed for mode tracking — it's already persisted and available in `SessionState`

### Layout System Architecture
- **Context**: Understand how the right pane works to add panel switching
- **Findings**:
  - `LayoutMode = "conversation" | "default" | "split" | "diff"` controls overall page layout
  - The layout switcher in the topbar manages page-level column arrangement (conversation-only, default split, 50/50 split, diff-only)
  - `DiffPanel` is conditionally rendered in `SessionDetailPage.tsx:1199` when `layout !== "conversation"`
  - Mobile uses `MobilePanel = "chat" | "diff"` with a bottom tab bar
  - Layout state managed in `session-detail.store.ts` with localStorage persistence
- **Implications**: Panel switching (diff vs markdown) is orthogonal to the layout mode. It operates *within* the right pane, not at the layout level. The layout modes continue to control whether the right pane is visible; the panel switcher controls what's displayed inside it.

### Right Pane Container Design
- **Context**: How to add tab switching between diff and markdown
- **Findings**:
  - `DiffPanel` renders a `div.sidebar-diff-panel` with its own header, tab bar, toolbar, and content
  - The panel header area is the natural location for the tab switcher between diff/markdown views
  - The existing `DiffPanel` already has an internal tab bar for switching between "Uncommitted" and "Commits" views
- **Implications**: A new wrapper component that sits between `SessionDetailPage` and `DiffPanel`/`MarkdownViewer` can provide the switching logic. The wrapper renders tabs in a shared header area and conditionally mounts one of the two panels.

### Markdown Rendering Library Selection
- **Context**: Need a client-side markdown renderer for the viewer component
- **Findings**:
  - `react-markdown` is the dominant React markdown renderer (19M+ weekly npm downloads)
  - Supports GFM via `remark-gfm` plugin (tables, strikethrough, task lists)
  - Renders to React elements (no `dangerouslySetInnerHTML`)
  - Works well with Next.js App Router client components
  - Alternative: `marked` + `DOMPurify` — heavier, requires HTML sanitization
  - Alternative: Custom markdown parser — unnecessary complexity
- **Implications**: `react-markdown` + `remark-gfm` is the correct choice: safe, lightweight, well-maintained, no sanitization needed

### API Endpoint for Focus Doc
- **Context**: Need to serve `memory-bank/focus.md` content from the session's worktree
- **Findings**:
  - All session API routes live under `src/app/api/projects/[name]/sessions/[session]/`
  - The session's `worktreePath` is available from `SessionState` and resolves to the actual filesystem path
  - The file path within the worktree would be `{worktreePath}/memory-bank/focus.md`
  - Existing patterns: routes export async handlers (GET, POST, DELETE), use `readState` to look up session data
- **Implications**: New route at `src/app/api/projects/[name]/sessions/[session]/focus-doc/route.ts` — reads the file from disk and returns `{ content: string }` or 404 if not found

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Right-pane wrapper component | A `RightPane` component wraps DiffPanel and MarkdownViewer with tab switching | Clean separation, layout modes unchanged, minimal SessionDetailPage changes | Adds one nesting layer | Selected approach |
| Inline tab switching in SessionDetailPage | Add tabs and conditional rendering directly in the page component | No new component | SessionDetailPage is already 1277 lines, would increase complexity further | Rejected |
| Extend DiffPanel with markdown tab | Add markdown as a third tab inside DiffPanel alongside Uncommitted/Commits | Reuses existing tab UI | Conflates two unrelated features, DiffPanel name becomes misleading | Rejected |

## Design Decisions

### Decision: Right-pane wrapper component
- **Context**: Need to switch between diff and markdown viewer in the same pane area
- **Alternatives Considered**:
  1. Inline tab switching in SessionDetailPage — adds more complexity to an already large component
  2. Extend DiffPanel with a markdown tab — conflates unrelated features
- **Selected Approach**: New `RightPane` component that wraps `DiffPanel` and `MarkdownViewer`, providing a tab bar when focus mode is active
- **Rationale**: SessionDetailPage is already 1277 lines; adding panel switching logic there would reduce readability. A dedicated wrapper keeps responsibilities clear.
- **Trade-offs**: One additional component layer, but minimal overhead
- **Follow-up**: Ensure the wrapper passes through all DiffPanel props without friction

### Decision: Store active right-pane tab in Zustand
- **Context**: Need to track which panel (diff vs focus) is active in the right pane
- **Alternatives Considered**:
  1. Local useState in RightPane — loses state when switching layouts
  2. URL parameter — over-complicates routing
- **Selected Approach**: Add `rightPaneTab` to `session-detail.store.ts`
- **Rationale**: Consistent with how layout mode and mobile panel are managed; state persists across re-renders and is accessible from the layout switcher if needed
- **Trade-offs**: Zustand store grows slightly, but it's a single field

### Decision: Session mode badge in session list table
- **Context**: Need a visual indicator for focus vs fast mode in the session list
- **Selected Approach**: Small badge in the session name cell, adjacent to the existing "merged" badge, using semantic colors (cyan for focus, neutral for fast)
- **Rationale**: Consistent with the existing `session-badge merged` pattern; doesn't require a new table column

## Risks & Mitigations
- **Risk**: `react-markdown` bundle size — Mitigation: it's a client component, will be code-split naturally by Next.js
- **Risk**: `focus.md` may be large — Mitigation: the viewer is scrollable (Req 1.4), no special handling needed for typical markdown files
- **Risk**: Legacy sessions without `creationMode` — Mitigation: schema defaults to `"fast"`, so legacy sessions gracefully degrade with no mode badge (Req 5.4)

## References
- [react-markdown](https://github.com/remarkjs/react-markdown) — React component for rendering markdown
- [remark-gfm](https://github.com/remarkjs/remark-gfm) — Plugin for GitHub Flavored Markdown support
