"use client";

import { Suspense, useMemo } from "react";
import { useSearchParams } from "next/navigation";

import Topbar from "@/components/Topbar";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { useProjectsQuery } from "@/lib/projects/queries";
import { useSpecInventoryQuery } from "@/lib/specs/queries";
import SpecsInventory from "./SpecsInventory";

export default function SpecsPage(): React.JSX.Element {
  return (
    <Suspense>
      <SpecsPageInner />
    </Suspense>
  );
}

function SpecsPageInner(): React.JSX.Element {
  const searchParams = useSearchParams();
  const projectsQuery = useProjectsQuery();
  const projects = useMemo(
    () =>
      [...(projectsQuery.data ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    [projectsQuery.data],
  );
  const requestedProject = searchParams.get("project");
  const selectedProject =
    projects.find((project) => project.name === requestedProject)?.name ??
    projects[0]?.name ??
    "";
  const inventoryQuery = useSpecInventoryQuery(selectedProject);
  const specs = inventoryQuery.data?.specs ?? [];
  const pendingApprovalCount = specs.reduce(
    (total, item) => total + item.pendingApprovalCount,
    0,
  );
  const executingCount = specs.filter(
    (item) => item.phase.primary === "executing",
  ).length;

  return (
    <div className="app" data-page="specs">
      <Topbar
        page="specs"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          ...(selectedProject === ""
            ? []
            : [
                {
                  label: selectedProject,
                  href: `/projects/${encodeURIComponent(selectedProject)}`,
                  isProject: true,
                },
              ]),
          { label: "specs" },
        ]}
      />
      <main className="main">
        <div className="flex min-h-[44px] items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-dim px-xl py-sm max-768:flex-wrap max-768:px-md">
          <div className="flex min-w-0 flex-1 items-center gap-sm">
            <h1 className="m-0 font-display text-[1.05rem] leading-[1.05] font-extrabold whitespace-nowrap text-text-primary">
              specs{" "}
              <span className="text-cyan [text-shadow:0_0_24px_var(--cyan-glow-text)]">
                ·
              </span>
            </h1>
            {inventoryQuery.isSuccess && (
              <div
                role="status"
                aria-label="Spec inventory summary"
                className="flex min-w-0 items-center gap-sm max-768:hidden"
              >
                <span className="font-mono text-[0.72rem] whitespace-nowrap text-text-tertiary">
                  {specs.length} spec{specs.length === 1 ? "" : "s"}
                </span>
                {pendingApprovalCount > 0 && (
                  <>
                    <span className="font-mono text-[0.72rem] text-text-tertiary">
                      ·
                    </span>
                    <StatusChip
                      tone="neutral"
                      icon={
                        <span
                          aria-hidden="true"
                          className="size-[6px] rounded-full bg-amber [box-shadow:0_0_6px_var(--amber-glow)]"
                        />
                      }
                    >
                      <span className="text-text-secondary">
                        {pendingApprovalCount} approvals pending
                      </span>
                    </StatusChip>
                  </>
                )}
                {executingCount > 0 && (
                  <>
                    <span className="font-mono text-[0.72rem] text-text-tertiary">
                      ·
                    </span>
                    <StatusChip
                      tone="neutral"
                      icon={
                        <span
                          aria-hidden="true"
                          className="size-[6px] rounded-full bg-cyan [box-shadow:0_0_6px_var(--cyan-glow)]"
                        />
                      }
                    >
                      <span className="text-text-secondary">
                        {executingCount} executing
                      </span>
                    </StatusChip>
                  </>
                )}
              </div>
            )}
          </div>
          <p className="m-0 font-mono text-[0.72rem] whitespace-nowrap text-text-tertiary max-768:hidden">
            <span>start one:</span>{" "}
            <span className="text-text-secondary">/spec</span>{" "}
            <span>in any conversation</span>
          </p>
        </div>

        {projectsQuery.isPending ||
        (selectedProject !== "" && inventoryQuery.isPending) ? (
          <div className="px-xl py-lg font-mono text-[0.72rem] text-text-tertiary max-768:px-md">
            Loading specs…
          </div>
        ) : projectsQuery.isError || inventoryQuery.isError ? (
          <div role="alert" className="py-3xl">
            <EmptyState>
              <EmptyStateTitle>Couldn&apos;t load specs</EmptyStateTitle>
              <EmptyStateDesc>
                {projectsQuery.error instanceof Error
                  ? projectsQuery.error.message
                  : inventoryQuery.error instanceof Error
                    ? inventoryQuery.error.message
                    : "The Spec Studio inventory is unavailable."}
              </EmptyStateDesc>
            </EmptyState>
          </div>
        ) : selectedProject === "" ? (
          <EmptyState>
            <EmptyStateTitle>No projects configured</EmptyStateTitle>
            <EmptyStateDesc>
              Add a project before creating a spec.
            </EmptyStateDesc>
          </EmptyState>
        ) : (
          <SpecsInventory specs={specs} projectName={selectedProject} />
        )}
      </main>
    </div>
  );
}
