"use client";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { Button } from "@/components/ui/Button";
import type { GraphWorkflowValidationSpecialistState } from "@/lib/workflow-graph/schemas";
import type { CohortMemberView, CohortRoundView } from "./cohort-round-view";

const STATE_TONE: Record<
  GraphWorkflowValidationSpecialistState,
  StatusChipTone
> = {
  pending: "neutral",
  running: "cyan",
  verdict_pass: "green",
  verdict_fail: "red",
  infra_failed: "amber",
  parked: "amber",
};

function aggregateTone(view: CohortRoundView): StatusChipTone {
  if (view.aggregateKind === "infrastructure") return "amber";
  if (view.outcome === "passed") return "green";
  if (view.outcome === null) return "cyan";
  return "red";
}

function attemptsLabel(attempts: number): string {
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
}

// Preflight is off, so a single-side rule zeroes the other three explicitly —
// `border-solid` alone would otherwise draw a default-width box.
const rowClass =
  "flex flex-col gap-[4px] border-x-0 border-t-0 border-b border-solid border-border-dim px-[2px] py-[8px] last:border-b-0";

function CohortMemberRow({
  member,
  onOpenTranscript,
}: {
  member: CohortMemberView;
  onOpenTranscript?: (member: CohortMemberView) => void;
}): React.JSX.Element {
  return (
    <li
      className={rowClass}
      data-testid="cohort-member"
      data-assignment-id={member.assignmentId}
      data-outcome-kind={member.outcomeKind}
    >
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="font-mono text-[0.74rem] font-semibold text-text-primary">
          {member.assignmentId}
        </span>
        <span
          className="font-mono text-[0.68rem] text-text-tertiary"
          data-testid="cohort-member-profile"
        >
          {member.profileLabel}
        </span>
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          {member.strategy}
        </span>
        <StatusChip
          tone={STATE_TONE[member.state]}
          data-testid="cohort-member-state"
        >
          {member.stateLabel}
        </StatusChip>
        {member.conversationId !== null && onOpenTranscript !== undefined ? (
          <Button
            size="sm"
            variant="default"
            layoutClassName="ml-auto"
            onClick={() => onOpenTranscript(member)}
          >
            View Transcript
          </Button>
        ) : null}
      </div>
      {member.summary !== null && member.summary.length > 0 ? (
        <div className="text-[0.72rem] leading-snug text-text-secondary">
          {member.summary}
        </div>
      ) : null}
      {member.infraFailureMessage !== null ? (
        <div className="text-[0.7rem] leading-snug text-amber">
          {member.infraFailureMessage} · {attemptsLabel(member.attempts)}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The context's latest validation round: the deterministic aggregate on top,
 * then one row per frozen roster seat, then the round's own incidents.
 *
 * The infrastructure-vs-semantic distinction is carried by the state LABEL and
 * by the failure text beside it, never by the chip tone alone — an operator
 * reading this in greyscale still has to be able to tell "the reviewer said no"
 * from "the reviewer never got to answer".
 */
export default function CohortRoundCard({
  view,
  onOpenTranscript,
}: {
  view: CohortRoundView;
  /** Opens ONE member's lane conversation; absent when the host cannot. */
  onOpenTranscript?: (member: CohortMemberView) => void;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-solid border-border-dim bg-bg-raised px-[10px] py-[8px]">
      <div
        className="flex flex-wrap items-center gap-[6px] pb-[8px]"
        data-testid="cohort-round-aggregate"
        data-outcome-kind={view.aggregateKind}
      >
        <StatusChip tone={aggregateTone(view)}>
          {view.aggregateLabel}
        </StatusChip>
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          {view.members.length}{" "}
          {view.members.length === 1 ? "validator" : "validators"} · candidate{" "}
          {view.candidateTreeHash.slice(0, 8)}
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {view.members.map((member) => (
          <CohortMemberRow
            key={member.assignmentId}
            member={member}
            {...(onOpenTranscript !== undefined ? { onOpenTranscript } : {})}
          />
        ))}
      </ul>
      {view.incidents.length > 0 ? (
        <ul className="m-0 mt-[8px] list-none border-x-0 border-t border-b-0 border-solid border-border-dim p-0 pt-[8px]">
          {view.incidents.map((incident) => (
            <li
              key={incident.key}
              className="flex flex-col gap-[3px] py-[4px]"
              data-testid="cohort-incident"
              data-incident={incident.incident}
            >
              <div className="flex flex-wrap items-center gap-[6px]">
                <StatusChip tone="amber">Infrastructure</StatusChip>
                <span className="font-mono text-[0.7rem] text-text-secondary">
                  {incident.label}
                </span>
                {incident.assignmentId !== null ? (
                  <span className="font-mono text-[0.68rem] text-text-tertiary">
                    {incident.assignmentId}
                  </span>
                ) : null}
              </div>
              <div className="text-[0.7rem] leading-snug text-text-tertiary">
                {incident.message}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
