"use client";

import DiffPanel from "@/components/git/DiffPanel";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import { useMainWorktreeDiffQuery } from "@/lib/git/queries";

export interface MainDiffSurfaceProps {
  projectName: string;
  /** Scopes the diff navigation hotkeys to when the surface is visible. */
  active?: boolean;
}

const SURFACE_CLASS = "flex flex-col min-h-0 flex-1";

/**
 * Read-only diff/review surface for the project's main worktree. Mounts the
 * existing `DiffPanel` against the main-diff hook result with a `main` target
 * label and no git-mutation controls (commit/discard/reset are never mounted —
 * PLC-44). Shows a no-changes empty state when the worktree is clean, and the
 * same state when the upstream diff endpoint is unavailable (hook → null).
 */
export default function MainDiffSurface({
  projectName,
  active = true,
}: MainDiffSurfaceProps): React.JSX.Element {
  const diffQuery = useMainWorktreeDiffQuery(projectName);

  if (diffQuery.isPending) {
    return (
      <div className={SURFACE_CLASS}>
        <EmptyState layoutClassName="grow">
          <EmptyStateTitle>Loading diff…</EmptyStateTitle>
        </EmptyState>
      </div>
    );
  }

  const diff = diffQuery.data;
  const hasChanges = diff != null && diff.files.length > 0;

  if (!hasChanges) {
    return (
      <div className={SURFACE_CLASS}>
        <EmptyState layoutClassName="grow">
          <EmptyStateTitle>No changes</EmptyStateTitle>
          <EmptyStateDesc>
            The main worktree has no uncommitted changes.
          </EmptyStateDesc>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={SURFACE_CLASS}>
      <DiffPanel
        diff={diff}
        projectName={projectName}
        targetBranch="main"
        hotkeysEnabled={active}
      />
    </div>
  );
}
