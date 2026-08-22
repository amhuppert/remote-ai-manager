"use client";

import { useState } from "react";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import type { WorkflowAdvisoryIdentity } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowValidationResultEvent } from "@/lib/workflow-graph/event-schemas";
import type { ValidatorAuthority } from "@/lib/workflow-graph/config-schemas";
import CohortRoundCard from "../CohortRoundCard";
import {
  deriveCohortRoundView,
  type CohortMemberView,
} from "../cohort-round-view";
import type { Timestamped } from "./history-entries";
import type {
  ValidationRoundRow,
  ValidationRoundStatus,
  ValidationRoundUsage,
} from "./validation-rounds-model";
import { roundRaisedAdvisory } from "./validation-rounds-model";
import ValidationCard, {
  assignmentTranscriptLabel,
  focusedRoundAttrs,
  focusedRoundClass,
  type ViewConversation,
} from "./ValidationRounds";
import { GroupHeader, InspectorButton } from "./chrome";

/**
 * History tab → Validation rounds (design E3, §11).
 *
 * One row per round — which round, which iteration, how it stands, and the
 * roster it froze — with the round's artifacts behind a control and its spend
 * and references in the row's footer. Opening a round shows the cards that
 * already render it: the live per-seat view and the concluded aggregate.
 * Finding ownership, filtering and rendering are untouched (README §2.3).
 *
 * Rows arrive newest first and cover the current attempt at the context. A
 * round the execution kept no record of is not listed — the list states what
 * the record holds rather than reconstructing what it does not.
 */

const STATUS_TONE: Record<ValidationRoundStatus, StatusChipTone> = {
  in_flight: "cyan",
  passed: "green",
  rejected: "red",
  infrastructure: "amber",
};

/**
 * The round's spend, in the compact form the specialist cards already use
 * (`ValidationRounds`): `↑` in, `⊙` cached, `↓` out. Kept identical so one
 * round does not read two ways, and paired with a spoken form below — the
 * arrows are dense on purpose, which makes them opaque to a screen reader.
 */
function usageText(usage: ValidationRoundUsage | null): string | null {
  if (usage === null) return null;
  const parts: string[] = [];
  if (usage.inputTokens !== null) parts.push(`${usage.inputTokens}↑`);
  if (usage.cachedInputTokens !== null)
    parts.push(`${usage.cachedInputTokens}⊙`);
  if (usage.outputTokens !== null) parts.push(`${usage.outputTokens}↓`);
  if (parts.length > 0) parts.push("tokens");
  if (usage.apiTurns !== null) {
    parts.push(`${usage.apiTurns} ${usage.apiTurns === 1 ? "turn" : "turns"}`);
  }
  if (usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(2)}`);
  return parts.length === 0 ? null : parts.join(" ");
}

function usageLabel(usage: ValidationRoundUsage): string {
  const parts: string[] = [];
  if (usage.inputTokens !== null)
    parts.push(`${usage.inputTokens} input tokens`);
  if (usage.cachedInputTokens !== null)
    parts.push(`${usage.cachedInputTokens} cached input tokens`);
  if (usage.outputTokens !== null)
    parts.push(`${usage.outputTokens} output tokens`);
  if (usage.apiTurns !== null) {
    parts.push(`${usage.apiTurns} ${usage.apiTurns === 1 ? "turn" : "turns"}`);
  }
  if (usage.costUsd !== null) parts.push(`$${usage.costUsd.toFixed(2)}`);
  return parts.join(", ");
}

function RoundFooter({
  row,
}: {
  row: ValidationRoundRow;
}): React.JSX.Element | null {
  const usage = usageText(row.usage);
  if (usage === null && row.references.length === 0) return null;
  return (
    <div
      data-testid="validation-round-footer"
      className="mt-[6px] flex flex-wrap items-center gap-x-md gap-y-[2px] font-mono text-[0.7rem] text-text-tertiary"
    >
      {usage !== null && row.usage !== null && (
        <span aria-label={usageLabel(row.usage)}>{usage}</span>
      )}
      {row.references.length > 0 && (
        <span>reference: {row.references.join(", ")}</span>
      )}
    </div>
  );
}

const roundRowClass =
  "border-x-0 border-t-0 border-b border-solid border-border-dim py-[8px] last:border-b-0";
const roundSeqClass = "font-mono text-[0.72rem] font-medium text-text-primary";

function RoundRow({
  row,
  contextId,
  cohortAssignments,
  incidents,
  advisoryResponse,
  isReusedSession,
  focused,
  focusAnchorId,
  onViewConversation,
}: {
  row: ValidationRoundRow;
  contextId: string;
  cohortAssignments: readonly { id: string; authority: ValidatorAuthority }[];
  incidents: Parameters<typeof deriveCohortRoundView>[0]["incidents"];
  advisoryResponse: Parameters<
    typeof deriveCohortRoundView
  >[0]["advisoryResponse"];
  isReusedSession: boolean;
  /** True for the ONE round a deep link aimed at: it opens and is ringed. */
  focused: boolean;
  focusAnchorId: string;
  onViewConversation?: ViewConversation;
}): React.JSX.Element {
  const [open, setOpen] = useState(focused);
  const liveView =
    row.live === null
      ? null
      : deriveCohortRoundView({
          round: row.live,
          incidents,
          assignments: cohortAssignments,
          advisoryResponse,
        });

  return (
    <div
      data-testid="validation-round-row"
      data-round-seq={row.seq}
      data-status={row.status}
      className={cn(roundRowClass, focused && focusedRoundClass)}
      {...(focused ? focusedRoundAttrs(focusAnchorId) : {})}
    >
      <div className="flex flex-wrap items-center gap-sm">
        <span className={roundSeqClass}>
          round {row.seq} · iteration {row.iteration}
        </span>
        <StatusChip tone={STATUS_TONE[row.status]}>
          {row.statusLabel}
        </StatusChip>
        <span
          data-testid="validation-round-roster"
          className="font-mono text-[0.7rem] text-text-tertiary"
        >
          {row.roster.length === 0
            ? "roster frozen: none recorded"
            : `roster frozen: ${row.roster.join(", ")}`}
        </span>
        <span className="ml-auto">
          <InspectorButton
            size="xs"
            testId="validation-round-artifacts"
            ariaLabel={`${open ? "Hide" : "Show"} artifacts for round ${row.seq}`}
            onClick={() => setOpen((current) => !current)}
          >
            Artifacts
          </InspectorButton>
        </span>
      </div>
      {open && (
        <div className="mt-[6px]">
          {liveView !== null && (
            <CohortRoundCard
              view={liveView}
              {...(onViewConversation
                ? {
                    onOpenTranscript: (member: CohortMemberView) => {
                      if (member.conversationId === null) return;
                      onViewConversation(
                        member.conversationId,
                        "context_validator",
                        contextId,
                        assignmentTranscriptLabel(member.assignmentId),
                      );
                    },
                  }
                : {})}
            />
          )}
          {row.record !== null && (
            <ValidationCard
              event={row.record}
              cohortAssignments={cohortAssignments}
              isReusedSession={isReusedSession}
              onViewConversation={onViewConversation}
            />
          )}
        </div>
      )}
      {/* Outside the disclosure: what the round spent and what it produced is
          round metadata the list states up front, not part of the artifacts a
          reader has to ask for. */}
      <RoundFooter row={row} />
    </div>
  );
}

export default function ValidationRoundsCard({
  rows,
  contextId,
  cohortAssignments,
  incidents,
  advisoryResponse,
  reusedRecords,
  unroundedRecords,
  focusedAdvisory = null,
  focusAnchorId,
  onViewConversation,
}: {
  rows: readonly ValidationRoundRow[];
  contextId: string;
  cohortAssignments: readonly { id: string; authority: ValidatorAuthority }[];
  incidents: Parameters<typeof deriveCohortRoundView>[0]["incidents"];
  advisoryResponse: Parameters<
    typeof deriveCohortRoundView
  >[0]["advisoryResponse"];
  /** The aggregates whose lane continued an earlier round's session. */
  reusedRecords: ReadonlySet<Timestamped<GraphWorkflowValidationResultEvent>>;
  /**
   * Results that belong to no round — an output-schema refusal is the engine's
   * verdict on a format turn, not a cohort's on the work. They are listed
   * separately rather than filed under a round they never had.
   */
  unroundedRecords: readonly Timestamped<GraphWorkflowValidationResultEvent>[];
  /** The advisory a deep link named, or null. */
  focusedAdvisory?: WorkflowAdvisoryIdentity | null;
  focusAnchorId: string;
  onViewConversation?: ViewConversation;
}): React.JSX.Element {
  // The row that RAISED the advisory, which is not the same question as the row
  // wearing its number: a reset restarts the numbering, so the current
  // attempt's round of that number is a different round that the link has no
  // business opening.
  const focusedRow =
    focusedAdvisory === null
      ? null
      : (rows.find(
          (row) =>
            row.seq === focusedAdvisory.roundSeq &&
            roundRaisedAdvisory(row, focusedAdvisory),
        ) ?? null);

  return (
    <section data-testid="validation-rounds">
      <GroupHeader label="Validation rounds" />
      {rows.length === 0 ? (
        <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
          No validation has run for this context yet.
        </p>
      ) : (
        rows.map((row) => (
          <RoundRow
            key={row.seq}
            row={row}
            contextId={contextId}
            cohortAssignments={cohortAssignments}
            incidents={incidents}
            advisoryResponse={advisoryResponse}
            isReusedSession={
              row.record !== null && reusedRecords.has(row.record)
            }
            focused={row === focusedRow}
            focusAnchorId={focusAnchorId}
            {...(onViewConversation ? { onViewConversation } : {})}
          />
        ))
      )}
      {unroundedRecords.length > 0 && (
        <div data-testid="unrounded-validations" className="mt-sm">
          <GroupHeader label="Other results" />
          {unroundedRecords.map((record, index) => (
            <ValidationCard
              key={`unrounded-${index}`}
              event={record}
              cohortAssignments={cohortAssignments}
              isReusedSession={reusedRecords.has(record)}
              onViewConversation={onViewConversation}
            />
          ))}
        </div>
      )}
      {/* A deep link has to land somewhere even when the round it names is not
          in the current attempt's list. It says only that — the record carries
          no attempt identity, so anything more would be a guess. */}
      {focusedAdvisory !== null && focusedRow === null && (
        <p
          data-testid="linked-round"
          data-round-seq={focusedAdvisory.roundSeq}
          className={cn(
            "mt-sm mb-0 font-mono text-[0.7rem] text-text-tertiary",
            focusedRoundClass,
          )}
          {...focusedRoundAttrs(focusAnchorId)}
        >
          Round {focusedAdvisory.roundSeq} is not in this context&apos;s current
          history.
        </p>
      )}
      <p className="mt-sm mb-0 font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
        Each finding stays owned by the seat that raised it.
      </p>
    </section>
  );
}
