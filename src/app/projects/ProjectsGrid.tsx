"use client";

import { useState, useMemo, useCallback } from "react";
import Topbar from "@/components/Topbar";
import ProjectCard from "./ProjectCard";
import {
  useProjectsQuery,
  useProjectPreferencesQuery,
  useConfigQuery,
  useHooksStatusQuery,
} from "@/lib/queries";
import {
  useArchiveProjectMutation,
  usePinProjectMutation,
} from "@/lib/mutations";
import {
  useStatusFilter,
  useShowArchivedProjects,
  useOpenMenuId,
  useFilterByStatus,
  useToggleArchivedProjects,
  useOpenProjectMenu,
  useCloseProjectMenu,
} from "@/stores/projects.store";

export default function ProjectsGrid(): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState("");

  // --- TanStack Query ---
  const projectsQuery = useProjectsQuery();
  const prefsQuery = useProjectPreferencesQuery();
  const configQuery = useConfigQuery();
  const hooksQuery = useHooksStatusQuery();

  // --- Zustand ---
  const statusFilter = useStatusFilter();
  const showArchived = useShowArchivedProjects();
  const openMenuId = useOpenMenuId();
  const filterByStatus = useFilterByStatus();
  const toggleArchived = useToggleArchivedProjects();
  const openProjectMenu = useOpenProjectMenu();
  const closeProjectMenu = useCloseProjectMenu();

  // --- Mutations ---
  const archiveMutation = useArchiveProjectMutation();
  const pinMutation = usePinProjectMutation();

  // --- Derived data ---
  const projects = useMemo(
    () => projectsQuery.data ?? [],
    [projectsQuery.data],
  );
  const archivedPaths = useMemo(
    () => prefsQuery.data?.archived ?? [],
    [prefsQuery.data?.archived],
  );
  const pinnedPaths = useMemo(
    () => prefsQuery.data?.pinned ?? [],
    [prefsQuery.data?.pinned],
  );
  const config = configQuery.data;
  const hooksStatus = hooksQuery.data;

  const archivedSet = useMemo(() => new Set(archivedPaths), [archivedPaths]);
  const pinnedSet = useMemo(() => new Set(pinnedPaths), [pinnedPaths]);

  const projectCount = projects.length;
  const subtitle = config
    ? `${config.baseDir} — ${projectCount} ${projectCount === 1 ? "repository" : "repositories"} discovered`
    : "";
  const runningCount = projects.filter((p) => p.hasRunningSession).length;

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

  const visiblePinnedProjects = useMemo(() => {
    return projects.filter((p) => {
      if (!pinnedSet.has(p.path)) return false;
      const isArchived = archivedSet.has(p.path);
      if (isArchived && !showArchived) return false;
      return true;
    });
  }, [projects, pinnedSet, archivedSet, showArchived]);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return projects.filter((p) => {
      if (pinnedSet.has(p.path)) return false;
      const isArchived = archivedSet.has(p.path);
      if (isArchived && !showArchived) return false;
      if (query && !p.name.toLowerCase().includes(query)) return false;
      if (!isArchived && statusFilter !== "all") {
        if (statusFilter === "active" && !p.hasRunningSession) return false;
        if (statusFilter === "idle" && p.hasRunningSession) return false;
      }
      return true;
    });
  }, [
    projects,
    pinnedSet,
    archivedSet,
    searchQuery,
    statusFilter,
    showArchived,
  ]);

  const handleArchive = useCallback(
    (projectPath: string) => {
      const isCurrentlyArchived = archivedSet.has(projectPath);
      const projectName = projectPath.split("/").pop() ?? "";
      archiveMutation.mutate({
        projectName,
        archived: !isCurrentlyArchived,
      });
      closeProjectMenu();
    },
    [archivedSet, archiveMutation, closeProjectMenu],
  );

  const handlePin = useCallback(
    (projectPath: string) => {
      const isCurrentlyPinned = pinnedSet.has(projectPath);
      const projectName = projectPath.split("/").pop() ?? "";
      pinMutation.mutate({
        projectName,
        pinned: !isCurrentlyPinned,
      });
      closeProjectMenu();
    },
    [pinnedSet, pinMutation, closeProjectMenu],
  );

  const handleMenuToggle = useCallback(
    (projectPath: string) => {
      if (openMenuId === projectPath) {
        closeProjectMenu();
      } else {
        openProjectMenu(projectPath);
      }
    },
    [openMenuId, openProjectMenu, closeProjectMenu],
  );

  const showPinnedSection = visiblePinnedProjects.length > 0;
  const isLoading =
    projectsQuery.isPending || prefsQuery.isPending || configQuery.isPending;

  return (
    <div className="app" data-page="projects">
      <Topbar
        page="projects"
        breadcrumbs={[{ label: "projects", href: "/projects" }]}
        globalStatus={
          hooksStatus ? (
            <>
              <div className="status-indicator">
                <div
                  className={`status-dot${hooksStatus.installed ? "" : " warning"}`}
                />
                {hooksStatus.installed ? "hooks active" : "hooks missing"}
              </div>
              {runningCount > 0 && (
                <div className="status-indicator">
                  <div className="status-dot warning" />
                  {runningCount} session{runningCount !== 1 ? "s" : ""} running
                </div>
              )}
            </>
          ) : undefined
        }
      />
      <main className="main">
        {hooksStatus && !hooksStatus.installed && (
          <div className="hooks-banner">
            <span className="banner-icon">&#9888;</span>
            <span className="banner-text">
              Claude Code hooks are not configured. Session transcripts and
              metadata will not be captured automatically.
              {!hooksStatus.hasUserPromptSubmit && !hooksStatus.hasStop
                ? " Both UserPromptSubmit and Stop hooks are missing."
                : !hooksStatus.hasUserPromptSubmit
                  ? " UserPromptSubmit hook is missing."
                  : " Stop hook is missing."}
            </span>
          </div>
        )}

        <div className="page-header stagger-in">
          <h1 className="page-title">
            Ground <span className="accent">Control</span>
          </h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>

        {isLoading ? (
          <div className="empty-state">
            <div className="empty-state-title">Loading projects...</div>
          </div>
        ) : projectCount > 0 ? (
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
                    onClick={() => filterByStatus(filter)}
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
                  onClick={toggleArchived}
                  type="button"
                >
                  Archived ({archivedCount})
                </button>
              )}
            </div>

            {showPinnedSection && (
              <>
                <div className="pinned-section">
                  <div className="pinned-section-header">
                    <span className="pinned-star">&#9733;</span>
                    <span>Pinned</span>
                    <span className="pinned-count">
                      {visiblePinnedProjects.length}
                    </span>
                  </div>
                  <div className="projects-grid stagger-in">
                    {visiblePinnedProjects.map((project) => (
                      <ProjectCard
                        key={project.path}
                        project={project}
                        archived={archivedSet.has(project.path)}
                        pinned={true}
                        menuOpen={openMenuId === project.path}
                        onMenuToggle={() => handleMenuToggle(project.path)}
                        onArchive={handleArchive}
                        onPin={handlePin}
                      />
                    ))}
                  </div>
                </div>
                {filteredProjects.length > 0 && (
                  <div className="pinned-separator" />
                )}
              </>
            )}

            {filteredProjects.length > 0 ? (
              <div className="projects-grid stagger-in">
                {filteredProjects.map((project) => (
                  <ProjectCard
                    key={project.path}
                    project={project}
                    archived={archivedSet.has(project.path)}
                    pinned={false}
                    menuOpen={openMenuId === project.path}
                    onMenuToggle={() => handleMenuToggle(project.path)}
                    onArchive={handleArchive}
                    onPin={handlePin}
                  />
                ))}
              </div>
            ) : !showPinnedSection ? (
              <div className="no-results">
                <div className="no-results-title">No projects match</div>
                <div className="no-results-desc">
                  Try adjusting your search or filters to find what you&apos;re
                  looking for.
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">&#128269;</div>
            <div className="empty-state-title">No projects discovered</div>
            <div className="empty-state-desc">
              No git repositories found
              {config ? ` in ${config.baseDir}` : ""}. Ensure the base directory
              is configured correctly and contains repositories.
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
