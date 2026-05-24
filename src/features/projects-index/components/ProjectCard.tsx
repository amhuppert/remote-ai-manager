"use client";

import Link from "next/link";
import type { DiscoveredProject } from "@/lib/projects/schemas";
import CardContextMenu, {
  type ContextMenuItem,
} from "@/components/CardContextMenu";

interface ProjectCardProps {
  project: DiscoveredProject;
  archived: boolean;
  pinned: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onArchive: (projectPath: string) => void;
  onPin: (projectPath: string) => void;
  onDelete: (project: DiscoveredProject) => void;
}

export default function ProjectCard({
  project,
  archived,
  pinned,
  menuOpen,
  onMenuToggle,
  onArchive,
  onPin,
  onDelete,
}: ProjectCardProps): React.JSX.Element {
  const missing = project.missing === true;
  const badgeStatus = project.hasRunningSession
    ? "running"
    : project.activeSessions > 0
      ? "active"
      : "idle";
  const badgeText = project.hasRunningSession
    ? "running"
    : project.activeSessions > 0
      ? `${project.activeSessions} session${project.activeSessions === 1 ? "" : "s"}`
      : "idle";
  const cardActivityClass = project.hasRunningSession
    ? " active"
    : project.activeSessions > 0
      ? " has-sessions"
      : " idle";

  const menuItems: ContextMenuItem[] = [];
  if (!missing) {
    menuItems.push({
      label: pinned ? "Unpin Project" : "Pin Project",
      onAction: () => onPin(project.path),
    });
    menuItems.push({
      label: archived ? "Unarchive Project" : "Archive Project",
      onAction: () => onArchive(project.path),
    });
  }
  menuItems.push({
    label: "Delete Project",
    danger: true,
    onAction: () => onDelete(project),
  });

  const className = `project-card${archived ? " archived" : ""}${pinned ? " pinned" : ""}${cardActivityClass}${missing ? " missing" : ""}`;

  const body = (
    <>
      <div className="project-card-header">
        <div className="project-name">{project.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {!missing && (
            <button
              className={`pin-toggle-btn${pinned ? " is-pinned" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onPin(project.path);
              }}
              title={pinned ? "Unpin project" : "Pin project"}
              type="button"
            >
              <span className="pin-icon">{pinned ? "\u2605" : "\u2606"}</span>
            </button>
          )}
          {missing ? (
            <span className="cc-badge cc-badge--status" data-status="missing">
              missing
            </span>
          ) : archived ? (
            <span className="cc-badge cc-badge--status" data-status="idle">
              archived
            </span>
          ) : (
            <span
              className="cc-badge cc-badge--status"
              data-status={badgeStatus}
            >
              {badgeText}
            </span>
          )}
          <CardContextMenu
            items={menuItems}
            open={menuOpen}
            onToggle={onMenuToggle}
          />
        </div>
      </div>
      <div className="project-path">{project.path}</div>
      <div className="project-stats">
        <div className="stat">
          <span className="stat-value">{project.activeSessions}</span>
          <span className="stat-label">Sessions</span>
        </div>
        <div className="stat">
          <span className="stat-value">0</span>
          <span className="stat-label">Prompts</span>
        </div>
        <div className="stat">
          <span className="stat-value stat-value--empty">&mdash;</span>
          <span className="stat-label">Last active</span>
        </div>
      </div>
    </>
  );

  if (missing) {
    return <div className={className}>{body}</div>;
  }

  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      className={className}
    >
      {body}
    </Link>
  );
}
