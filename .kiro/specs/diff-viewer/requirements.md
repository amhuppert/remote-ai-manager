# Requirements Document

## Introduction

The Diff Viewer feature computes and renders git diffs for Claude Code sessions. Each session operates within a git worktree branched from `main`, and the diff viewer shows what Claude Code has changed by running `git diff main` in the worktree. The feature covers the full pipeline: executing the git diff command, parsing unified diff format into structured data, and rendering an interactive diff panel with collapsible file sections, line-level syntax highlighting (additions/deletions/context), and navigation controls. The diff panel is integrated into the session detail page alongside the transcript viewer.

## Requirements

### Requirement 1: Git Diff Computation

**Objective:** As a developer, I want diffs to be computed against the main branch in the session's worktree, so that I can see exactly what Claude Code has changed.

#### Acceptance Criteria

1. When a diff is requested, the Diff Engine shall execute `git diff main --unified=3` in the session's worktree directory.
2. The Diff Engine shall use `execFile` (not `exec`) for subprocess spawning to prevent shell injection.
3. The Diff Engine shall configure a maximum output buffer of 10 MB for the git process.
4. If the git diff command fails, the Diff Engine shall return an empty diff (no files, zero additions, zero deletions).
5. If the diff output is empty, the Diff Engine shall return an empty diff structure.

### Requirement 2: Unified Diff Parsing

**Objective:** As a developer, I want unified diff output to be parsed into structured data, so that diffs can be rendered with file-level and line-level granularity.

#### Acceptance Criteria

1. The Diff Parser shall extract file paths from `diff --git a/... b/...` header lines.
2. The Diff Parser shall identify hunk boundaries from `@@` header lines and preserve the header text.
3. The Diff Parser shall classify lines prefixed with `+` as additions and strip the prefix from the content.
4. The Diff Parser shall classify lines prefixed with `-` as deletions and strip the prefix from the content.
5. The Diff Parser shall classify lines prefixed with a space (or empty) as context lines.
6. The Diff Parser shall skip metadata lines (`index`, `---`, `+++`, `new file mode`, `deleted file mode`, `old mode`, `new mode`).
7. The Diff Parser shall count additions and deletions per file and compute totals across all files.

### Requirement 3: Multi-File and Multi-Hunk Support

**Objective:** As a developer, I want diffs spanning multiple files and multiple hunks to be correctly separated, so that each file's changes are distinct and navigable.

#### Acceptance Criteria

1. The Diff Parser shall support parsing diffs containing multiple files, creating a separate `FileDiff` for each.
2. The Diff Parser shall support parsing files with multiple hunks, creating a separate `DiffHunk` for each `@@` header.
3. The Diff Parser shall support new file mode diffs (files with no previous version).
4. The Diff Parser shall return files in the order they appear in the git diff output.

### Requirement 4: Diff Panel Rendering

**Objective:** As a developer, I want diffs to be rendered as an interactive panel with visual differentiation of line types, so that I can quickly understand what changed.

#### Acceptance Criteria

1. The Diff Panel shall render each file as a collapsible section with a sticky header showing the file path and addition/deletion counts.
2. The Diff Panel shall render addition lines with green background and border styling.
3. The Diff Panel shall render deletion lines with red background and border styling.
4. The Diff Panel shall render context lines with subdued styling.
5. The Diff Panel shall render hunk headers with cyan background styling.
6. When no files are present in the diff, the Diff Panel shall display a summary showing zero changes.

### Requirement 5: Navigation Controls

**Objective:** As a developer, I want navigation controls to quickly jump between files and changes, so that I can efficiently review large diffs.

#### Acceptance Criteria

1. The Diff Panel shall provide collapse-all and expand-all buttons for file sections.
2. The Diff Panel shall provide previous/next file navigation that scrolls to the target file header.
3. The Diff Panel shall auto-expand collapsed files when navigating to them.
4. The Diff Panel shall provide previous/next hunk navigation that scrolls to the target hunk header.
5. The Diff Panel shall use smooth scrolling when navigating between files and hunks.

### Requirement 6: Layout Integration

**Objective:** As a developer, I want the diff panel to be integrated into the session detail page with flexible layout options, so that I can view diffs alongside or instead of the conversation.

#### Acceptance Criteria

1. The Session Detail Page shall support four layout modes: conversation-only, default (chat + 420px diff sidebar), split (50/50), and diff-only.
2. The Layout Switcher shall persist the selected layout mode to localStorage per project/session.
3. On mobile viewports (max-width 768px), the Session Detail Page shall collapse to a single panel with tab switching between conversation and diff.
