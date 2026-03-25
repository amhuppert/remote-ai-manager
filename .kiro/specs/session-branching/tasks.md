# Implementation Plan

- [ ] 1. (P) Extend session and request schemas with branching fields
  - Add a target branch string field (default "main") and a nullable parent session name field (default null) to the session state schema
  - Add an optional parent session name field to all session creation request variants (trimmed, non-empty when provided)
  - Verify existing state files without the new fields parse correctly with defaults applied (no migration needed)
  - Write unit tests for session state parsing with and without the new fields, and request validation with and without the parent session field
  - _Requirements: 1.1, 1.2, 1.3, 2.1_

- [ ] 2. (P) Parameterize git operations with configurable target branch
- [ ] 2.1 Add target branch parameter to commit log and commit diff functions
  - Add an optional target branch parameter (default "main") to the commit log function; replace all hardcoded "main" references in the log and stat queries with this parameter
  - Add the same parameter to the commit diff function; replace hardcoded "main" in merge-base calculations and ancestor checks
  - Write tests verifying both functions use the provided target branch instead of "main"
  - _Requirements: 1.4, 4.1, 4.2, 4.5_

- [ ] 2.2 Rename and parameterize merge detection functions
  - Rename the "is branch ancestor of main" function to "is branch ancestor of target" and add a target branch parameter (default "main")
  - Rename the "is branch mentioned in main log" function to "is branch mentioned in target log" and add the same parameter
  - Replace all hardcoded "main" references in both functions with the parameter
  - Update all call sites in merge actors and detection logic to use the new names
  - Write tests verifying detection checks against a non-main target branch
  - _Requirements: 1.4, 4.4, 4.5_

- [ ] 2.3 Rename and parameterize merge-into-feature and squash merge functions
  - Rename "merge main into feature" to "merge target into feature" with a target branch parameter (default "main")
  - Add a target branch parameter to the squash merge function; when targeting a non-main branch, the merge path parameter accepts the parent session's worktree path instead of the project root
  - Update error messages in squash merge to reference the actual target branch dynamically instead of hardcoded "main"
  - Update all call sites to use the new names
  - Write tests for both functions when operating against a non-main target branch
  - _Requirements: 1.4, 4.3, 4.5_

- [ ] 3. Extend session lifecycle for branching and orphan handling
- [ ] 3.1 Support creating sessions from any base branch
  - Accept optional base branch, target branch, and parent session name parameters in session provisioning
  - Use the base branch in the worktree creation command instead of hardcoded "main"
  - Store the target branch and parent session name on the new session's state
  - Thread the new parameters through all three session creation modes (fast, focus, optimistic)
  - Preserve current behavior when no parent is specified (branch from main, target main)
  - Write tests for both regular session provisioning and child session provisioning from a parent branch
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 3.2 Implement orphan session retargeting when parent is merged or deleted
  - Create a function that finds all direct child sessions of a given parent within the same project
  - Reset each child's target branch to "main" and clear its parent session reference using atomic state mutation
  - Integrate the retargeting call into the session delete flow (before removing the parent from state)
  - Integrate the retargeting call into the external merge detection path (when a parent session's merge is detected externally)
  - Write tests covering: single child, multiple children, no children, and transitive descendants not affected
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 3.3 Update merge-detection service to use targetBranch
  - Update the merge-detection DI deps interface to reference the renamed functions (isBranchAncestorOfTarget, isBranchMentionedInTargetLog)
  - Pass session.targetBranch (defaulting to "main") to both detection calls instead of hardcoded "main"
  - Write tests verifying merge detection uses the session's target branch for non-main targets
  - _Requirements: 4.4, 6.4_

- [ ] 4. Thread target branch through the merge workflow
- [ ] 4.1 Add target branch fields to merge workflow types and machine context
  - Add optional target branch and target worktree path fields to the merge workflow input type
  - Add resolved target branch (string, default "main") and target worktree path (string or null) to the merge context
  - Initialize context from input with "main" as default when not provided
  - Write tests verifying context initialization and propagation from input
  - _Requirements: 5.1, 5.2_

- [ ] 4.2 Thread target branch through merge and squash merge actors
  - Add target branch to the merge-main actor input; pass it through to the renamed merge-target-into-feature git operation
  - Add target branch and target worktree path to the squash merge actor input; when target is not main, use the parent worktree path for the merge operation
  - Integrate orphan retargeting into the squash merge actor — call it after marking the parent session as finished
  - Update the machine's actor invocations to pass target branch fields from context
  - Write tests for actor behavior with both main and non-main target branches
  - _Requirements: 5.2, 5.3, 6.1_

- [ ] 4.3 Include target branch in background job dispatch and notification messages
  - Update the merge job dispatch function to accept and forward target branch and target worktree path in the merge input
  - Update the resolve-conflicts job dispatch function similarly
  - Update the optimistic workflow's merge dispatch to forward target branch
  - Add targetBranch to the BackgroundJob type so the notification message builder can reference it
  - Update buildNotificationMessage to include the target branch in merge success/conflict messages (e.g., "merged into target-branch" instead of generic text)
  - Write tests verifying the dispatched input includes the target branch fields and notification messages reference the target branch
  - _Requirements: 5.4, 5.5, 5.6, 7.4_

- [ ] 5. Integrate session branching into API routes and UI
- [ ] 5.1 Update session creation route with parent session validation
  - When a parent session name is provided in the request, validate the parent exists in the same project and is not finished or archived
  - Resolve the parent's branch name to derive the base branch, target branch, and parent session name for provisioning
  - Return HTTP 400 with a descriptive error for invalid parent references (not found, finished, archived)
  - Write tests for valid parent, missing parent, and finished/archived parent scenarios
  - _Requirements: 2.2, 2.3_

- [ ] 5.2 (P) Update merge, resolve-conflicts, commit, and diff routes to use session's target branch
  - Read the session's target branch from state instead of hardcoding "main" in merge and resolve-conflicts routes
  - When the target branch is not main, resolve the parent session's worktree path for the merge dispatch
  - Use the session's target branch in the merge commit message (e.g., "Merge branch-name into target-branch")
  - Update commit log route to pass session.targetBranch to getCommitLog()
  - Update commit diff route to pass session.targetBranch to getCommitDiff()
  - Write tests for merge dispatch and commit routes with both main and non-main target branches
  - _Requirements: 5.4, 5.5, 5.6, 7.4, 7.6_

- [ ] 5.3 Create BranchSelector component for parent-session selection
  - Create a `BranchSelector` component with radio-list UI: `main` (default) + active sessions from the project
  - Each session entry shows branch name as primary text, session name as secondary
  - Integrate into `CreateSessionModal`: place between mode toggle and name/objective input
  - When a parent is selected, update form hint to show merge target (e.g., "Merges into: csm/implement-auth")
  - Include `parentSessionName` in the mutation payload sent to the session creation API
  - Add Storybook stories for: no sessions, multiple sessions, one selected, disabled state
  - _Requirements: 2.1, 3.1_

- [ ] 5.4 Add Target column and Branch action to SessionsTable
  - Add a "Target" column after "Branch" showing `session.targetBranch` (mono font, 0.72rem)
  - Render `main` targets in `--text-tertiary`, non-main targets in `--cyan`
  - Add a "Branch" button in the actions column for non-finished sessions that opens CreateSessionModal with parent pre-filled
  - Add Storybook stories showing table with mixed main/child sessions
  - _Requirements: 7.1_

- [ ] 5.5 (P) Add targetBranch prop to SmartMergeDialog and MergeToast
  - Add `targetBranch` prop (default `"main"`) to `SmartMergeDialog`; replace hardcoded "main" in description, submitted text, and add "Target" row to merge-info section
  - Add `targetBranch` prop (default `"main"`) to `MergeToast`; update success/conflicts detail text to reference actual target
  - Update Storybook stories for both components with non-main target branch variants
  - _Requirements: 7.1, 7.2_

- [ ] 5.6 (P) Replace remaining hardcoded "main" references in UI components
  - Add `targetBranch` prop to `MobileActionMenu`; update "Merge into Main" to "Merge into `<targetBranch>`"
  - Add `targetBranch` prop to `DiffPanel`; update "Diff vs main" to "Diff vs `<targetBranch>`"
  - Update `SessionDetailPage` finished banner and merge tooltip to reference `targetBranch`
  - Update `ConversationList` finished banner and merge tooltip to reference `targetBranch`
  - Update `SessionDiffViewer` "Diff vs main" label to reference `targetBranch`
  - Update `OptimisticDialog` merge hint text to reference `targetBranch`
  - _Requirements: 7.1, 7.3, 7.5_
