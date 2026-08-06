"use client";

import { StatusChip } from "@/components/ui/StatusChip";
import type {
  AgentProfileDeletionReport,
  AgentProfileReferenceHolder,
} from "@/lib/agent-profiles/schemas";
import { getErrorMessage } from "@/lib/shared/errors";

export interface AgentProfileDeletionImpactProps {
  preview: {
    isPending: boolean;
    error: Error | null;
    report: AgentProfileDeletionReport | null;
  };
}

function holderKey(holder: AgentProfileReferenceHolder): string {
  const scope =
    holder.scope.kind === "global" ? "global" : holder.scope.projectPath;
  return `${scope}:${holder.id}:${holder.contextId ?? ""}:${holder.dormant}`;
}

function HolderRow({
  holder,
}: {
  holder: AgentProfileReferenceHolder;
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
      {holder.contextId !== undefined && (
        <span className="text-text-tertiary">context {holder.contextId}</span>
      )}
      {/* A dormant holder is configuration nothing currently invokes — it is
          listed because re-enabling the cohort would run it, and by then the
          library lookup that could have caught the dangling reference is gone. */}
      {holder.dormant && <StatusChip tone="neutral">Dormant</StatusChip>}
    </li>
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

  const { definitions, templates, workflowDefaults } =
    preview.report.savedReferenceEnumeration;
  const holders = [...definitions, ...templates];

  if (holders.length === 0 && !workflowDefaults) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        No saved workflow, template, or global default references this profile.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-2xs">
      <p className="m-0 font-mono text-[0.72rem] text-amber">
        Deleting this profile leaves these saved artifacts unlaunchable until
        they are re-staffed:
      </p>
      {holders.length > 0 && (
        <ul
          aria-label="Workflows referencing this profile"
          className="m-0 flex max-h-[180px] list-none flex-col gap-2xs overflow-auto p-0"
        >
          {holders.map((holder) => (
            <HolderRow key={holderKey(holder)} holder={holder} />
          ))}
        </ul>
      )}
      {workflowDefaults && (
        <p className="m-0 font-mono text-[0.72rem] text-text-secondary">
          The global workflow defaults also reference it.
        </p>
      )}
    </section>
  );
}
