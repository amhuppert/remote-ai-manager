"use client";

import "./styles/projects-index.css";
import { useState, useMemo, useCallback } from "react";
import Topbar from "@/components/Topbar";
import ConfirmDialog from "@/components/ConfirmDialog";
import ProjectCard from "./components/ProjectCard";
import type { DiscoveredProject } from "@/lib/projects/schemas";
import { useConfigQuery } from "@/lib/config/queries";
import {
  useProjectsQuery,
  useProjectPreferencesQuery,
} from "@/lib/projects/queries";
import {
  useArchiveProjectMutation,
  useDeleteProjectMutation,
  usePinProjectMutation,
} from "@/lib/projects/mutations";
import {
  useStatusFilter,
  useShowArchivedProjects,
  useOpenMenuId,
  useFilterByStatus,
  useToggleArchivedProjects,
  useOpenProjectMenu,
  useCloseProjectMenu,
} from "@/stores/projects.store";

export default function ProjectsIndexPage(): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DiscoveredProject | null>(
    null,
  );

  // --- TanStack Query ---
  const projectsQuery = useProjectsQuery();
  const prefsQuery = useProjectPreferencesQuery();
  const configQuery = useConfigQuery();

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
  const deleteMutation = useDeleteProjectMutation();

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
      active: nonArchived.filter((p) => p.activeSessions > 0).length,
      running: nonArchived.filter((p) => p.hasRunningSession).length,
      idle: nonArchived.filter((p) => p.activeSessions === 0).length,
    };
  }, [projects, archivedSet]);

  const archivedCount = useMemo(
    () => projects.filter((p) => archivedSet.has(p.path)).length,
    [projects, archivedSet],
  );

  const visiblePinnedProjects = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return projects.filter((p) => {
      if (!pinnedSet.has(p.path)) return false;
      const isArchived = archivedSet.has(p.path);
      if (isArchived && !showArchived) return false;
      if (query && !p.name.toLowerCase().includes(query)) return false;
      if (!isArchived && statusFilter !== "all") {
        if (statusFilter === "active" && p.activeSessions === 0) return false;
        if (statusFilter === "running" && !p.hasRunningSession) return false;
        if (statusFilter === "idle" && p.activeSessions > 0) return false;
      }
      return true;
    });
  }, [
    projects,
    pinnedSet,
    archivedSet,
    showArchived,
    searchQuery,
    statusFilter,
  ]);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return projects.filter((p) => {
      if (pinnedSet.has(p.path)) return false;
      const isArchived = archivedSet.has(p.path);
      if (isArchived && !showArchived) return false;
      if (query && !p.name.toLowerCase().includes(query)) return false;
      if (!isArchived && statusFilter !== "all") {
        if (statusFilter === "active" && p.activeSessions === 0) return false;
        if (statusFilter === "running" && !p.hasRunningSession) return false;
        if (statusFilter === "idle" && p.activeSessions > 0) return false;
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

  const handleDelete = useCallback(
    (project: DiscoveredProject) => {
      setDeleteTarget(project);
      closeProjectMenu();
    },
    [closeProjectMenu],
  );

  const confirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    deleteMutation.mutate(
      { projectName: deleteTarget.name, projectPath: deleteTarget.path },
      { onSettled: () => setDeleteTarget(null) },
    );
  }, [deleteTarget, deleteMutation]);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

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
          runningCount > 0 ? (
            <div className="status-indicator">
              <div className="status-dot warning" />
              {runningCount} session{runningCount !== 1 ? "s" : ""} running
            </div>
          ) : undefined
        }
      />
      <main className="main">
        <div className="page-header">
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

              <div className="cc-tabs">
                {(["all", "active", "running", "idle"] as const).map(
                  (filter) => (
                    <button
                      key={filter}
                      className={`cc-tab${statusFilter === filter ? " active" : ""}`}
                      onClick={() => filterByStatus(filter)}
                      type="button"
                    >
                      {filter}
                      <span className="cc-tab-count">{counts[filter]}</span>
                    </button>
                  ),
                )}
              </div>

              {archivedCount > 0 && (
                <button
                  className={`btn btn-sm btn-toggle${showArchived ? " active" : ""}`}
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
                  <div className="cc-section-header">
                    <span className="cc-section-label">Pinned</span>
                    <span className="cc-section-count">
                      ({visiblePinnedProjects.length})
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
                        onDelete={handleDelete}
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
                    onDelete={handleDelete}
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
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Project"
        message={
          deleteTarget
            ? `Permanently remove "${deleteTarget.name}" from Command Center? This deletes all sessions, worktrees, transcripts, notifications, and job records for this project. The project directory on disk and any git branches are preserved.`
            : ""
        }
        confirmLabel={deleteMutation.isPending ? "Deleting…" : "Delete"}
        danger
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
      />
    </div>
  );
}
