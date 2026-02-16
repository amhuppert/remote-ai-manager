# Implementation Plan

> **Note**: The diff-viewer feature is fully implemented. `parseDiff` has 6 unit tests in `diff.test.ts` covering core parsing scenarios (Requirements 2–3). Tasks below address remaining test coverage gaps for git integration (Requirement 1) and UI rendering (Requirements 4–6).

- [x] 1. Add unit tests for parseDiff edge cases
- [x] 1.1 (P) Test metadata line skipping
  - Verify `index`, `---`, `+++`, `new file mode`, `deleted file mode`, `old mode`, `new mode` lines are all skipped
  - Verify these lines do not appear as context lines in any hunk
  - _Requirements: 2.6_

- [x] 1.2 (P) Test addition/deletion counting accuracy
  - Verify per-file addition and deletion counts match the actual `+`/`-` lines
  - Verify `totalAdditions` and `totalDeletions` are the sum across all files
  - Verify context lines are not counted as additions or deletions
  - _Requirements: 2.7_

- [x] 1.3 (P) Test file ordering preservation
  - Verify files appear in the output in the same order as the git diff
  - Verify hunks within a file appear in order
  - _Requirements: 3.4_

- [x] 2. Add integration tests for computeDiff
- [x] 2.1 Test successful diff computation
  - Mock `execFile` to return sample unified diff output
  - Verify the returned `SessionDiff` contains correctly parsed files
  - Verify the working directory is set to the provided worktree path
  - _Requirements: 1.1, 1.2_

- [x] 2.2 (P) Test git failure handling
  - Mock `execFile` to throw an error (simulating missing main branch)
  - Verify an empty diff is returned: `{ files: [], totalAdditions: 0, totalDeletions: 0 }`
  - _Requirements: 1.4_

- [x] 2.3 (P) Test empty diff output
  - Mock `execFile` to return an empty string
  - Verify an empty diff is returned
  - _Requirements: 1.5_

- [x] 3. Add rendering tests for DiffPanel
- [x] 3.1 Test file section rendering
  - Verify each file renders with its file path in the header
  - Verify addition and deletion counts are displayed per file
  - Verify file sections are collapsible (clicking header toggles content visibility)
  - _Requirements: 4.1_

- [x] 3.2 Test line type styling
  - Verify addition lines have the `add` CSS class
  - Verify deletion lines have the `remove` CSS class
  - Verify context lines have the `context` CSS class
  - Verify hunk headers have the `hunk-header` CSS class
  - _Requirements: 4.2, 4.3, 4.4, 4.5_

- [x] 3.3 (P) Test navigation controls
  - Verify collapse-all and expand-all buttons toggle all file sections
  - Verify file navigation buttons scroll to the target file header
  - Verify hunk navigation buttons scroll to the target hunk
  - _Requirements: 5.1, 5.2, 5.4_
