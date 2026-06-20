"use client";

import { useState, useMemo, useCallback } from "react";
import { cn } from "@/lib/ui/cn";
import Topbar from "@/components/Topbar";
import ConfirmDialog from "@/components/ConfirmDialog";
import { Tabs, Tab, TabCount } from "@/components/ui/Tabs";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import { StatusDot } from "@/components/ui/StatusDot";
import {
  SectionHeader,
  SectionLabel,
  SectionCount,
} from "@/components/ui/SectionHeader";
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

// Parity reproduction of legacy `.btn.btn-sm.btn-toggle` (globals.css). No
// `<Button>` variant matches the toggle appearance, and appearance utilities are
// forbidden in the primitive's `layoutClassName`
// (tailwind-guardrails/no-appearance-in-layout-classname), so this control is a
// plain utility-only `<button>`. `TOGGLE_BOX` mirrors the `.btn` + `.btn-sm`
// invariant box, including the `@media (max-width: 768px) .btn-sm` touch override
// (min-height 44px + padding 10px 16px) folded as `max-768:` variants. The two
// state maps are mutually exclusive (only one is applied), avoiding any
// same-property conflict. The active border + active-hover background reuse
// `--color-cyan-glow-strong`, exactly the legacy `rgba(0,229,255,0.3)` /
// `--cyan-glow-strong` literal.
const TOGGLE_BOX =
  "inline-flex items-center gap-sm rounded-md border border-solid px-[12px] py-[6px] font-mono text-[0.72rem] font-medium transition-all duration-150 ease-[ease] max-768:min-h-[44px] max-768:px-[16px] max-768:py-[10px]";
const TOGGLE_INACTIVE =
  "bg-transparent border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary hover:border-border-strong";
const TOGGLE_ACTIVE =
  "bg-cyan-glow border-[var(--color-cyan-glow-strong)] text-cyan hover:bg-[var(--color-cyan-glow-strong)]";

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
            <div className="flex items-center gap-[6px] font-mono text-[0.72rem] font-medium tracking-[0.06em] text-text-secondary uppercase">
              <StatusDot tone="warning" />
              {runningCount} session{runningCount !== 1 ? "s" : ""} running
            </div>
          ) : undefined
        }
      />
      <main className="main">
        <div className="mb-2xl max-768:mb-lg">
          <h1 className="mb-sm font-display text-[2.4rem] leading-[1.1] font-extrabold tracking-[-0.03em] text-text-primary max-768:text-[1.6rem]">
            Ground{" "}
            <span className="text-cyan [text-shadow:0_0_30px_var(--cyan-glow-text)]">
              Control
            </span>
          </h1>
          {subtitle && (
            <p className="font-mono text-[0.82rem] font-normal text-text-secondary">
              {subtitle}
            </p>
          )}
        </div>

        {isLoading ? (
          <EmptyState>
            <EmptyStateTitle>Loading projects...</EmptyStateTitle>
          </EmptyState>
        ) : projectCount > 0 ? (
          <>
            <div className="mb-lg flex flex-wrap items-center gap-md">
              <div className="relative max-w-[360px] min-w-[200px] flex-1">
                <input
                  type="text"
                  className="w-full rounded-md border border-solid border-border-default bg-bg-surface py-[8px] pr-[32px] pl-[12px] font-mono text-[0.78rem] text-text-primary transition-all duration-150 ease-[ease] outline-none placeholder:text-text-tertiary focus:border-cyan-dim focus:shadow-[0_0_0_3px_var(--cyan-glow)]"
                  placeholder="Search projects..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    className="absolute top-1/2 right-[6px] flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent p-0 text-[0.75rem] text-text-tertiary transition-all duration-100 ease-[ease] hover:bg-bg-hover hover:text-text-secondary"
                    onClick={() => setSearchQuery("")}
                    type="button"
                    aria-label="Clear search"
                  >
                    &#10005;
                  </button>
                )}
              </div>

              <Tabs>
                {(["all", "active", "running", "idle"] as const).map(
                  (filter) => (
                    <Tab
                      key={filter}
                      active={statusFilter === filter}
                      onClick={() => filterByStatus(filter)}
                      type="button"
                    >
                      {filter}
                      <TabCount active={statusFilter === filter}>
                        {counts[filter]}
                      </TabCount>
                    </Tab>
                  ),
                )}
              </Tabs>

              {archivedCount > 0 && (
                <button
                  className={cn(
                    TOGGLE_BOX,
                    showArchived ? TOGGLE_ACTIVE : TOGGLE_INACTIVE,
                  )}
                  onClick={toggleArchived}
                  type="button"
                >
                  Archived ({archivedCount})
                </button>
              )}
            </div>

            {showPinnedSection && (
              <>
                <div className="mb-section">
                  <SectionHeader>
                    <SectionLabel>Pinned</SectionLabel>
                    <SectionCount>
                      ({visiblePinnedProjects.length})
                    </SectionCount>
                  </SectionHeader>
                  <div className="stagger-in grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-md max-900:grid-cols-1">
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
                  <div className="relative my-[var(--space-xl)] h-px bg-[linear-gradient(90deg,transparent,var(--border-default),var(--border-strong),var(--border-default),transparent)] before:absolute before:inset-x-0 before:-top-px before:h-[3px] before:bg-[linear-gradient(90deg,transparent,var(--cc-amber-a12),var(--cc-cyan-a08),transparent)] before:[filter:blur(2px)] before:content-['']" />
                )}
              </>
            )}

            {filteredProjects.length > 0 ? (
              <div className="stagger-in grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-md max-900:grid-cols-1">
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
              <div className="flex flex-col items-center justify-center px-xl py-3xl text-center">
                <div className="mb-sm font-display text-[1rem] font-bold text-text-secondary">
                  No projects match
                </div>
                <div className="max-w-[320px] font-mono text-[0.75rem] text-text-tertiary">
                  Try adjusting your search or filters to find what you&apos;re
                  looking for.
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyState>
            <EmptyStateIcon>&#128269;</EmptyStateIcon>
            <EmptyStateTitle>No projects discovered</EmptyStateTitle>
            <EmptyStateDesc>
              No git repositories found
              {config ? ` in ${config.baseDir}` : ""}. Ensure the base directory
              is configured correctly and contains repositories.
            </EmptyStateDesc>
          </EmptyState>
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
