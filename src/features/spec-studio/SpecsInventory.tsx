"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { KebabIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import { IconButton } from "@/components/ui/IconButton";
import { StatusChip } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import {
  buildSpecReadCommand,
  buildSpecReferenceXml,
} from "@/lib/prompt-editor/spec-reference-contract";
import type { SpecPhasePrimary } from "@/lib/specs/phase";
import type { SpecSummaryView } from "@/lib/specs/queries";
import { cn } from "@/lib/ui/cn";

import { phaseLabels } from "./presentation";

const logger = createClientLogger("spec-studio-inventory");

const phaseFilters = [
  "draft",
  "approved",
  "executing",
  "delivered",
  "abandoned",
] as const satisfies readonly SpecPhasePrimary[];

export type SpecPhaseFilter = "all" | SpecPhasePrimary;

const phaseAccent: Record<SpecPhasePrimary, string> = {
  abandoned: "bg-red",
  executing: "bg-cyan",
  draft: "bg-text-tertiary",
  delivered: "bg-green",
  approved: "bg-green",
};

const phaseText: Record<SpecPhasePrimary, string> = {
  abandoned: "text-red",
  executing: "text-cyan",
  draft: "text-text-tertiary",
  delivered: "text-green",
  approved: "text-green",
};

const inventoryGrid =
  "grid grid-cols-[3px_190px_minmax(220px,1fr)_130px_110px_180px_70px_80px_44px] min-w-[1040px] items-center gap-x-sm max-768:grid-cols-[3px_minmax(0,1fr)_44px] max-768:min-w-0 max-768:gap-x-xs";

const updatedDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export default function SpecsInventory({
  specs,
  projectName,
  initialPhase = "all",
}: {
  specs: SpecSummaryView[];
  projectName: string;
  initialPhase?: SpecPhaseFilter;
}): React.JSX.Element {
  const [selectedPhase, setSelectedPhase] =
    useState<SpecPhaseFilter>(initialPhase);
  const phaseCounts = useMemo(
    () =>
      Object.fromEntries(
        phaseFilters.map((phase) => [
          phase,
          specs.filter((item) => item.phase.primary === phase).length,
        ]),
      ) as Record<SpecPhasePrimary, number>,
    [specs],
  );
  const filteredSpecs = useMemo(
    () =>
      selectedPhase === "all"
        ? specs
        : specs.filter((item) => item.phase.primary === selectedPhase),
    [selectedPhase, specs],
  );

  function selectPhase(phase: SpecPhaseFilter): void {
    setSelectedPhase(phase);
    logger.info("spec_studio.inventory.phase_filter_selected", {
      phase,
      resultCount:
        phase === "all"
          ? specs.length
          : specs.filter((item) => item.phase.primary === phase).length,
    });
  }

  if (specs.length === 0) {
    return (
      <EmptyState>
        <EmptyStateTitle>No specs in this project</EmptyStateTitle>
        <EmptyStateDesc>
          Run /spec in a project or session conversation to start one.
        </EmptyStateDesc>
      </EmptyState>
    );
  }

  return (
    <section
      aria-labelledby="spec-inventory-heading"
      className="pb-xl max-768:pb-lg"
    >
      <h2 id="spec-inventory-heading" className="sr-only">
        Spec inventory
      </h2>

      <div
        role="group"
        aria-label="Filter specs by phase"
        className="flex flex-wrap items-center gap-xs px-xl pt-[10px] pb-[2px] max-768:px-md"
      >
        <PhaseFilter
          label="All"
          count={specs.length}
          selected={selectedPhase === "all"}
          onSelect={() => selectPhase("all")}
        />
        {phaseFilters.map((phase) => (
          <PhaseFilter
            key={phase}
            label={phaseLabels[phase]}
            count={phaseCounts[phase]}
            selected={selectedPhase === phase}
            onSelect={() => selectPhase(phase)}
          />
        ))}
      </div>

      <div className="overflow-x-auto px-xl pt-xs max-768:px-md">
        <div role="table" aria-label="Specs" className="font-mono">
          <div role="rowgroup">
            <div
              role="row"
              className={cn(
                inventoryGrid,
                "border-x-0 border-t-0 border-b border-solid border-border-subtle py-[6px] max-768:hidden",
              )}
            >
              <span aria-hidden="true" />
              {[
                "Spec",
                "Name",
                "Phase",
                "Approvals",
                "Execution",
                "Tickets",
                "Updated",
                "Actions",
              ].map((heading) => (
                <div
                  key={heading}
                  role="columnheader"
                  className={cn(
                    "text-[0.65rem] font-medium tracking-[0.08em] text-text-tertiary uppercase",
                    heading === "Spec" && "pl-[13px]",
                    (heading === "Tickets" || heading === "Updated") &&
                      "text-right",
                    heading === "Actions" && "sr-only",
                  )}
                >
                  {heading}
                </div>
              ))}
            </div>
          </div>

          <div role="rowgroup">
            {filteredSpecs.map((item) => (
              <SpecInventoryRow
                key={item.spec.id}
                item={item}
                projectName={projectName}
              />
            ))}
          </div>
        </div>

        {filteredSpecs.length === 0 && (
          <div
            role="status"
            className="px-lg py-xl text-center font-mono text-[0.72rem] text-text-tertiary"
          >
            No {phaseLabels[selectedPhase as SpecPhasePrimary].toLowerCase()}{" "}
            specs
          </div>
        )}
      </div>
    </section>
  );
}

function PhaseFilter({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count: number;
  selected: boolean;
  onSelect(): void;
}): React.JSX.Element {
  return (
    <StatusChip
      as="button"
      tone={selected ? "cyan" : "neutral"}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className={cn("contents", !selected && "text-text-secondary")}>
        {label}{" "}
        <span aria-hidden="true" className="opacity-65">
          {count}
        </span>
        <span className="sr-only"> {count}</span>
      </span>
    </StatusChip>
  );
}

function SpecInventoryRow({
  item,
  projectName,
}: {
  item: SpecSummaryView;
  projectName: string;
}): React.JSX.Element {
  const { spec, phase, delivery, linkedWork } = item;
  const href = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(spec.slug)}`;
  // Any landed delivery gets the tally, not just a partial one: an import's
  // criteria are delivered on external testimony, and a row that showed the
  // count only while it was incomplete would go silent exactly when the whole
  // scope rests on that testimony.
  const showsDeliveryTally = delivery.deliveredCount > 0;
  const executionLabels = [
    countLabel(linkedWork.workflowExecutions, "workflow"),
    countLabel(linkedWork.mergeJobs, "merge job"),
  ].filter((label): label is string => label !== null);
  const linkedLabels = [
    countLabel(linkedWork.tickets, "ticket"),
    countLabel(linkedWork.conversations, "conversation"),
    countLabel(linkedWork.sessions, "session"),
  ].filter((label): label is string => label !== null);

  return (
    <div
      role="row"
      data-testid={`spec-row-${spec.slug}`}
      className={cn(
        inventoryGrid,
        "relative border-x-0 border-t-0 border-b border-solid border-border-subtle py-[9px] transition-colors duration-150 last:border-b-0 hover:bg-bg-base max-768:py-0",
      )}
    >
      <span
        aria-hidden="true"
        className="relative h-full w-[3px] self-stretch max-768:row-span-7 max-768:w-auto"
      >
        <span
          className={cn(
            "absolute top-[-9px] bottom-[-10px] left-0 w-[3px] max-768:inset-y-0",
            phaseAccent[phase.primary],
          )}
        />
      </span>

      <div
        role="cell"
        className="min-w-0 pl-[13px] max-768:col-start-2 max-768:row-start-1 max-768:py-md max-768:pr-xs"
      >
        <Link
          href={href}
          className="block overflow-hidden text-[0.8rem] font-semibold text-ellipsis whitespace-nowrap text-text-secondary no-underline hover:text-cyan focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          {spec.slug}
        </Link>
        {spec.gatePolicy.preset === "exploratory" && (
          <span className="ml-xs inline-flex rounded-full border border-dashed border-border-default px-[7px] py-[1px] text-[0.62rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
            Exploratory
          </span>
        )}
        {item.imported && (
          // Neutral, because this is provenance rather than a status: amber
          // means awaiting the user, and an imported spec asks for nothing.
          <StatusChip tone="neutral" layoutClassName="ml-xs">
            Imported
          </StatusChip>
        )}
      </div>

      <div role="cell" className="min-w-0 max-768:col-start-2 max-768:py-xs">
        <span className="block overflow-hidden text-[0.85rem] font-semibold text-ellipsis whitespace-nowrap text-text-primary">
          {spec.name}
        </span>
      </div>

      <div
        role="cell"
        className="flex min-w-0 flex-col items-start gap-[2px] max-768:col-start-2 max-768:py-xs"
      >
        <span
          aria-hidden="true"
          className="hidden text-[0.7rem] text-text-tertiary max-768:inline"
        >
          Phase
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-[6px] text-[0.7rem] font-semibold tracking-[0.06em] uppercase",
            phaseText[phase.primary],
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "h-[6px] w-[6px] shrink-0 rounded-full",
              phaseAccent[phase.primary],
            )}
          />
          {phaseLabels[phase.primary]}
        </span>
        {phase.authoringFacet !== undefined && (
          <span
            className={cn(
              "max-w-full overflow-hidden text-[0.62rem] text-ellipsis whitespace-nowrap",
              phaseText[phase.authoringFacet],
            )}
          >
            {phaseLabels[phase.authoringFacet]}
          </span>
        )}
        {phase.authoringStage !== undefined && (
          <span className="max-w-full overflow-hidden text-[0.62rem] text-ellipsis whitespace-nowrap text-text-tertiary">
            {phase.authoringStage} stage
          </span>
        )}
      </div>

      <div
        role="cell"
        className="flex min-w-0 items-center max-768:col-start-2 max-768:gap-xs max-768:py-xs"
      >
        <span
          aria-hidden="true"
          className="hidden text-[0.7rem] text-text-tertiary max-768:inline"
        >
          Approvals
        </span>
        {item.pendingApprovalCount > 0 ? (
          <StatusChip tone="amber">
            <span className="font-bold">
              {item.pendingApprovalCount} pending
            </span>
          </StatusChip>
        ) : (
          <span className="text-[0.7rem] text-text-tertiary">Complete</span>
        )}
      </div>

      <div
        role="cell"
        className="min-w-0 text-[0.7rem] text-text-secondary max-768:col-start-2 max-768:py-xs"
      >
        <span
          aria-hidden="true"
          className="mr-xs hidden text-text-tertiary max-768:inline"
        >
          Execution
        </span>
        <span className="block max-768:inline">
          {executionLabels.length > 0
            ? executionLabels.join(" · ")
            : "Not started"}
        </span>
        {showsDeliveryTally && (
          <span className="mt-xs block text-green max-768:mt-0 max-768:ml-xs max-768:inline">
            {delivery.deliveredCount}/{delivery.totalInScope} delivered
          </span>
        )}
        {delivery.allWaived && (
          <span className="mt-xs block text-amber max-768:mt-0 max-768:ml-xs max-768:inline">
            All delivery waived
          </span>
        )}
      </div>

      <div
        role="cell"
        className="min-w-0 text-right text-[0.7rem] text-text-secondary max-768:col-start-2 max-768:flex max-768:flex-wrap max-768:items-center max-768:py-xs max-768:text-left"
      >
        <span
          aria-hidden="true"
          className="mr-xs hidden text-text-tertiary max-768:inline"
        >
          Links
        </span>
        {linkedLabels.length > 0 ? (
          <span className="inline-flex flex-wrap justify-end gap-x-xs max-768:justify-start">
            {linkedLabels.map((label, index) => (
              <span key={label}>
                {index > 0 && (
                  <span aria-hidden="true" className="mr-xs text-text-tertiary">
                    ·
                  </span>
                )}
                <span>{label}</span>
              </span>
            ))}
          </span>
        ) : (
          <span>No linked work</span>
        )}
      </div>

      <div
        role="cell"
        title={spec.updatedAt}
        className="text-right text-[0.72rem] whitespace-nowrap text-text-secondary max-768:col-start-2 max-768:pt-xs max-768:pb-md max-768:text-left"
      >
        <span aria-hidden="true" className="mr-xs hidden max-768:inline">
          Updated
        </span>
        {updatedDate.format(new Date(spec.updatedAt))}
      </div>

      <div
        role="cell"
        className="flex items-center justify-center max-768:col-start-3 max-768:row-start-1 max-768:self-start"
      >
        <SpecRowActions item={item} projectName={projectName} href={href} />
      </div>
    </div>
  );
}

function SpecRowActions({
  item,
  projectName,
  href,
}: {
  item: SpecSummaryView;
  projectName: string;
  href: string;
}): React.JSX.Element {
  const copyReference = (): void => {
    const revision = item.currentRevision?.number;
    const value =
      revision === undefined
        ? buildSpecReadCommand(projectName, item.spec.slug)
        : buildSpecReferenceXml("spec", {
            projectName,
            slug: item.spec.slug,
            name: item.spec.name,
            revision: String(revision),
          });

    if (navigator.clipboard === undefined) {
      logger.warn("spec_studio.inventory.copy_unavailable", {
        specId: item.spec.id,
      });
      return;
    }

    void navigator.clipboard.writeText(value).then(
      () => {
        logger.info("spec_studio.inventory.reference_copied", {
          specId: item.spec.id,
          revision: revision ?? null,
        });
      },
      (error: unknown) => {
        logger.warn("spec_studio.inventory.copy_failed", {
          specId: item.spec.id,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          type="button"
          aria-label={`Actions for ${item.spec.slug}`}
          size="md"
        >
          <KebabIcon size={16} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={href}>Open spec</Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={copyReference}>
          Copy spec reference
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function countLabel(count: number, noun: string): string | null {
  if (count === 0) return null;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
