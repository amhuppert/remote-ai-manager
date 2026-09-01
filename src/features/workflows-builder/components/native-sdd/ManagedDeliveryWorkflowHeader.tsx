"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";

const LIFECYCLE = {
  draft: { label: "Draft", tone: "cyan" },
  in_review: { label: "In review", tone: "amber" },
  approved: { label: "Approved", tone: "green" },
  launched: { label: "Launched", tone: "green" },
  superseded: { label: "Superseded", tone: "neutral" },
  abandoned: { label: "Abandoned", tone: "neutral" },
} satisfies Record<
  NativeSddWorkflowManagementDetail["lifecycle"],
  { label: string; tone: StatusChipTone }
>;

interface ManagedDeliveryWorkflowHeaderProps {
  management: NativeSddWorkflowManagementDetail;
  definitionRevision: number;
  onPropose?: () => void;
  onSignOff?: () => void;
  onReopen?: () => void;
  onAbandon?: () => void;
  launchControl?: ReactNode;
  pendingAction?: string | null;
  error?: string | null;
}

export default function ManagedDeliveryWorkflowHeader({
  management,
  definitionRevision,
  onPropose,
  onSignOff,
  onReopen,
  onAbandon,
  launchControl,
  pendingAction = null,
  error = null,
}: ManagedDeliveryWorkflowHeaderProps): React.JSX.Element {
  const lifecycle = LIFECYCLE[management.lifecycle];
  const readOnly = !management.editable;

  return (
    <header className="flex flex-col gap-sm border-b border-solid border-border-dim bg-bg-base px-md py-sm">
      <div className="flex flex-wrap items-center gap-sm">
        <StatusChip tone={lifecycle.tone}>{lifecycle.label}</StatusChip>
        <Link
          href={management.specHref}
          className="font-display text-[0.9rem] font-bold text-text-primary no-underline hover:text-cyan"
        >
          {management.specName}
        </Link>
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          {management.specSlug}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-md gap-y-xs font-mono text-[0.68rem] text-text-secondary">
        <span>
          spec r{management.pinnedRevisionNumber} · definition r
          {definitionRevision} · attempt {management.attemptId}
        </span>
        {management.deltaBasisExecutionId && (
          <span>delta basis {management.deltaBasisExecutionId}</span>
        )}
      </div>

      {readOnly && (
        <p className="m-0 font-mono text-[0.68rem] leading-relaxed text-text-tertiary">
          Read-only. Inspect this candidate here; reopen the plan to create an
          editable successor.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-xs">
        {management.capabilities.canPropose && onPropose && (
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={pendingAction === "propose"}
            onClick={onPropose}
          >
            Propose for review
          </Button>
        )}
        {management.capabilities.canSignOff && onSignOff && (
          <Button
            type="button"
            size="sm"
            variant="primary"
            loading={pendingAction === "sign-off"}
            onClick={onSignOff}
          >
            Sign off
          </Button>
        )}
        {management.capabilities.canLaunch && launchControl}
        {management.capabilities.canReopen && onReopen && (
          <Button
            type="button"
            size="sm"
            loading={pendingAction === "reopen"}
            onClick={onReopen}
          >
            Reopen
          </Button>
        )}
        {management.capabilities.canAbandon && onAbandon && (
          <Button
            type="button"
            size="sm"
            variant="danger"
            loading={pendingAction === "abandon"}
            onClick={onAbandon}
          >
            Abandon plan
          </Button>
        )}
        {management.lifecycle === "launched" && management.executionHref && (
          <Link
            href={management.executionHref}
            className="inline-flex items-center justify-center rounded-md border border-solid border-cyan bg-cyan px-[12px] py-[6px] font-mono text-[0.72rem] font-semibold text-text-inverse no-underline transition-all duration-150 hover:border-cyan-dim hover:bg-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            Open execution
          </Link>
        )}
      </div>

      {error && (
        <p role="alert" className="m-0 font-mono text-[0.68rem] text-red">
          {error}
        </p>
      )}
    </header>
  );
}
