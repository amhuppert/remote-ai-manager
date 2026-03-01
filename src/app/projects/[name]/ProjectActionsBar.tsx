"use client";

interface ProjectActionsBarProps {
  archivedCount: number;
  showArchived: boolean;
  onToggleArchived: () => void;
  onInstallPreset: () => void;
  onQuickTask: () => void;
  onNewSession: () => void;
}

export default function ProjectActionsBar({
  archivedCount,
  showArchived,
  onToggleArchived,
  onInstallPreset,
  onQuickTask,
  onNewSession,
}: ProjectActionsBarProps): React.JSX.Element {
  return (
    <div className="project-actions-bar">
      <div className="project-actions-secondary">
        {archivedCount > 0 && (
          <button
            className={`btn btn-sm btn-toggle${showArchived ? " active" : ""}`}
            onClick={onToggleArchived}
            type="button"
          >
            Archived ({archivedCount})
          </button>
        )}
        <button className="btn btn-sm" onClick={onInstallPreset}>
          Install Preset
        </button>
        <button className="btn btn-sm" onClick={onQuickTask}>
          Quick Task
        </button>
      </div>
      <button
        className="btn btn-primary btn-sm project-actions-primary"
        onClick={onNewSession}
      >
        <span className="btn-icon">+</span> New Session
      </button>
    </div>
  );
}
