"use client";

import { useId } from "react";

import { StatusChip } from "@/components/ui/StatusChip";
import type {
  AgentProfileDeletionReport,
  AgentProfileReferenceHolder,
  AgentProfileRunTemplateHolder,
} from "@/lib/agent-profiles/schemas";
import { getErrorMessage } from "@/lib/shared/errors";

export interface AgentProfileDeletionImpactProps {
  preview: {
    isPending: boolean;
    error: Error | null;
    report: AgentProfileDeletionReport | null;
  };
}

type Holder = AgentProfileReferenceHolder | AgentProfileRunTemplateHolder;

function holderKey(holder: Holder): string {
  const scope =
    holder.scope.kind === "global" ? "global" : holder.scope.projectPath;
  const dormant = "dormant" in holder ? holder.dormant : false;
  return `${scope}:${holder.id}:${holder.contextId ?? ""}:${dormant}`;
}

function HolderRow({
  holder,
  place,
}: {
  holder: Holder;
  /** Where a holder with no context names the profile, when that needs saying. */
  place?: string;
}): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center gap-xs font-mono text-[0.72rem] text-text-secondary">
      <span className="text-text-primary">{holder.name || holder.id}</span>
      {holder.scope.kind === "project" ? (
        <span className="text-text-tertiary">{holder.scope.projectPath}</span>
      ) : (
        <StatusChip tone="neutral" appearance="flat">
          Global
        </StatusChip>
      )}
      {holder.contextId !== undefined ? (
        <span className="text-text-tertiary">context {holder.contextId}</span>
      ) : (
        place !== undefined && (
          <span className="text-text-tertiary">{place}</span>
        )
      )}
      {/* A dormant holder is configuration nothing currently invokes — it is
          listed because re-enabling the cohort would run it, and by then the
          library lookup that could have caught the dangling reference is gone. */}
      {"dormant" in holder && holder.dormant && (
        <StatusChip tone="neutral">Dormant</StatusChip>
      )}
    </li>
  );
}

/** One kind of holder, captioned on screen so the kinds cannot be confused. */
function HolderList({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const captionId = useId();
  return (
    <div className="flex flex-col gap-xs">
      <p
        id={captionId}
        className="m-0 font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
      >
        {caption}
      </p>
      <ul
        aria-labelledby={captionId}
        className="m-0 flex max-h-[180px] list-none flex-col gap-2xs overflow-auto p-0"
      >
        {children}
      </ul>
    </div>
  );
}

/**
 * Who still references the profile, shown inside the delete confirmation.
 *
 * The enumeration is advisory about its CONTENT (D14): finding holders never
 * vetoes the deletion. A human who decides to delete anyway is telling the
 * truth about their intent, and the artifacts left behind fail closed at
 * validate and launch with a located error rather than breaking silently.
 *
 * Advisory content is not the same as an optional step, though — R15.1 wants
 * this list BEFORE the decision, so the confirm button waits on it. That gating
 * lives on the action in {@link AgentProfileEditor}; this component owns only
 * what is shown.
 */
export default function AgentProfileDeletionImpact({
  preview,
}: AgentProfileDeletionImpactProps): React.JSX.Element {
  if (preview.error !== null) {
    return (
      <p role="alert" className="m-0 font-mono text-[0.72rem] text-amber">
        Could not check which workflows reference this profile:{" "}
        {getErrorMessage(preview.error)}. Deletion is unavailable until the
        check succeeds — the delete runs the same check and would refuse.
      </p>
    );
  }

  if (preview.report === null) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        {preview.isPending
          ? "Checking which workflows reference this profile…"
          : "References have not been checked."}
      </p>
    );
  }

  const { definitions, templates, runTemplates, workflowDefaults } =
    preview.report.savedReferenceEnumeration;
  const holders = [...definitions, ...templates];

  if (holders.length === 0 && runTemplates.length === 0 && !workflowDefaults) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        No saved workflow, template, run template, or global default references
        this profile.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-sm">
      <p className="m-0 font-mono text-[0.72rem] text-amber">
        These saved artifacts still reference this profile, and may need
        updating before they launch:
      </p>
      {holders.length > 0 && (
        <HolderList caption="Graph workflows referencing this profile">
          {holders.map((holder) => (
            <HolderRow key={holderKey(holder)} holder={holder} />
          ))}
        </HolderList>
      )}
      {runTemplates.length > 0 && (
        <HolderList caption="Run templates referencing this profile">
          {runTemplates.map((holder) => (
            <HolderRow
              key={holderKey(holder)}
              holder={holder}
              place="defaults"
            />
          ))}
        </HolderList>
      )}
      {workflowDefaults && (
        <p className="m-0 font-mono text-[0.72rem] text-text-secondary">
          The global workflow defaults also reference it.
        </p>
      )}
    </section>
  );
}
