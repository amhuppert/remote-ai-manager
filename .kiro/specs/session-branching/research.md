# Research & Design Decisions

## Summary
- **Feature**: session-branching
- **Discovery Scope**: Extension
- **Key Findings**:
  - All hardcoded `"main"` references in git operations and merge workflow are isolated to well-defined function signatures — adding a `targetBranch` parameter is mechanical
  - Squash merge currently runs in the project root (implicitly on main) — for non-main targets, running inside the parent session's worktree avoids checkout gymnastics
  - Existing `forkedFrom` pattern on conversations provides a precedent for parent-tracking; session-level `parentSessionName` follows the same concept with simpler string references

## Research Log

### Squash Merge Execution Location
- **Context**: `squashMerge()` runs `git merge --squash` in the project root directory (which is on main). For child sessions targeting a non-main branch, we need to merge into the parent session's worktree instead.
- **Findings**:
  - The parent session's worktree is already checked out on `targetBranch` by construction
  - `acquireProjectLock()` currently uses `projectPath` as the lock key — for non-main targets, the lock key should be the parent worktree path to prevent concurrent merges into the same branch
  - The squash merge actor receives `projectPath` and `branchName` — adding `targetBranch` and `targetWorktreePath` allows it to choose the correct execution directory
- **Implications**: `SquashMergeInput` needs `targetBranch` and an optional `targetWorktreePath` (the parent worktree). When `targetBranch !== "main"`, squash merge runs in `targetWorktreePath` instead of `projectPath`.

### Orphan Handling Integration Points
- **Context**: When a parent session is merged or deleted, child sessions must be retargeted to prevent broken merge targets.
- **Findings**:
  - Merge completion: `squashMergeActor` calls `setSessionFinished()` — this is the natural integration point for orphan retargeting after merge
  - Session deletion: `deleteSession()` removes the session from state — orphan retargeting should happen before the state mutation
  - Finding children: iterate `project.sessions` where `parentSessionName === deletedSessionName`
- **Implications**: A shared `retargetOrphanedChildren()` function called from both `squashMergeActor` (after marking finished) and `deleteSession` (before removing from state).

### Merge Detection with Non-Main Targets
- **Context**: `merge-detection.ts` periodically checks if session branches have been merged into main. For child sessions, the check should be against `targetBranch`.
- **Findings**:
  - `isBranchAncestorOfMain()` and `isBranchMentionedInMainLog()` both hardcode `"main"` — these need the `targetBranch` parameter
  - Merge detection reads all sessions from state and calls these functions — it can read `targetBranch` from each session's state
- **Implications**: Merge detection needs to pass `session.targetBranch` (defaulting to `"main"`) to the detection functions.

## Design Decisions

### Decision: Dual Fields (targetBranch + parentSessionName)
- **Context**: Need to track both where a session merges into and which session is its parent
- **Alternatives Considered**:
  1. Single `parentSessionName` field — derive target branch by looking up parent's `branchName`
  2. Dual fields — `targetBranch` as git truth, `parentSessionName` for UI navigation
- **Selected Approach**: Dual fields
- **Rationale**: `targetBranch` is the authoritative git reference that all operations use directly. `parentSessionName` is a convenience link for UI hierarchy display. Separating them avoids lookups on every git operation and survives parent session deletion (orphan retargeting updates `targetBranch` independently).
- **Trade-offs**: Slight data duplication (branch name stored in both parent's `branchName` and child's `targetBranch`), but this is intentional — the child's `targetBranch` is the source of truth even if the parent is deleted.

### Decision: Squash Merge in Parent Worktree
- **Context**: Squash merge into non-main branches cannot run in the project root
- **Alternatives Considered**:
  1. Temporarily checkout the target branch in project root — risky with concurrent sessions
  2. Run squash merge in the parent session's worktree — already on the target branch
  3. Create a temporary worktree for the merge — overhead and cleanup concerns
- **Selected Approach**: Run in parent session's worktree
- **Rationale**: Parent worktree is already checked out on the target branch. No checkout gymnastics needed. Project lock changes to lock on the target worktree path.
- **Trade-offs**: Depends on parent worktree still existing. If parent is deleted first, merge fails — but orphan retargeting should prevent this.

### Decision: Orphan Retargeting to Main
- **Context**: What happens to child sessions when parent is merged or deleted
- **Alternatives Considered**:
  1. Cascade delete children — destructive, may lose work
  2. Retarget children to `"main"` — safe, preserves work
  3. Retarget to grandparent — complex, multi-level tracking
- **Selected Approach**: Retarget to `"main"` (flat retarget, not cascading)
- **Rationale**: Simplest safe option. Children continue to function with `main` as their merge target. Multi-level chaining adds complexity with marginal benefit.
- **Trade-offs**: Grandchild sessions also retarget to `main` rather than cascading up — acceptable for initial implementation.

## Risks & Mitigations
- **Parent worktree deleted before child merge** — Orphan retargeting runs as part of delete/merge flow, retargeting children before the parent worktree is removed. If deletion fails mid-way, child sessions may have a stale `targetBranch` pointing to a deleted branch — merge would fail with a clear git error.
- **Concurrent merge of parent and child** — Project lock prevents concurrent merges. When targeting a non-main branch, lock on the parent worktree path.
- **Multi-level nesting depth** — Initial implementation supports arbitrary depth but orphan retargeting is flat (to `"main"`). Deep chains should be rare in practice.
