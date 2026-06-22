"use client";

import { useState } from "react";
import type { MissingPrerequisite } from "@/lib/workflow-graph/preflight-prerequisite-service";
import type {
  TemplateLibraryItem,
  TemplateTier,
} from "@/lib/workflow-graph/template-library-service";
import type { WorkflowPrerequisite } from "@/lib/workflows/schemas";
import { Badge } from "@/components/ui/Badge";
import {
  EmptyState,
  EmptyStateDesc,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/EmptyState";
import WorkflowLaunchForm from "@/components/WorkflowLaunchForm";
import { cn } from "@/lib/ui/cn";

// The result of the most recent launch attempt for the selected template. These
// states are the binding contract (R7.4–R7.6); the engine produces them and the
// library reflects them without starting a run on any non-`started` outcome.
export type TemplateLaunchOutcome =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "started" } // R7.6
  | { status: "prerequisites_unmet"; missing: MissingPrerequisite[] } // R7.4
  | { status: "rejected"; reason: string }; // R7.5

export interface TemplateLibraryProps {
  /** Cross-tier, tier-tagged templates (global + project) — R7.1. */
  items: TemplateLibraryItem[];
  /** Emits the launch request for the selected template — R7.3. */
  onLaunch: (input: {
    id: string;
    tier: TemplateTier;
    parameters: Record<string, string>;
  }) => void;
  /** The launch result for the selected template — R7.4–R7.6. */
  launchOutcome?: TemplateLaunchOutcome;
  /** Controlled selection; when omitted, selection is managed internally. */
  selectedTemplateId?: string | null;
  /** Notified when the selected template changes. */
  onSelectTemplate?: (id: string | null) => void;
}

const tierLabel: Record<TemplateTier, string> = {
  global: "Global",
  project: "Project",
};

// A human-facing phrase for a probe outcome reason: a definitively-absent
// prerequisite reads differently from one whose probe could not be evaluated
// (R5.10 / R7.4 — the two reasons must be distinguishable to the launcher).
const reasonLabel: Record<MissingPrerequisite["reason"], string> = {
  absent: "missing",
  probe_error: "could not be evaluated",
};

function PrerequisiteRow({
  prerequisite,
}: {
  prerequisite: WorkflowPrerequisite;
}): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-xs font-mono text-[0.76rem] text-text-secondary">
      <Badge tier="type" kind="idea" layoutClassName="shrink-0">
        {prerequisite.kind}
      </Badge>
      <code className="text-text-primary">
        {prerequisite.kind === "path" ? prerequisite.path : prerequisite.skill}
      </code>
      {prerequisite.kind === "skill" && prerequisite.backend && (
        <Badge backend={prerequisite.backend} layoutClassName="shrink-0">
          {prerequisite.backend}
        </Badge>
      )}
      {prerequisite.label && (
        <span className="text-text-tertiary">— {prerequisite.label}</span>
      )}
    </li>
  );
}

function PrerequisiteList({
  prerequisites,
}: {
  prerequisites: WorkflowPrerequisite[];
}): React.JSX.Element {
  if (prerequisites.length === 0) {
    return (
      <p className="font-mono text-[0.76rem] text-text-tertiary">
        No prerequisites.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-xs">
      {prerequisites.map((prerequisite, index) => (
        <PrerequisiteRow
          // Prerequisites are an ordered, append-only display list with no
          // stable id; the index is the only stable key here.
          key={`${prerequisite.kind}-${index}`}
          prerequisite={prerequisite}
        />
      ))}
    </ul>
  );
}

function MissingPrerequisiteRow({
  missing,
}: {
  missing: MissingPrerequisite;
}): React.JSX.Element {
  const identifier = missing.kind === "path" ? missing.path : missing.skill;
  return (
    <li className="flex flex-wrap items-center gap-xs font-mono text-[0.76rem] text-text-secondary">
      <Badge tier="type" kind="bug" layoutClassName="shrink-0">
        {missing.kind}
      </Badge>
      <code className="text-text-primary">{identifier}</code>
      {missing.kind === "skill" && missing.backend && (
        <Badge backend={missing.backend} layoutClassName="shrink-0">
          {missing.backend}
        </Badge>
      )}
      <span className="text-amber">{reasonLabel[missing.reason]}</span>
      {missing.label && (
        <span className="text-text-tertiary">— {missing.label}</span>
      )}
    </li>
  );
}

// A bordered banner reflecting the launch outcome. `prerequisites_unmet` and
// `rejected` both reflect that the run did not start (R7.4/R7.5); `started`
// reflects a successful start (R7.6).
function LaunchOutcomeBanner({
  outcome,
}: {
  outcome: TemplateLaunchOutcome;
}): React.JSX.Element | null {
  if (outcome.status === "idle" || outcome.status === "starting") return null;

  if (outcome.status === "started") {
    return (
      <div
        role="status"
        className="flex flex-col gap-xs rounded-md border border-solid border-green-dim bg-green-glow p-sm font-mono text-[0.78rem] text-green"
      >
        <span className="font-semibold">Workflow started.</span>
      </div>
    );
  }

  const tone =
    outcome.status === "prerequisites_unmet"
      ? "border-amber-dim bg-amber-glow"
      : "border-red-dim bg-red-glow";

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col gap-sm rounded-md border border-solid p-sm",
        tone,
      )}
    >
      <span className="font-mono text-[0.78rem] font-semibold text-text-primary">
        {outcome.status === "prerequisites_unmet"
          ? "Prerequisites not met — the run did not start."
          : "Launch rejected — the run did not start."}
      </span>
      {outcome.status === "prerequisites_unmet" ? (
        <ul className="flex flex-col gap-xs">
          {outcome.missing.map((missing, index) => (
            <MissingPrerequisiteRow
              key={`${missing.kind}-${index}`}
              missing={missing}
            />
          ))}
        </ul>
      ) : (
        <p className="font-mono text-[0.78rem] text-text-secondary">
          {outcome.reason}
        </p>
      )}
    </div>
  );
}

function TemplateRow({
  item,
  selected,
  onSelect,
}: {
  item: TemplateLibraryItem;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full flex-col items-start gap-xs rounded-md border border-solid bg-bg-surface p-sm text-left transition-[border-color,background-color] duration-150 ease-[ease] hover:border-border-strong",
          selected ? "border-cyan bg-bg-raised" : "border-border-dim",
        )}
      >
        <span className="flex w-full items-center gap-sm">
          <Badge
            tier="type"
            kind={item.tier === "global" ? "feature" : "idea"}
            layoutClassName="shrink-0"
          >
            {tierLabel[item.tier]}
          </Badge>
          <span className="font-display text-[0.92rem] font-semibold text-text-primary">
            {item.name}
          </span>
        </span>
        {item.description && (
          <span className="font-mono text-[0.74rem] text-text-tertiary">
            {item.description}
          </span>
        )}
      </button>
    </li>
  );
}

export default function TemplateLibrary({
  items,
  onLaunch,
  launchOutcome = { status: "idle" },
  selectedTemplateId,
  onSelectTemplate,
}: TemplateLibraryProps): React.JSX.Element {
  // Selection is controlled when `selectedTemplateId` is provided, otherwise
  // managed internally — the standard React controlled/uncontrolled idiom.
  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const activeId =
    selectedTemplateId !== undefined ? selectedTemplateId : internalSelected;

  function handleSelect(id: string): void {
    const next = id === activeId ? null : id;
    if (selectedTemplateId === undefined) setInternalSelected(next);
    onSelectTemplate?.(next);
  }

  if (items.length === 0) {
    return (
      <EmptyState>
        <EmptyStateIcon aria-hidden>∅</EmptyStateIcon>
        <EmptyStateTitle>No templates</EmptyStateTitle>
        <EmptyStateDesc>
          No global or project templates are available to launch yet.
        </EmptyStateDesc>
      </EmptyState>
    );
  }

  const selected = items.find((item) => item.id === activeId) ?? null;
  const isLaunching = launchOutcome.status === "starting";

  return (
    <div className="flex flex-col gap-md">
      <ul className="flex flex-col gap-xs">
        {items.map((item) => (
          <TemplateRow
            // The (tier, id) pair is unique across the combined listing, so
            // same-name templates from different tiers stay distinct (R7.1).
            key={`${item.tier}:${item.id}`}
            item={item}
            selected={item.id === activeId}
            onSelect={() => handleSelect(item.id)}
          />
        ))}
      </ul>

      {selected && (
        <div className="flex flex-col gap-sm rounded-md border border-solid border-border-dim bg-bg-surface p-md">
          <div className="flex flex-col gap-xs">
            <span className="font-mono text-[0.7rem] tracking-[0.06em] text-text-tertiary uppercase">
              Prerequisites
            </span>
            <PrerequisiteList prerequisites={selected.prerequisites} />
          </div>

          <LaunchOutcomeBanner outcome={launchOutcome} />

          <WorkflowLaunchForm
            // Re-key on the selected template so the form resets its field state
            // when the launcher switches between templates.
            key={`${selected.tier}:${selected.id}`}
            parameters={selected.parameters}
            isLaunching={isLaunching}
            onLaunch={(parameters) =>
              onLaunch({ id: selected.id, tier: selected.tier, parameters })
            }
          />
        </div>
      )}
    </div>
  );
}
