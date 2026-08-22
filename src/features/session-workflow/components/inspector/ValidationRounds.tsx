"use client";

import { useMemo } from "react";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import CollapsibleText from "@/components/CollapsibleText";
import { StatusChip } from "@/components/ui/StatusChip";
import { cn } from "@/lib/ui/cn";
import { formatAgentProfileRef } from "@/lib/agent-profiles/schemas";
import type {
  GraphWorkflowValidationResultEvent,
  GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaneKind,
  GraphWorkflowValidationReviewArtifact,
} from "@/lib/workflow-graph/schemas";
import type { ValidatorAuthority } from "@/lib/workflow-graph/config-schemas";
import { AuthorityChip } from "../CohortRoundCard";
import {
  authorityOfSeat,
  type CohortMemberAuthority,
} from "../cohort-round-view";
import { formatInspectorTimestamp, inspectorFocusRingClass } from "./chrome";
import { LoopIcon } from "./icons";
import type { Timestamped } from "./history-entries";

/**
 * History tab → Rounds (§11): one validation round as it was recorded — the
 * cohort seats that ran it, each specialist's verdict and issues, the response
 * artifact, and the transcript each one came from.
 *
 * Lifted out of the inspector monolith unchanged; the redesign of this surface
 * belongs to execution-history-log.
 */

const wbBtn = cn(
  "inline-flex cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-border-default font-medium whitespace-nowrap transition-all duration-150",
  inspectorFocusRingClass,
);
const wbBtnXs =
  "text-[0.7rem] py-[3px] px-[8px] h-[22px] max-768:h-auto max-768:min-h-[44px] max-768:px-md";
const wbBtnDefault =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:text-text-primary hover:border-border-strong";

const wbValidationSectionLabel =
  "text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-text-tertiary mb-1 mt-2 first:mt-0";
const wbValidationBody = "mt-2 pl-[14px]";
const wbValidationIssuesList =
  "list-none p-0 m-0 border-l-2 border-border-default pl-[10px]";
const wbValidationIssue =
  "py-1 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border-dim";
const wbValidationIssueTitle =
  "text-[0.72rem] font-semibold text-text-primary leading-[1.3]";
const wbValidationIssueDesc = "mt-px";

/** Opening a specialist's transcript is the host's: the rail does not own the Log. */
export type ViewConversation = (
  conversationId: string,
  lane: GraphWorkflowLaneKind,
  contextId: string,
  label?: string,
) => void;

export function computeReusedSessions(
  events: Timestamped<GraphWorkflowValidationResultEvent>[],
): Set<number> {
  const seenByLane = new Map<string, string>();
  const reusedIndices = new Set<number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const ref = event.sessionRef;
    if (!ref) continue;
    const sessionId = ref.workflowConversationId ?? ref.ref;
    const laneKey = `${ref.lane}:${ref.backend}`;
    const seen = seenByLane.get(laneKey);
    if (seen !== undefined && seen === sessionId) {
      reusedIndices.add(i);
    } else {
      seenByLane.set(laneKey, sessionId);
    }
  }
  return reusedIndices;
}

// ---- Validator response parsing ----

interface ParsedValidatorResponse {
  summary: string;
  issues: Array<{ title: string; description: string }>;
}

function parseValidatorResponseArtifact(
  response: string,
): ParsedValidatorResponse | null {
  try {
    const parsed: unknown = JSON.parse(response);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "summary" in parsed &&
      typeof (parsed as Record<string, unknown>).summary === "string"
    ) {
      const obj = parsed as Record<string, unknown>;
      const issues = Array.isArray(obj.issues)
        ? (obj.issues as unknown[]).filter(
            (item): item is { title: string; description: string } =>
              typeof item === "object" &&
              item !== null &&
              "title" in item &&
              typeof (item as Record<string, unknown>).title === "string" &&
              "description" in item &&
              typeof (item as Record<string, unknown>).description === "string",
          )
        : [];
      return { summary: obj.summary as string, issues };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Structured Validation Result Card ----

function getLaneBadgeLabel(lane: GraphWorkflowLaneKind | undefined): string {
  if (lane === "context_validator") return "Context";
  return "";
}

function formatBackendName(backend: string): string {
  return `${backend.slice(0, 1).toUpperCase()}${backend.slice(1)}`;
}

function ResponseArtifactSection({
  reviewArtifact,
}: {
  reviewArtifact: Extract<
    GraphWorkflowValidationReviewArtifact,
    { kind: "response" }
  >;
}) {
  const parsed = useMemo(
    () => parseValidatorResponseArtifact(reviewArtifact.response),
    [reviewArtifact.response],
  );

  return (
    <div className="mt-2 pl-[14px]">
      <div className={wbValidationSectionLabel}>
        {formatBackendName(reviewArtifact.backend)} Review
      </div>
      <div className="mb-1 text-[0.7rem] text-text-tertiary">
        Reference:{" "}
        <code className="font-mono text-[0.7rem] text-text-secondary">
          {reviewArtifact.ref}
        </code>
      </div>
      {reviewArtifact.response && (
        <CollapsibleText maxCollapsedHeight={120}>
          {parsed ? (
            <>
              <CompactMarkdown content={parsed.summary} />
              {parsed.issues.length > 0 && (
                <div className={wbValidationBody}>
                  <div className={wbValidationSectionLabel}>
                    Issues ({parsed.issues.length})
                  </div>
                  <ul className={wbValidationIssuesList}>
                    {parsed.issues.map((issue, idx) => (
                      <li key={idx} className={wbValidationIssue}>
                        <div className={wbValidationIssueTitle}>
                          {issue.title}
                        </div>
                        <div className={wbValidationIssueDesc}>
                          <CompactMarkdown content={issue.description} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <CompactMarkdown content={reviewArtifact.response} />
          )}
        </CollapsibleText>
      )}
      {reviewArtifact.usage && (
        <div className="mt-1 text-[0.7rem] text-text-tertiary">
          {reviewArtifact.usage.inputTokens}↑{" "}
          {reviewArtifact.usage.cachedInputTokens}⊙{" "}
          {reviewArtifact.usage.outputTokens}↓ tokens
        </div>
      )}
    </div>
  );
}

/** The header a cohort member's transcript opens under. */
export function assignmentTranscriptLabel(assignmentId: string): string {
  return `Validator · ${assignmentId}`;
}

/**
 * ONE cohort member's verdict, nested inside the aggregate round result.
 *
 * Nested rather than listed as a sibling: the aggregate is the deterministic
 * outcome the engine acted on, and a member card floating beside it would read
 * as a second, competing result. Everything here is the member's own —
 * identity, verdict, issues, artifact and lane — so no reader has to attribute
 * a finding by position.
 */
function SpecialistCard({
  specialist,
  contextId,
  authority,
  onViewConversation,
}: {
  specialist: GraphWorkflowValidationSpecialistEntry;
  contextId: string;
  /** This seat's blocking power, read from the cohort as configured now. */
  authority: CohortMemberAuthority;
  onViewConversation?: ViewConversation;
}): React.JSX.Element {
  const sessionRef = specialist.sessionRef;
  const conversationId = sessionRef?.workflowConversationId;
  const reviewArtifact = specialist.reviewArtifact;

  return (
    <div
      className="border-x-0 border-t border-b-0 border-solid border-border-dim py-[8px] first:border-t-0"
      data-testid="validation-specialist"
      data-assignment-id={specialist.assignmentId}
      data-verdict={specialist.pass ? "pass" : "fail"}
      data-authority={authority}
    >
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
          {specialist.assignmentId}
        </span>
        <span
          className="font-mono text-[0.7rem] text-text-tertiary"
          data-testid="validation-specialist-profile"
        >
          {`${formatAgentProfileRef(specialist.profile)}@${specialist.profile.revision}`}
        </span>
        <AuthorityChip authority={authority} />
        <StatusChip tone={specialist.pass ? "green" : "red"}>
          {specialist.pass ? "Passed" : "Rejected"}
        </StatusChip>
        {conversationId !== undefined && sessionRef && onViewConversation && (
          <button
            className={cn(
              wbBtn,
              wbBtnXs,
              wbBtnDefault,
              "ml-auto text-[0.7rem]",
            )}
            onClick={() =>
              onViewConversation(
                conversationId,
                sessionRef.lane,
                contextId,
                assignmentTranscriptLabel(specialist.assignmentId),
              )
            }
            type="button"
          >
            View Transcript
          </button>
        )}
      </div>
      <div className="mt-[4px] min-w-0 text-[0.72rem]">
        <CompactMarkdown content={specialist.summary} />
      </div>
      {reviewArtifact?.kind === "response" && (
        <ResponseArtifactSection reviewArtifact={reviewArtifact} />
      )}
      {specialist.issues.length > 0 && (
        <div className={wbValidationBody}>
          <div className={wbValidationSectionLabel}>
            Issues ({specialist.issues.length})
          </div>
          <CollapsibleText maxCollapsedHeight={140}>
            <ul className={wbValidationIssuesList}>
              {specialist.issues.map((issue, idx) => (
                <li key={idx} className={wbValidationIssue}>
                  <div className={wbValidationIssueTitle}>
                    {issue.path !== undefined ? (
                      <code className="mr-[6px] font-mono text-amber">
                        {issue.path}
                      </code>
                    ) : (
                      issue.title
                    )}
                  </div>
                  <div className={wbValidationIssueDesc}>
                    <CompactMarkdown content={issue.description} />
                  </div>
                </li>
              ))}
            </ul>
          </CollapsibleText>
        </div>
      )}
    </div>
  );
}

/**
 * The attributes that mark a round record as the one a deep link landed on.
 *
 * The ring is driven by the data attribute rather than by `:focus-visible`,
 * because the focus that put the reader here was programmatic — the browser
 * heuristic would leave the destination unmarked exactly when it matters most.
 */
export const focusedRoundClass =
  "rounded-sm [outline:2px_solid_var(--color-cyan)] outline-offset-2";

export function focusedRoundAttrs(anchorId: string) {
  return { id: anchorId, tabIndex: -1, "data-focused-round": "true" } as const;
}

/**
 * The cohort seats of the context an event belongs to, as configured NOW. The
 * event froze a roster; authority is deliberately not read from it, exactly as
 * `deriveCohortRoundView` does for the live round — a seat holds the blocking
 * power it holds now, and the two round surfaces must not disagree.
 */
export function cohortAssignmentsFor(
  execution: GraphWorkflowExecution,
  contextId: string,
): readonly { id: string; authority: ValidatorAuthority }[] {
  return (
    execution.workingDefinition.executionContexts.find(
      (ctx) => ctx.id === contextId,
    )?.contextValidator?.assignments ?? []
  );
}

export default function ValidationCard({
  event,
  cohortAssignments,
  isReusedSession,
  onViewConversation,
  focusAnchorId,
}: {
  event: Timestamped<GraphWorkflowValidationResultEvent>;
  cohortAssignments: readonly { id: string; authority: ValidatorAuthority }[];
  isReusedSession?: boolean;
  onViewConversation?: ViewConversation;
  /** Set on the ONE card a round deep link is aimed at; absent on the rest. */
  focusAnchorId?: string;
}) {
  const specialists = event.specialists ?? [];
  // A rejecting cohort publishes each finding TWICE: `concludeCohort`
  // concatenates every failing lane's findings onto the aggregate, and each
  // lane's entry carries its own copy. Rendering both lists would show every
  // finding twice, and the aggregate copy carries no visible attribution — so
  // an attributed finding is rendered only in its assignment's group.
  //
  // Filtered by attribution rather than by "a cohort is present": a finding
  // that names no listed assignment (a round-level objection, an
  // output-schema rejection) has no group to fall into, and dropping it would
  // lose a real finding rather than a duplicate.
  const specialistIds = new Set(
    specialists.map((specialist) => specialist.assignmentId),
  );
  const aggregateIssues =
    specialists.length === 0
      ? event.issues
      : event.issues.filter(
          (issue) =>
            issue.assignmentId === undefined ||
            !specialistIds.has(issue.assignmentId),
        );
  const hasIssues = aggregateIssues.length > 0;
  const sessionRef = event.sessionRef;
  const reviewArtifact = event.reviewArtifact;
  // An output-schema rejection is the engine's own verdict on a format turn,
  // not a lane agent's review: it has no validator lane to badge and no
  // validator transcript to open, so both affordances are withheld rather than
  // pointed at the implementer conversation that happened to host the turn.
  const isOutputSchema = event.kind === "output_schema";
  const workflowConversationId = isOutputSchema
    ? undefined
    : sessionRef?.workflowConversationId;

  const laneBadge = isOutputSchema ? "" : getLaneBadgeLabel(sessionRef?.lane);

  return (
    <div
      className={cn(
        "border-x-0 border-t-0 border-b border-solid border-border-dim py-[10px] last:border-b-0",
        focusAnchorId !== undefined && focusedRoundClass,
      )}
      data-testid="validation-aggregate"
      data-round-seq={event.roundSeq ?? undefined}
      {...(focusAnchorId !== undefined ? focusedRoundAttrs(focusAnchorId) : {})}
    >
      <div className="flex items-start gap-[8px] text-[0.72rem]">
        <span
          className={cn(
            "mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full",
            event.pass
              ? "bg-green shadow-[0_0_6px_var(--green-glow)]"
              : "bg-red",
          )}
        />
        <div className="min-w-0 flex-1">
          <CompactMarkdown content={event.summary} />
        </div>
        {event.roundSeq !== null && event.roundSeq !== undefined && (
          <span className="shrink-0 font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
            Round {event.roundSeq}
          </span>
        )}
        <span className="shrink-0 text-[0.7rem] whitespace-nowrap text-text-tertiary">
          {formatInspectorTimestamp(event.occurredAt)}
        </span>
      </div>
      {(sessionRef || isOutputSchema) && (
        <div className="mt-[5px] flex flex-wrap items-center gap-[5px] pl-[14px]">
          {isOutputSchema && (
            <span className="rounded-[3px] border border-solid border-[var(--cc-red-a25)] bg-red-glow px-[5px] py-px text-[0.7rem] font-bold tracking-[0.06em] text-red uppercase">
              Output schema
            </span>
          )}
          {laneBadge && (
            <span className="rounded-[3px] bg-blue-glow px-[5px] py-px text-[0.7rem] font-bold tracking-[0.06em] text-blue uppercase">
              {laneBadge}
            </span>
          )}
          {sessionRef && (
            <span className="rounded-[3px] bg-bg-raised px-[5px] py-px text-[0.7rem] text-text-tertiary">
              {sessionRef.backend}
            </span>
          )}
          {isReusedSession && (
            <span className="inline-flex items-center gap-[4px] text-[0.7rem] text-text-tertiary opacity-80">
              <LoopIcon size={10} /> continued
            </span>
          )}
          {workflowConversationId && sessionRef && onViewConversation && (
            <button
              className={cn(
                wbBtn,
                wbBtnXs,
                wbBtnDefault,
                "ml-auto text-[0.7rem]",
              )}
              onClick={() =>
                onViewConversation(
                  workflowConversationId,
                  sessionRef.lane,
                  event.contextId,
                )
              }
              type="button"
            >
              View Transcript
            </button>
          )}
        </div>
      )}
      {reviewArtifact?.kind === "response" && (
        <ResponseArtifactSection reviewArtifact={reviewArtifact} />
      )}
      {hasIssues && (
        <div
          className={wbValidationBody}
          data-testid="validation-aggregate-issues"
        >
          <div className={wbValidationSectionLabel}>
            {specialists.length > 0 ? "Unattributed Issues" : "Issues"} (
            {aggregateIssues.length})
          </div>
          <CollapsibleText maxCollapsedHeight={140}>
            <ul className={wbValidationIssuesList}>
              {aggregateIssues.map((issue, idx) => (
                <li key={idx} className={wbValidationIssue}>
                  <div className={wbValidationIssueTitle}>
                    {/* This list is the one place a finding can appear outside
                        its assignment group, so a finding that DOES name a
                        raiser carries it inline rather than reading as
                        anonymous. */}
                    {issue.assignmentId !== undefined && (
                      <span className="mr-[6px] font-mono text-[0.7rem] text-text-tertiary">
                        {issue.assignmentId}
                      </span>
                    )}
                    {/* A path-carrying issue titles itself with a machine
                        locator; an agent validator's issues are prose. Mono
                        + amber is the same locator recipe the halt surfaces
                        use, so one instance path reads alike everywhere. */}
                    {issue.path !== undefined ? (
                      <code className="mr-[6px] font-mono text-amber">
                        {issue.path}
                      </code>
                    ) : (
                      issue.title
                    )}
                  </div>
                  <div className={wbValidationIssueDesc}>
                    <CompactMarkdown content={issue.description} />
                  </div>
                </li>
              ))}
            </ul>
          </CollapsibleText>
        </div>
      )}
      {specialists.length > 0 && (
        <div className={wbValidationBody}>
          <div className={wbValidationSectionLabel}>
            Cohort ({specialists.length})
          </div>
          {specialists.map((specialist) => (
            <SpecialistCard
              key={specialist.assignmentId}
              specialist={specialist}
              contextId={event.contextId}
              authority={authorityOfSeat(
                cohortAssignments,
                specialist.assignmentId,
              )}
              {...(onViewConversation ? { onViewConversation } : {})}
            />
          ))}
        </div>
      )}
      {event.reopenTaskIds.length > 0 && (
        <div className={wbValidationBody}>
          <div className={wbValidationSectionLabel}>
            Reopened Tasks ({event.reopenTaskIds.length})
          </div>
          <ul className={wbValidationIssuesList}>
            {event.reopenTaskIds.map((taskId) => (
              <li key={taskId} className={wbValidationIssue}>
                <div className={wbValidationIssueTitle}>
                  <code>{taskId}</code>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
