# Research & Design Decisions

## Summary
- **Feature**: `worktree-import`
- **Discovery Scope**: Extension (adding worktree discovery/import to existing session management)
- **Key Findings**:
  - `git worktree list --porcelain` provides structured, machine-parseable output with path, HEAD, and branch per worktree
  - The conversation auto-import pattern in `conversations.ts` provides a proven discover-deduplicate-persist model to follow
  - Schema change is minimal: one new field (`source`) on `sessionStateSchema` with a backward-compatible default

## Research Log

### git worktree list --porcelain output format
- **Context**: Need to parse git output to discover all worktrees for a project
- **Sources Consulted**: git-worktree documentation
- **Findings**:
  - Output consists of blocks separated by blank lines, one block per worktree
  - Each block contains: `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>` (or `detached` keyword)
  - The first block is always the main working tree
  - Prunable worktrees include a `prunable` line
  - Locked worktrees include a `locked` line (optionally with reason)
- **Implications**: Parse line-by-line, accumulate fields into a struct, emit on blank line. Filter out the main worktree (first entry or matching projectPath).

### Existing conversation import pattern
- **Context**: CSM already imports Claude Code sessions — can we follow the same pattern for worktrees?
- **Sources Consulted**: `src/lib/conversations.ts` (lines 136-376)
- **Findings**:
  - `discoverAndImportConversations()` follows: discover → deduplicate by ID → create records → persist atomically via `writeState()`
  - Uses `source: "imported"` to distinguish auto-imported from CSM-created records
  - Called on-demand when sessions are listed with `?import=true` query param
- **Implications**: The worktree import can use the same pattern. Match by `worktreePath` instead of `claudeSessionId`. The `source` field convention already exists at the conversation level and can be extended to sessions.

### State reconciliation trigger point
- **Context**: When should reconciliation happen?
- **Sources Consulted**: `src/app/api/projects/[name]/sessions/route.ts` GET handler
- **Findings**:
  - Current GET handler simply calls `getProjectSessions(projectPath)` and returns the result
  - No disk validation is performed — purely state-file driven
  - Adding reconciliation here means every session listing triggers a `git worktree list` call
- **Implications**: The cost of `git worktree list` is negligible (sub-50ms for typical repos). Triggering on every GET is acceptable and keeps the UI automatically up-to-date without requiring explicit import actions.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| On-demand reconciliation in GET | Run `git worktree list` on every session listing | Always up-to-date, no user action needed | Slight latency increase per request | Matches conversation import precedent |
| Explicit import endpoint | Separate POST endpoint to trigger import | User controls when import happens | UI may show stale data | More complex UX flow |
| Background polling | Periodic worktree scan | Zero request-path overhead | Complexity, stale between polls | Over-engineered for this use case |

**Selected**: On-demand reconciliation in GET — simplest, always accurate, minimal latency cost.

## Design Decisions

### Decision: On-demand reconciliation in GET handler
- **Context**: Need to decide when worktree discovery and import runs
- **Alternatives Considered**:
  1. On every GET /sessions request — automatic, always fresh
  2. Explicit POST /sessions/import endpoint — user-triggered
  3. Background timer — periodic scan
- **Selected Approach**: On-demand in GET handler
- **Rationale**: Follows the principle of least surprise. Users see all worktrees immediately without extra steps. The `git worktree list` command is fast enough to not impact perceived latency.
- **Trade-offs**: Every listing makes a git subprocess call. Acceptable for CSM's usage patterns (single user, local repos).
- **Follow-up**: Monitor if git call latency becomes an issue for repos with many worktrees.

### Decision: Unlink-only deletion for imported sessions
- **Context**: Imported worktrees are managed externally; CSM should not destroy them
- **Alternatives Considered**:
  1. Always remove worktree on delete (current behavior)
  2. Never remove worktree, only unlink from state
  3. Branch on `source` field — remove CSM-created, unlink imported
- **Selected Approach**: Branch on `source` field
- **Rationale**: CSM-created sessions are fully owned by CSM and should be cleaned up. Imported sessions are owned externally and CSM should only untrack them.
- **Trade-offs**: An unlinked imported session will reappear on next listing since the worktree still exists on disk. This is actually desirable — the user can re-import it if needed.
- **Follow-up**: Consider adding an "ignore list" in the future to permanently hide specific worktrees.

### Decision: Session name derivation from branch name
- **Context**: Imported worktrees need a display name; no user input is available
- **Alternatives Considered**:
  1. Use full branch name (e.g., `feature/login`)
  2. Strip prefix and use remainder (e.g., `login` from `feature/login`)
  3. Use worktree directory name
- **Selected Approach**: Strip `csm/` and `refs/heads/` prefixes; use remaining branch name as-is. Fall back to directory name for detached HEAD.
- **Rationale**: The branch name is the most semantically meaningful identifier. Only stripping CSM's own `csm/` prefix and git's `refs/heads/` prefix preserves user intent. Other prefixes like `feature/` are part of the branch naming convention and should be kept.
- **Trade-offs**: Session names may contain `/` characters, which the current `validateSessionName` does not allow. This is fine because imported sessions bypass the creation validation.

## Risks & Mitigations
- **Re-import after unlink**: Unlinking an imported session causes it to reappear on next listing → acceptable behavior; users understand "delete" means "stop tracking" for imported sessions
- **Name collisions**: Multiple worktrees could derive the same session name → append numeric suffix to ensure uniqueness
- **Main worktree false-positive**: Must reliably identify and exclude the main working tree → use `git worktree list --porcelain` which always lists the main worktree first; additionally compare path against projectPath

## References
- [git-worktree documentation](https://git-scm.com/docs/git-worktree) — porcelain output format
- `src/lib/conversations.ts` — existing auto-import pattern for Claude Code sessions
- `src/lib/sessions.ts` — current session creation and deletion logic
