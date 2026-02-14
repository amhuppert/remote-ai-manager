"use client";

import Link from "next/link";
import type { DiscoveredProject } from "@/types";

interface ProjectCardProps {
  project: DiscoveredProject;
}

export default function ProjectCard({
  project,
}: ProjectCardProps): React.JSX.Element {
  const badgeClass =
    project.activeSessions > 0 ? "project-badge active" : "project-badge idle";
  const badgeText =
    project.activeSessions > 0 ? `${project.activeSessions} active` : "idle";

  return (
    <Link
      href={`/projects/${encodeURIComponent(project.name)}`}
      className="project-card"
    >
      <div className="project-card-header">
        <div className="project-name">{project.name}</div>
        <div className={badgeClass}>{badgeText}</div>
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
