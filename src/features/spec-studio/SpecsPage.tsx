"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import Topbar from "@/components/Topbar";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import { useProjectsQuery } from "@/lib/projects/queries";
import {
  useSpecInventoryQuery,
  type SpecSummaryView,
} from "@/lib/specs/queries";
import { phaseLabels, phaseTones } from "./presentation";

export default function SpecsPage(): React.JSX.Element {
  return (
    <Suspense>
      <SpecsPageInner />
    </Suspense>
  );
}

function SpecsPageInner(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectsQuery = useProjectsQuery();
  const [selectedOverride, setSelectedOverride] = useState<string | null>(null);
  const projects = useMemo(
    () =>
      [...(projectsQuery.data ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    [projectsQuery.data],
  );
  const requestedProject = searchParams.get("project");
  const selectedProject =
    selectedOverride ??
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

  const selectProject = (projectName: string): void => {
    setSelectedOverride(projectName);
    const params = new URLSearchParams();
    params.set("project", projectName);
    router.replace(`/specs?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="app" data-page="specs">
      <Topbar page="specs" breadcrumbs={[{ label: "specs" }]} />
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
              <div className="flex min-w-0 items-center gap-sm max-768:hidden">
                <span className="font-mono text-[0.72rem] whitespace-nowrap text-text-tertiary">
                  {specs.length} spec{specs.length === 1 ? "" : "s"}
                </span>
                {pendingApprovalCount > 0 && (
                  <StatusChip tone="amber">
                    {pendingApprovalCount} approvals pending
                  </StatusChip>
                )}
                {executingCount > 0 && (
                  <StatusChip tone="cyan">
                    {executingCount} executing
                  </StatusChip>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-sm">
            <span className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase max-768:hidden">
              Project
            </span>
            <Select
              value={selectedProject}
              onValueChange={selectProject}
              disabled={projectsQuery.isPending || projects.length === 0}
            >
              <SelectTrigger
                aria-label="Project"
                layoutClassName="min-w-[190px]"
              >
                <SelectValue placeholder="Select project" />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.path} value={project.name}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
        ) : specs.length === 0 ? (
          <EmptyState>
            <EmptyStateTitle>No specs in this project</EmptyStateTitle>
            <EmptyStateDesc>
              Run /spec in a project or session conversation to start one.
            </EmptyStateDesc>
          </EmptyState>
        ) : (
          <div
            role="list"
            aria-label="Specs"
            className="grid gap-sm px-xl py-lg max-768:px-md"
          >
            {specs.map((item) => (
              <SpecListRow
                key={item.spec.id}
                item={item}
                projectName={selectedProject}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function SpecListRow({
  item,
  projectName,
}: {
  item: SpecSummaryView;
  projectName: string;
}): React.JSX.Element {
  const { spec, phase, delivery, linkedWork } = item;
  const linkedRollups = [
    countLabel(linkedWork.tickets, "ticket"),
    countLabel(linkedWork.conversations, "conversation"),
    countLabel(linkedWork.sessions, "session"),
    countLabel(linkedWork.workflowExecutions, "workflow"),
    countLabel(linkedWork.mergeJobs, "merge job"),
  ].filter((label): label is string => label !== null);
  const partialDelivery =
    delivery.provenCount > 0 && delivery.provenCount < delivery.totalInScope;

  return (
    <Link
      href={`/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(spec.slug)}`}
      role="listitem"
      data-testid={`spec-row-${spec.slug}`}
      className="grid grid-cols-[minmax(180px,1.2fr)_minmax(180px,1fr)_minmax(180px,1fr)] items-center gap-lg rounded-lg border border-solid border-border-subtle bg-bg-surface px-lg py-md font-mono no-underline transition-[background,border-color] duration-150 hover:border-border-strong hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-900:grid-cols-1 max-900:gap-sm"
    >
      <span className="min-w-0">
        <span className="block overflow-hidden text-[0.82rem] font-semibold text-ellipsis whitespace-nowrap text-text-primary">
          {spec.name}
        </span>
        <span className="mt-xs block text-[0.7rem] text-text-tertiary">
          {spec.slug} · {item.counts.requirements} requirements ·{" "}
          {item.counts.tasks} tasks
        </span>
      </span>

      <span className="flex min-w-0 flex-wrap items-center gap-xs">
        <StatusChip tone={phaseTones[phase.primary]}>
          {phaseLabels[phase.primary]}
        </StatusChip>
        {phase.authoringFacet !== undefined && (
          <StatusChip tone={phaseTones[phase.authoringFacet]}>
            {phaseLabels[phase.authoringFacet]}
          </StatusChip>
        )}
        {item.pendingApprovalCount > 0 && (
          <StatusChip tone="amber">
            {item.pendingApprovalCount} pending
          </StatusChip>
        )}
        {partialDelivery && (
          <StatusChip tone="green">
            {delivery.provenCount}/{delivery.totalInScope} delivered
          </StatusChip>
        )}
        {delivery.allWaived && (
          <StatusChip tone="amber">All delivery waived</StatusChip>
        )}
      </span>

      <span className="flex min-w-0 flex-wrap items-center justify-end gap-xs max-900:justify-start">
        {linkedRollups.length === 0 ? (
          <span className="text-[0.7rem] text-text-tertiary">
            No linked work
          </span>
        ) : (
          linkedRollups.map((label) => (
            <StatusChip key={label} tone="neutral">
              {label}
            </StatusChip>
          ))
        )}
      </span>
    </Link>
  );
}

function countLabel(count: number, noun: string): string | null {
  if (count === 0) return null;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
