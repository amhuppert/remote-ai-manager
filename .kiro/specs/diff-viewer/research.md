# Research & Design Decisions

## Summary

- **Feature**: `diff-viewer`
- **Discovery Scope**: Extension (existing system — fully implemented with tests)
- **Key Findings**:
  - Diff computation is implemented in `src/lib/diff.ts` with `computeDiff()` and `parseDiff()` functions
  - `diff.test.ts` provides 6 test cases covering core parsing scenarios
  - `DiffPanel.tsx` provides full interactive UI with collapsible files and navigation
  - Types are plain TypeScript interfaces (no Zod validation needed — internal data only)

## Research Log

### Existing Architecture Analysis

- **Context**: Diff viewer is already implemented; mapping implementation against requirements.
- **Sources Consulted**: `src/lib/diff.ts`, `src/lib/diff.test.ts`, `src/app/projects/[name]/[session]/DiffPanel.tsx`, `SessionDetailPage.tsx`, `LayoutSwitcher.tsx`, `page.tsx`, `src/types/index.ts`, `globals.css`
- **Findings**:
  - `computeDiff()` executes `git diff main --unified=3` via `execFile` in the session worktree with 10MB max buffer
  - `parseDiff()` is a line-by-line state machine that tracks current file and current hunk, classifying lines by prefix (`+`, `-`, ` `, `@@`, `diff --git`)
  - Metadata lines (`index`, `---`, `+++`, `new file mode`, etc.) are explicitly skipped
  - Addition/deletion counts are tracked per file and summed for totals
  - `DiffPanel.tsx` renders collapsible file sections with sticky headers, file/hunk navigation, and smooth scrolling
  - `LayoutSwitcher.tsx` provides four layout modes with localStorage persistence
  - Mobile responsive design with tab switching between conversation and diff panels
  - 6 test cases in `diff.test.ts` cover: empty diff, single file/hunk, deletions, multiple files, multiple hunks, new file mode
- **Implications**: Feature is complete with good test coverage. No new components needed.

### Type System Design

- **Context**: Understanding why diff types don't use Zod schemas.
- **Findings**:
  - Diff data is computed server-side and passed as props — never crosses an API boundary
  - Unlike transcripts (external JSONL files) or session state (persisted JSON), diffs are generated from trusted git output
  - Plain TypeScript interfaces (`FileDiff`, `DiffHunk`, `DiffLine`, `SessionDiff`) provide compile-time safety without runtime overhead
- **Implications**: No Zod schemas needed. This is the correct design choice for internally-generated data.

## Design Decisions

### Decision: Git Diff Against Main Branch

- **Context**: What reference point to diff against.
- **Selected Approach**: `git diff main --unified=3` in the worktree
- **Rationale**: Each session worktree branches from main via `csm/<name>` branch. Diffing against main shows all session changes. The `--unified=3` flag provides 3 lines of context (git default).

### Decision: Line-by-Line State Machine Parser

- **Context**: How to parse unified diff format.
- **Selected Approach**: Iterate lines, track `currentFile` and `currentHunk` state, classify by prefix
- **Rationale**: Unified diff is a well-defined line-oriented format. A simple state machine handles all cases without needing a library dependency. Line prefixes (`+`, `-`, ` `, `@@`, `diff --git`) are unambiguous.

### Decision: No API Route for Diffs

- **Context**: Whether diffs should be served via API or computed during SSR.
- **Selected Approach**: Server Component computes diff during page render, passes as props
- **Rationale**: Diff is always needed when viewing the session detail page. Computing during SSR avoids an extra API round-trip and keeps the component model simple. The diff data never needs to be fetched independently.

## Risks & Mitigations

- **Large diffs** — 10MB max buffer limits extremely large diffs. Acceptable for typical coding sessions.
- **No main branch** — If the worktree has no `main` reference, `git diff` fails and returns empty diff gracefully.
- **Stale diff data** — Page must be refreshed to see updated diffs. Real-time updates are a non-goal.

## References

- Git unified diff format — line-oriented with `diff --git`, `@@`, `+`, `-`, ` ` prefixes
- Node.js `child_process.execFile` — subprocess spawning without shell (security benefit)
