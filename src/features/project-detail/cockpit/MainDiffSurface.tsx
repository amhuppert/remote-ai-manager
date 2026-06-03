"use client";

import DiffPanel from "@/features/session/git/DiffPanel";
import { useMainWorktreeDiffQuery } from "@/lib/git/queries";
import "./styles/cockpit.css";

export interface MainDiffSurfaceProps {
  projectName: string;
  /** Scopes the diff navigation hotkeys to when the surface is visible. */
  active?: boolean;
}

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
      <div className="plc-diff">
        <div className="plc-diff-empty empty-state">
          <div className="empty-state-title">Loading diff…</div>
        </div>
      </div>
    );
  }

  const diff = diffQuery.data;
  const hasChanges = diff != null && diff.files.length > 0;

  if (!hasChanges) {
    return (
      <div className="plc-diff">
        <div className="plc-diff-empty empty-state">
          <div className="empty-state-title">No changes</div>
          <div className="empty-state-desc">
            The main worktree has no uncommitted changes.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="plc-diff">
      <DiffPanel
        diff={diff}
        projectName={projectName}
        targetBranch="main"
        hotkeysEnabled={active}
      />
    </div>
  );
}
