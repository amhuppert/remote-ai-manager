"use client";

import Link from "next/link";
import type { DiscoveredProject } from "@/types";
import CardContextMenu from "@/components/CardContextMenu";

interface ProjectCardProps {
  project: DiscoveredProject;
  archived: boolean;
  pinned: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onArchive: (projectPath: string) => void;
  onPin: (projectPath: string) => void;
}

export default function ProjectCard({
  project,
  archived,
  pinned,
  menuOpen,
  onMenuToggle,
  onArchive,
  onPin,
}: ProjectCardProps): React.JSX.Element {
  const badgeClass = project.hasRunningSession
    ? "project-badge active"
    : project.activeSessions > 0
      ? "project-badge has-sessions"
      : "project-badge idle";
  const badgeText = project.hasRunningSession
    ? "active"
    : project.activeSessions > 0
      ? `${project.activeSessions} session${project.activeSessions === 1 ? "" : "s"}`
      : "idle";

  const menuItems = [
    {
      label: pinned ? "Unpin Project" : "Pin Project",
      onAction: () => onPin(project.path),
    },
    {
      label: archived ? "Unarchive Project" : "Archive Project",
      onAction: () => onArchive(project.path),
    },
  ];

  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      className={`project-card${archived ? " archived" : ""}`}
    >
      <div className="project-card-header">
        <div className="project-name">{project.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {archived ? (
            <div className="project-badge archived-badge">archived</div>
          ) : (
            <div className={badgeClass}>{badgeText}</div>
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
          <span className="stat-value">&mdash;</span>
          <span className="stat-label">Prompts</span>
        </div>
        <div className="stat">
          <span className="stat-value">&mdash;</span>
          <span className="stat-label">Last active</span>
        </div>
      </div>
    </Link>
  );
}
