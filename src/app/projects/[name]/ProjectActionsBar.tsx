"use client";

import Link from "next/link";
import ScopedAgentCapabilitiesConfig from "@/components/agent-capabilities/ScopedAgentCapabilitiesConfig";

interface ProjectActionsBarProps {
  projectName: string;
  archivedCount: number;
  showArchived: boolean;
  onToggleArchived: () => void;
  onInstallPreset: () => void;
  onQuickTask: () => void;
  onNewSession: () => void;
}

export default function ProjectActionsBar({
  projectName,
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
        <ScopedAgentCapabilitiesConfig
          level="project"
          projectName={projectName}
          className="btn btn-sm cap-trigger"
        />
        <Link
          className="btn btn-sm"
          href={`/projects/${encodeURIComponent(projectName)}/workflows`}
        >
          Workflow Builder
        </Link>
      </div>
      <button
        className="btn btn-primary btn-sm project-actions-primary"
        onClick={() => onNewSession()}
      >
        <span className="btn-icon">+</span> New Session
      </button>
    </div>
  );
}
