# Requirements Document

## Project Description (Input)
Add session branching support so that sessions can be created from any branch (not just main), with parent-child relationships tracked and merge workflows targeting the parent session's branch instead of always targeting main.

## Introduction
Command Center currently creates all sessions as worktrees branched from `main` and merges back into `main`. This feature introduces session branching — the ability to create child sessions from any existing session's branch, establishing parent-child relationships and directing merge workflows to the parent session's branch instead of hardcoding `main`. This enables hierarchical development workflows where a session's work can be further subdivided into child sessions before merging up the chain.

**Scope**: This specification covers the full backend support (schema, git operations, merge workflow, orphan handling) and all UI text that references the target branch. The mechanism for users to select a parent session during creation (e.g., a UI selector in CreateSessionModal) is an implementation detail addressed in the task plan, not a separate requirement.

## Requirements

### Requirement 1: Session State Schema Extensions
**Objective:** As a developer, I want each session to track its merge target branch and optional parent session, so that sessions can participate in hierarchical branching workflows.

#### Acceptance Criteria
1. The Session State schema shall include a `targetBranch` field of type string that defaults to `"main"`.
2. The Session State schema shall include a `parentSessionName` field of type string or null that defaults to `null`.
3. When an existing state file is loaded that lacks `targetBranch` or `parentSessionName` fields, CC shall apply the default values without requiring a migration.
4. The `targetBranch` field shall serve as the source of truth for all git operations (diffs, merges, commit logs) performed on the session.

### Requirement 2: Create Session Request Extensions
**Objective:** As a developer, I want to specify a parent session when creating a new session, so that the child session branches from and merges back into the parent's branch.

#### Acceptance Criteria
1. The Create Session Request schema shall accept an optional `parentSessionName` field identifying the parent session within the same project.
2. If `parentSessionName` is provided in the creation request, CC shall validate that the named parent session exists in the same project and has an active branch.
3. If an invalid or nonexistent `parentSessionName` is provided, CC shall reject the request with an appropriate error.

### Requirement 3: Child Session Provisioning
**Objective:** As a developer, I want to create a session that branches off an existing session's branch, so that I can subdivide work within a session's scope.

#### Acceptance Criteria
1. When a session is created with a valid `parentSessionName`, CC shall create the worktree using the parent session's `branchName` as the base branch instead of `main`.
2. When a session is created with a valid `parentSessionName`, CC shall set the new session's `targetBranch` to the parent session's `branchName`.
3. When a session is created with a valid `parentSessionName`, CC shall set the new session's `parentSessionName` to the parent session's `sessionName`.
4. When a session is created without a `parentSessionName`, CC shall create the worktree from `main` and set `targetBranch` to `"main"` (preserving current behavior).

### Requirement 4: Git Operations with Configurable Target Branch
**Objective:** As a developer, I want all git operations to use the session's target branch instead of hardcoded `main`, so that diffs, logs, and merges work correctly for child sessions.

#### Acceptance Criteria
1. When computing the commit log for a session, CC shall use `targetBranch` instead of `main` as the comparison base (e.g., `git log <targetBranch>..HEAD`).
2. When computing the commit diff for a session, CC shall use `targetBranch` instead of `main` for merge-base calculations and ancestor checks.
3. When merging the target branch into the feature branch (to sync upstream changes), CC shall merge `targetBranch` instead of `main`.
4. When checking if a session's branch has been merged, CC shall check ancestry and log mentions against `targetBranch` instead of `main`.
5. The git operation functions shall default `targetBranch` to `"main"` when not explicitly provided, preserving backward compatibility for callers that do not pass the parameter.

### Requirement 5: Merge Workflow with Target Branch
**Objective:** As a developer, I want the smart merge workflow to merge into the session's target branch instead of always merging into main, so that child sessions merge into their parent's branch.

#### Acceptance Criteria
1. The merge workflow input shall include a `targetBranch` field specifying which branch to merge into.
2. The merge workflow context shall carry `targetBranch` and propagate it to actor invocations that consume it (merge-main, squash-merge).
3. When performing a squash merge into a non-main target branch, CC shall execute the merge within the parent session's worktree (which is already checked out on the target branch) instead of the project root.
4. When dispatching a merge background job, CC shall read the session's `targetBranch` from state and include it in the merge input.
5. When dispatching a conflict resolution background job, CC shall read the session's `targetBranch` from state and include it in the resolution input.
6. The merge commit message passed to git operations shall reference the session's actual target branch name instead of hardcoded "main".

### Requirement 6: Orphan Session Handling
**Objective:** As a developer, I want child sessions to be automatically retargeted when their parent session is merged or deleted, so that no session is left with a broken merge target.

#### Acceptance Criteria
1. When a parent session is merged, CC shall retarget all its child sessions' `targetBranch` to `"main"` and clear their `parentSessionName` to `null`.
2. When a parent session is deleted, CC shall retarget all its child sessions' `targetBranch` to `"main"` and clear their `parentSessionName` to `null`.
3. The orphan retargeting shall apply only to direct children (sessions whose `parentSessionName` matches the merged/deleted session's name) within the same project.
4. When a parent session's merge is detected externally (via the merge detection system), CC shall also retarget the parent's child sessions.

### Requirement 7: UI Dynamic Branch References
**Objective:** As a developer, I want the UI to display the actual target branch name instead of hardcoded "main", so that merge dialogs and status messages are accurate for child sessions.

#### Acceptance Criteria
1. The smart merge dialog shall display "merge into `<targetBranch>`" using the session's actual target branch name.
2. The merge toast notification shall reference the session's actual target branch name instead of hardcoded "main".
3. The session detail page shall reference the session's actual target branch name in merged-session status text.
4. The notification text generated for merge and resolve-conflicts background jobs shall reference the session's actual target branch name instead of hardcoded "main".
5. The diff view labels (diff panel and full-page diff viewer) shall display "Diff vs `<targetBranch>`" instead of hardcoded "Diff vs main".
6. The commit log and commit diff API routes shall pass the session's `targetBranch` to git operation functions.
