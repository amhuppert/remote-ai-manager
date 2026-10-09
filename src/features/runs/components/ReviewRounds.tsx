"use client";

import { CheckIcon, ChevronDownIcon, CloseIcon } from "@/components/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import { Spinner } from "@/components/ui/Spinner";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { cn } from "@/lib/ui/cn";
import type { Advisory, CheckResult, ReviewRound, SeatVerdict } from "../model";
import { formatDuration, formatUsd } from "../present";
import { SeatMark } from "./parts";

const roundOutcome: Record<
  ReviewRound["outcome"],
  { label: string; tone: StatusChipTone }
> = {
  running: { label: "Reviewing", tone: "cyan" },
  passed: { label: "Passed", tone: "green" },
  failed: { label: "Changes asked", tone: "red" },
  retired: { label: "Retired", tone: "neutral" },
};

const verdict: Record<
  SeatVerdict["status"],
  { label: string; tone: StatusChipTone }
> = {
  pending: { label: "Reviewing", tone: "cyan" },
  pass: { label: "Pass", tone: "green" },
  fail: { label: "Fail", tone: "red" },
  defect: { label: "Plan defect", tone: "amber" },
  unavailable: { label: "Unavailable", tone: "neutral" },
};

const disposition: Record<
  NonNullable<Advisory["disposition"]>,
  { label: string; tone: StatusChipTone }
> = {
  addressed: { label: "Addressed", tone: "green" },
  declined: { label: "Declined", tone: "neutral" },
  deferred: { label: "Deferred", tone: "neutral" },
};

function Check({ check }: { check: CheckResult }) {
  return (
    <li className="flex min-w-0 items-center gap-[6px] font-mono text-[0.72rem]">
      <span
        className={cn(
          "inline-flex shrink-0",
          check.status === "passed" && "text-green",
          check.status === "failed" && "text-red",
          check.status === "running" && "text-cyan",
        )}
      >
        {check.status === "passed" ? <CheckIcon size={12} /> : null}
        {check.status === "failed" ? <CloseIcon size={12} /> : null}
        {check.status === "running" ? (
          <Spinner size="sm" tone="inherit" />
        ) : null}
      </span>
      <span className="text-text-primary">{check.command}</span>
      <span className="text-text-tertiary">
        {formatDuration(check.durationMs)}
      </span>
      {check.detail !== undefined ? (
        <span className="truncate text-red-text">{check.detail}</span>
      ) : null}
    </li>
  );
}

function Note({
  kind,
  title,
  description,
  criterionId,
  trailing,
}: {
  kind: "finding" | "advice";
  title: string;
  description: string;
  criterionId?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex flex-col gap-[4px] border-y-0 border-r-0 border-l-2 border-solid py-[2px] pl-md",
        kind === "finding" ? "border-red" : "border-border-default",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-sm">
        {criterionId !== undefined ? (
          <span className="shrink-0 font-mono text-[0.7rem] font-semibold text-red-text">
            {criterionId}
          </span>
        ) : null}
        <span className="min-w-0 font-mono text-[0.78rem] font-medium text-text-primary">
          {title}
        </span>
        {trailing !== undefined ? (
          <span className="ml-auto shrink-0">{trailing}</span>
        ) : null}
      </div>
      <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
        {description}
      </p>
    </li>
  );
}

function Seat({ seat }: { seat: SeatVerdict }) {
  const presented = verdict[seat.status];
  return (
    <li className="flex flex-col gap-sm">
      <div className="flex min-w-0 items-center gap-sm">
        <SeatMark seat={seat.seat} showEffort={false} />
        {seat.seat.focus !== undefined ? (
          <span className="truncate font-mono text-[0.72rem] text-text-secondary">
            {seat.seat.focus}
          </span>
        ) : null}
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {seat.seat.authority}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-sm">
          <span className="font-mono text-[0.7rem] text-text-tertiary">
            {formatUsd(seat.costUsd)}
          </span>
          <StatusChip
            tone={presented.tone}
            icon={
              seat.status === "pending" ? (
                <Spinner size="sm" tone="inherit" />
              ) : undefined
            }
          >
            {presented.label}
          </StatusChip>
        </span>
      </div>
      {seat.findings.length + seat.advisories.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-sm p-0 pl-[15px]">
          {seat.findings.map((finding) => (
            <Note key={finding.title} kind="finding" {...finding} />
          ))}
          {seat.advisories.map((advisory) => (
            <Note
              key={advisory.title}
              kind="advice"
              title={advisory.title}
              description={
                advisory.dispositionNote !== undefined
                  ? `${advisory.description} — ${advisory.dispositionNote}`
                  : advisory.description
              }
              trailing={
                advisory.disposition !== null ? (
                  <StatusChip tone={disposition[advisory.disposition].tone}>
                    {disposition[advisory.disposition].label}
                  </StatusChip>
                ) : (
                  <span className="font-mono text-[0.7rem] text-text-tertiary">
                    advice
                  </span>
                )
              }
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Round({
  round,
  defaultOpen,
}: {
  round: ReviewRound;
  defaultOpen: boolean;
}) {
  const outcome = roundOutcome[round.outcome];
  return (
    <Collapsible defaultOpen={defaultOpen} asChild>
      <div className="group overflow-hidden rounded-lg border border-solid border-border-subtle bg-bg-surface">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-sm border-0 bg-transparent px-lg py-md text-left transition-colors duration-150 hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:-outline-offset-2"
          >
            <span className="font-mono text-[0.78rem] font-semibold text-text-primary">
              Round {round.number}
            </span>
            <span className="font-mono text-[0.72rem] text-text-secondary">
              {round.kind === "full" ? "Full review" : "Blocking re-review"}
            </span>
            <span className="ml-auto flex items-center gap-sm">
              <span className="font-mono text-[0.7rem] text-text-tertiary">
                {formatLocalTime(round.at)}
              </span>
              <StatusChip
                tone={outcome.tone}
                icon={
                  round.outcome === "running" ? (
                    <Spinner size="sm" tone="inherit" />
                  ) : undefined
                }
              >
                {outcome.label}
              </StatusChip>
              <span className="text-text-tertiary transition-transform duration-150 group-data-[state=closed]:-rotate-90">
                <ChevronDownIcon size={14} />
              </span>
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-lg border-x-0 border-t border-b-0 border-solid border-border-dim px-lg py-md">
            {round.checks.length > 0 ? (
              <div className="flex items-start gap-md">
                <span className="w-[64px] shrink-0 pt-[1px] font-mono text-[0.7rem] font-medium tracking-[0.08em] text-text-tertiary uppercase">
                  Checks
                </span>
                <ul className="m-0 flex min-w-0 list-none flex-wrap gap-x-lg gap-y-[6px] p-0">
                  {round.checks.map((check) => (
                    <Check key={check.command} check={check} />
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="m-0 flex list-none flex-col gap-lg p-0">
              {round.seats.map((seat) => (
                <Seat key={seat.assignment} seat={seat} />
              ))}
            </ul>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

/** Every review round, the latest first and open. */
export function ReviewRounds({ rounds }: { rounds: ReviewRound[] }) {
  if (rounds.length === 0)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        No review yet. Reviewers start once the implementer reports its result.
      </p>
    );
  return (
    <div className="flex flex-col gap-sm">
      {rounds.map((round, index) => (
        <Round key={round.number} round={round} defaultOpen={index === 0} />
      ))}
    </div>
  );
}
