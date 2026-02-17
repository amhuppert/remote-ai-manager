# Research & Design Decisions

## Summary
- **Feature**: git-operations
- **Discovery Scope**: Extension (adding git commit, merge, and commit history to existing session management)
- **Key Findings**:
  - All git operations can use existing `execFile` + `git` pattern from `sessions.ts`
  - Squash merge must execute in the project root (main branch working tree), not the session worktree
  - Commit history and uncommitted diff are complementary views; tabbed layout within existing diff panel keeps UI cohesive

## Research Log

### Git Squash Merge in Worktree Context
- **Context**: Sessions use git worktrees (`.worktrees/<name>`) with branches (`csm/<name>`). Need to squash-merge back into `main`.
- **Findings**:
  - Squash merge must run from the project root directory (where `main` is checked out), not the worktree
  - `git merge --squash csm/<branch>` stages all branch changes into a single commit on `main`
  - The project root should be clean since all development happens in worktrees
  - Pre-merge safety: check project root for uncommitted changes with `git status --porcelain`
  - Post-merge: the worktree branch still exists; session can continue or be archived
- **Implications**: Merge API route needs access to both `projectPath` (root) and session branch name

### Git Commit Log Retrieval
- **Context**: Need commit history since branch diverged from `main`
- **Findings**:
  - `git log main..HEAD --format="%H%n%h%n%s%n%aI" --stat` gives full + abbreviated hash, message, ISO date, and file stats
  - `git rev-list --count main..HEAD` gives total commit count
  - Per-commit diff: `git diff <hash>~1..<hash>` (or `git show <hash>` parsed)
  - For the first commit after divergence: `git diff main..<first-commit-hash>`
- **Implications**: Can reuse existing `parseDiff()` from `diff.ts` for per-commit diffs

### Uncommitted Change Detection
- **Context**: Commit button should be disabled when there are no uncommitted changes; merge should be blocked when there are uncommitted changes
- **Findings**:
  - `diff.files.length > 0` from existing `computeDiff()` indicates uncommitted changes
  - No new git command needed; server page.tsx already computes diff
- **Implications**: Client receives both `diff` and `commits` as props, enabling button state derivation

## Design Decisions

### Decision: New lib module `git-operations.ts`
- **Context**: Need commit, merge, and commit log functions. `sessions.ts` handles lifecycle (create/delete).
- **Alternatives**:
  1. Add to `sessions.ts` — keeps all session-related code together
  2. New `git-operations.ts` — separates git operations from session lifecycle
- **Selected Approach**: New `git-operations.ts` module
- **Rationale**: Single responsibility; `sessions.ts` manages session state + worktree lifecycle, `git-operations.ts` manages git actions within sessions. Prevents `sessions.ts` from growing too large.

### Decision: Commit history as tab in diff panel
- **Context**: Need to display commit history alongside existing diff view
- **Alternatives**:
  1. New layout mode in layout switcher — adds 5th mode, breaks existing mental model
  2. Separate panel — requires rethinking layout grid
  3. Tab within diff panel ("Uncommitted" / "Commits") — reuses existing panel space
- **Selected Approach**: Tabbed diff panel
- **Rationale**: Commit history and uncommitted diff are both "changes since main" — logically grouped. Minimal UI disruption. The diff panel header already has space for tabs.

### Decision: Commit/merge buttons in topbar session controls
- **Context**: Need UI triggers for commit and merge actions
- **Alternatives**:
  1. Topbar session controls area — alongside existing refresh/delete buttons
  2. Inside diff panel toolbar — co-located with diff actions
  3. Floating action buttons — prominent but inconsistent with design system
- **Selected Approach**: Topbar session controls
- **Rationale**: Commit and merge are session-level actions (like delete), not diff-level. Topbar placement follows existing pattern. Icon buttons with tooltips match existing `btn-icon-only` styling.

## Risks & Mitigations
- **Main working tree dirty** — Pre-merge check for uncommitted changes in project root; return clear error if dirty
- **Merge conflicts** — Git returns non-zero exit code + stderr; surface error message in dialog
- **Concurrent merge attempts** — Reuse existing single-flight lock mechanism from `lock.ts`
- **Large commit history** — Unlikely for session branches (short-lived); no pagination needed initially
