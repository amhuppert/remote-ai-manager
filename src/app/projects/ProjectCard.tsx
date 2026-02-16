"use client";

import Link from "next/link";
import type { DiscoveredProject } from "@/types";
import CardContextMenu from "@/components/CardContextMenu";

interface ProjectCardProps {
  project: DiscoveredProject;
  archived: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onArchive: (projectPath: string) => void;
}

export default function ProjectCard({
  project,
  archived,
  menuOpen,
  onMenuToggle,
  onArchive,
}: ProjectCardProps): React.JSX.Element {
  const badgeClass =
    project.activeSessions > 0 ? "project-badge active" : "project-badge idle";
  const badgeText =
    project.activeSessions > 0 ? `${project.activeSessions} active` : "idle";

  const menuItems = [
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
