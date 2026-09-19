"use client";

import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/ui/cn";
import type { GraphWorkflowValidationSpecialistState } from "@/lib/workflow-graph/schemas";
import {
  authorityLabel,
  type CohortAdvisoryDispositionState,
  type CohortAdvisoryView,
  type CohortMemberAuthority,
  type CohortMemberView,
  type CohortRoundStepView,
  type CohortRoundView,
} from "./cohort-round-view";

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

/**
 * Red is reserved for a lane whose finding can fail the round. An advisory
 * lane that never answered cost the round nothing, so its exhaustion drops to
 * the muted tone — the label beside it still says what happened.
 */
function stateTone(member: CohortMemberView): StatusChipTone {
  if (member.state === "infra_failed" && !member.blocksRound) return "neutral";
  return STATE_TONE[member.state];
}

// Blocking authority is a gate, and amber is CC's gate tone. Advisory seats are
// muted: they are the default authority, and a badge that competed with the
// verdict beside it would misrepresent what an advisory can do.
const AUTHORITY_TONE: Record<CohortMemberAuthority, StatusChipTone> = {
  blocking: "amber",
  advisory: "neutral",
  unknown: "neutral",
};

/**
 * One seat's blocking power (R9.5). Exported because the round history has two
 * kinds of specialist row — the live round's roster rows and the rows the
 * inspector reads off a superseded round's validation-result event — and a
 * badge that differed between them would let one round's seat contradict the
 * other's.
 */
export function AuthorityChip({
  authority,
}: {
  authority: CohortMemberAuthority;
}): React.JSX.Element {
  return (
    <StatusChip
      tone={AUTHORITY_TONE[authority]}
      data-testid="cohort-member-authority"
      data-authority={authority}
    >
      {authorityLabel(authority)}
    </StatusChip>
  );
}

// Advisory kinds are tone-coded on the informational range only — never red,
// which belongs to blocking issues. `plan` takes amber because it is the kind
// that asks somebody to revisit a decision; `out_of_scope` is muted because it
// is about work this context does not own.
const ADVISORY_KIND_TONE: Record<CohortAdvisoryView["kind"], StatusChipTone> = {
  implementation: "cyan",
  plan: "amber",
  out_of_scope: "neutral",
};

// `pending` is inert because nothing has been recorded — not because something
// is wrong. A decline is a legitimate answer that carries a reason, so it reads
// as engagement (cyan), never as a failure.
const DISPOSITION_TONE: Record<CohortAdvisoryDispositionState, StatusChipTone> =
  {
    pending: "neutral",
    addressed: "green",
    declined: "cyan",
    deferred: "amber",
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

const STEP_STATE_CLASS: Record<CohortRoundStepView["state"], string> = {
  done: "text-text-tertiary",
  current: "text-cyan",
  upcoming: "text-text-tertiary opacity-60",
};

const STEP_MARK: Record<CohortRoundStepView["state"], string> = {
  done: "●",
  current: "◉",
  upcoming: "○",
};

/**
 * The round's phases in order. The advisory-response step only appears when the
 * context owes a response turn for this round, which is what tells that phase
 * apart from an open validation and from a finished context (R6.3).
 */
function RoundTimeline({
  timeline,
}: {
  timeline: readonly CohortRoundStepView[];
}): React.JSX.Element {
  return (
    <ol
      className="m-0 flex list-none flex-wrap items-center gap-[6px] p-0 pb-[8px]"
      data-testid="cohort-round-timeline"
    >
      {timeline.map((step) => (
        <li
          key={step.step}
          data-testid="cohort-round-step"
          data-step={step.step}
          data-state={step.state}
          // The glyph and the tone are both visual; `aria-current` is what
          // carries "the round is here" to a reader that gets neither.
          {...(step.state === "current"
            ? { "aria-current": "step" as const }
            : {})}
          className={cn(
            "flex items-center gap-[4px] font-mono text-[0.7rem]",
            STEP_STATE_CLASS[step.state],
          )}
        >
          <span aria-hidden="true">{STEP_MARK[step.state]}</span>
          {step.label}
        </li>
      ))}
    </ol>
  );
}

/**
 * A lane's advisories, rendered only from the ROUND RECORD.
 *
 * Never from a validation-result event: that publication goes out when the
 * round settles, which is before the advisory-response turn records any
 * disposition, so an event-sourced copy would permanently read "No
 * disposition" beside the record's own answer (R9.3).
 */
function AdvisoryList({
  advisories,
}: {
  advisories: readonly CohortAdvisoryView[];
}): React.JSX.Element {
  return (
    <ul className="m-0 mt-[2px] flex list-none flex-col gap-[6px] p-0">
      {advisories.map((advisory) => (
        <li
          key={advisory.key}
          data-testid="cohort-advisory"
          data-kind={advisory.kind}
          className="flex flex-col gap-[3px] rounded-sm border border-solid border-border-dim bg-bg-base px-[8px] py-[6px]"
        >
          <div className="flex flex-wrap items-center gap-[6px]">
            <StatusChip
              tone={ADVISORY_KIND_TONE[advisory.kind]}
              data-testid="cohort-advisory-kind"
            >
              {advisory.kindLabel}
            </StatusChip>
            <span className="text-[0.72rem] font-semibold text-text-primary">
              {advisory.title}
            </span>
            <StatusChip
              tone={DISPOSITION_TONE[advisory.disposition]}
              layoutClassName="ml-auto"
              data-testid="cohort-advisory-disposition"
              data-disposition={advisory.disposition}
            >
              {advisory.dispositionLabel}
            </StatusChip>
          </div>
          <div className="text-[0.7rem] leading-snug text-text-secondary">
            {advisory.description}
          </div>
          {advisory.dispositionReason !== null && (
            <div
              className="text-[0.7rem] leading-snug text-text-tertiary"
              data-testid="cohort-advisory-reason"
            >
              {advisory.dispositionReason}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

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
      data-authority={member.authority}
      data-blocks-round={member.blocksRound ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="font-mono text-[0.74rem] font-semibold text-text-primary">
          {member.assignmentId}
        </span>
        <span
          className="font-mono text-[0.7rem] text-text-tertiary"
          data-testid="cohort-member-profile"
        >
          {member.profileLabel}
        </span>
        <AuthorityChip authority={member.authority} />
        <StatusChip tone={stateTone(member)} data-testid="cohort-member-state">
          {member.stateLabel}
        </StatusChip>
        {member.conversationId !== null && onOpenTranscript !== undefined ? (
          <Button
            size="sm"
            variant="default"
            touch
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
        <div
          className={cn(
            "text-[0.7rem] leading-snug",
            member.blocksRound ? "text-amber" : "text-text-tertiary",
          )}
        >
          {member.infraFailureMessage} · {attemptsLabel(member.attempts)}
        </div>
      ) : null}
      {member.advisories.length > 0 ? (
        <AdvisoryList advisories={member.advisories} />
      ) : null}
    </li>
  );
}

/**
 * The context's latest validation round: the phase timeline and deterministic
 * aggregate on top, then one row per frozen roster seat with its advisories,
 * then the round's own incidents.
 *
 * The infrastructure-vs-semantic distinction is carried by the state LABEL and
 * by the failure text beside it, never by the chip tone alone — an operator
 * reading this in greyscale still has to be able to tell "the reviewer said no"
 * from "the reviewer never got to answer". Authority and disposition follow the
 * same rule: every chip states its meaning in words.
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
      <RoundTimeline timeline={view.timeline} />
      <div
        className="flex flex-wrap items-center gap-[6px] pb-[8px]"
        data-testid="cohort-round-aggregate"
        data-outcome-kind={view.aggregateKind}
      >
        <StatusChip tone={aggregateTone(view)}>
          {view.aggregateLabel}
        </StatusChip>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
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
              data-blocks-round={incident.blocksRound ? "true" : "false"}
            >
              <div className="flex flex-wrap items-center gap-[6px]">
                <StatusChip
                  tone={incident.blocksRound ? "amber" : "neutral"}
                  data-testid="cohort-incident-tone"
                >
                  {incident.blocksRound ? "Infrastructure" : "Recorded"}
                </StatusChip>
                <span className="font-mono text-[0.7rem] text-text-secondary">
                  {incident.label}
                </span>
                {incident.assignmentId !== null ? (
                  <span className="font-mono text-[0.7rem] text-text-tertiary">
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
