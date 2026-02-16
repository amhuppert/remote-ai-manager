"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { DiscoveredProject } from "@/types";
import ProjectCard from "./ProjectCard";

type StatusFilter = "all" | "active" | "idle";

interface ProjectsGridClientProps {
  projects: DiscoveredProject[];
  archivedPaths: string[];
}

export default function ProjectsGridClient({
  projects,
  archivedPaths,
}: ProjectsGridClientProps): React.JSX.Element {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  const archivedSet = useMemo(() => new Set(archivedPaths), [archivedPaths]);

  // Compute filter counts (exclude archived from counts)
  const counts = useMemo(() => {
    const nonArchived = projects.filter((p) => !archivedSet.has(p.path));
    return {
      all: nonArchived.length,
      active: nonArchived.filter((p) => p.hasRunningSession).length,
      idle: nonArchived.filter((p) => !p.hasRunningSession).length,
    };
  }, [projects, archivedSet]);

  const archivedCount = useMemo(
    () => projects.filter((p) => archivedSet.has(p.path)).length,
    [projects, archivedSet],
  );

  // Combined filter logic
  const filteredProjects = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return projects.filter((p) => {
      const isArchived = archivedSet.has(p.path);

      // Archive visibility
      if (isArchived && !showArchived) return false;

      // Search
      if (query && !p.name.toLowerCase().includes(query)) return false;

      // Status filter (only applies to non-archived)
      if (!isArchived && statusFilter !== "all") {
        if (statusFilter === "active" && !p.hasRunningSession) return false;
        if (statusFilter === "idle" && p.hasRunningSession) return false;
      }

      return true;
    });
  }, [projects, archivedSet, searchQuery, statusFilter, showArchived]);

  const handleArchive = useCallback(
    async (projectPath: string) => {
      const isCurrentlyArchived = archivedSet.has(projectPath);
      try {
        const projectName = projectPath.split("/").pop() ?? "";
        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectName)}/archive`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: !isCurrentlyArchived }),
          },
        );
        if (res.ok) {
          router.refresh();
        }
      } catch {
        // Silently fail — no optimistic update, UI stays as-is
      }
      setOpenMenuId(null);
    },
    [archivedSet, router],
  );

  const handleMenuToggle = useCallback(
    (projectPath: string) => {
      setOpenMenuId((current) =>
        current === projectPath ? null : projectPath,
      );
    },
    [],
  );

  return (
    <>
      <div className="projects-controls">
        <div className="search-wrapper">
          <input
            type="text"
            className="search-input"
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              className="search-clear"
              onClick={() => setSearchQuery("")}
              type="button"
              aria-label="Clear search"
            >
              &#10005;
            </button>
          )}
        </div>

        <div className="filter-pills">
          {(["all", "active", "idle"] as const).map((filter) => (
            <button
              key={filter}
              className={`filter-pill${statusFilter === filter ? " active" : ""}`}
              onClick={() => setStatusFilter(filter)}
              type="button"
            >
              {filter}
              <span className="filter-pill-count">{counts[filter]}</span>
            </button>
          ))}
        </div>

        {archivedCount > 0 && (
          <button
            className={`archive-toggle${showArchived ? " active" : ""}`}
            onClick={() => setShowArchived((v) => !v)}
            type="button"
          >
            Archived ({archivedCount})
          </button>
        )}
      </div>

      {filteredProjects.length > 0 ? (
        <div className="projects-grid stagger-in">
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.path}
              project={project}
              archived={archivedSet.has(project.path)}
              menuOpen={openMenuId === project.path}
              onMenuToggle={() => handleMenuToggle(project.path)}
              onArchive={handleArchive}
            />
          ))}
        </div>
      ) : (
        <div className="no-results">
          <div className="no-results-title">No projects match</div>
          <div className="no-results-desc">
            Try adjusting your search or filters to find what you&apos;re
            looking for.
          </div>
        </div>
      )}
    </>
  );
}
