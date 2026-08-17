"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import CollapsibleText from "@/components/CollapsibleText";
import { cn } from "@/lib/ui/cn";
import { formatGraphWorkflowHaltReason } from "./ContextHaltCard";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowMergeStatusValue,
  GraphWorkflowSSEEvent,
  GraphWorkflowValidationIncidentEvent,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaneKind,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowContextStatus } from "@/lib/workflow-graph/definition-schemas";
type EventDotKind =
  | "pass"
  | "fail"
  | "retry"
  | "breaker"
  | "merge-start"
  | "merge-success"
  | "merge-fail"
  | "task-completed"
  | "task-failed"
  | "task-running"
  | "context-running"
  | "context-completed"
  | "context-halted"
  | "context-ready"
  | "workflow-paused"
  | "workflow-resumed"
  | "workflow-aborted"
  | "workflow-halted"
  | "workflow-completed"
  | "neutral";

export interface NormalizedEvent {
  key: string;
  occurredAt: string;
  contextId: string | null;
  dot: EventDotKind;
  title: string;
  detail: ReactNode | null;
  expandable: ReactNode | null;
}

interface WorkflowEventLogProps {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  contextId?: string | null;
  limit?: number;
  onSelectContext?: (contextId: string) => void;
  onViewConversation?: (
    conversationId: string,
    lane: GraphWorkflowLaneKind,
    contextId: string,
  ) => void;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildContextLookup(
  execution: GraphWorkflowExecution,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const ctx of execution.workingDefinition.executionContexts) {
    map.set(ctx.id, ctx.title);
  }
  return map;
}

function buildTaskLookup(
  execution: GraphWorkflowExecution,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const task of execution.workingDefinition.tasks) {
    map.set(task.id, task.title);
  }
  return map;
}

function formatMergeStatus(
  status: GraphWorkflowMergeStatusValue,
): { dot: EventDotKind; verb: string } | null {
  switch (status) {
    case "in-progress":
      return { dot: "merge-start", verb: "Merging" };
    case "merged-success":
      return { dot: "merge-success", verb: "Merged" };
    case "merged-failed":
      return { dot: "merge-fail", verb: "Merge failed" };
    case "conflicts":
      return { dot: "merge-fail", verb: "Merge conflicts" };
    case "pending":
    case "not-applicable":
      return null;
  }
}

function contextStatusToDot(status: GraphWorkflowContextStatus): EventDotKind {
  switch (status) {
    case "running":
      return "context-running";
    case "completed":
      return "context-completed";
    case "halted":
      return "context-halted";
    case "ready":
      return "context-ready";
    case "pending":
      return "neutral";
    case "awaiting_approval":
      return "neutral";
    case "awaiting_user_input":
      return "neutral";
    case "skipped":
      return "neutral";
  }
}

function contextStatusVerb(status: GraphWorkflowContextStatus): string {
  switch (status) {
    case "running":
      return "started";
    case "completed":
      return "completed";
    case "halted":
      return "halted";
    case "ready":
      return "ready";
    case "pending":
      return "pending";
    case "awaiting_approval":
      return "awaiting approval";
    case "awaiting_user_input":
      return "awaiting input";
    case "skipped":
      return "skipped";
  }
}

/**
 * What a non-verdict outcome did to the round, said in the reader's terms.
 *
 * The distinction that matters on a log is whether anything happens next on its
 * own: a restarted round re-freezes and re-runs, an unconcludable one waits for
 * an operator, and a dropped write changed nothing at all.
 */
function incidentHeadline(
  incident: GraphWorkflowValidationIncidentEvent["incident"],
): string {
  switch (incident) {
    case "infra_exhausted":
      return "Validation round could not conclude:";
    case "infra_failure":
      return "Validator retrying after an infrastructure failure in round";
    case "round_superseded":
      return "Dropped a validator result for superseded round";
    case "stale_result_rejected":
      return "Rejected a stale validator result in round";
    default:
      return "Validation round restarted:";
  }
}

function normalizeEvent(
  entry: GraphWorkflowExecutionEvent,
  index: number,
  contextLookup: Map<string, string>,
  taskLookup: Map<string, string>,
): NormalizedEvent | null {
  const { event, occurredAt } = entry;
  const key = `${event.type}-${index}-${occurredAt}`;
  switch (event.type) {
    case "graph-workflow-boundary":
    case "graph-workflow-result-recorded":
      return null;
    case "graph-workflow-task-status": {
      if (event.status === "pending" || event.status === "running") {
        if (event.status !== "running") return null;
        return {
          key,
          occurredAt,
          contextId: event.contextId,
          dot: "task-running",
          title: `Task running · ${taskLookup.get(event.taskId) ?? event.taskId}`,
          detail: null,
          expandable: null,
        };
      }
      if (event.status === "completed") {
        return {
          key,
          occurredAt,
          contextId: event.contextId,
          dot: "task-completed",
          title: `Task completed · ${taskLookup.get(event.taskId) ?? event.taskId}`,
          detail: event.summary ? (
            <CompactMarkdown content={event.summary} />
          ) : null,
          expandable: null,
        };
      }
      if (event.status === "failed") {
        return {
          key,
          occurredAt,
          contextId: event.contextId,
          dot: "task-failed",
          title: `Task failed · ${taskLookup.get(event.taskId) ?? event.taskId}`,
          detail: event.failureMessage ? (
            <pre className={eventPreClass}>{event.failureMessage}</pre>
          ) : null,
          expandable: null,
        };
      }
      if (event.status === "interrupted") {
        return {
          key,
          occurredAt,
          contextId: event.contextId,
          dot: "retry",
          title: `Task interrupted · ${taskLookup.get(event.taskId) ?? event.taskId}`,
          detail: null,
          expandable: null,
        };
      }
      return null;
    }

    case "graph-workflow-context-status": {
      const title = contextLookup.get(event.contextId) ?? event.contextId;
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: contextStatusToDot(event.status),
        title: `${title} · ${contextStatusVerb(event.status)}`,
        detail: null,
        expandable: null,
      };
    }

    case "graph-workflow-context-skipped": {
      const title = contextLookup.get(event.contextId) ?? event.contextId;
      // The verdicts are the substance of the row: "skipped" alone leaves an
      // operator unable to tell WHICH branch decided it.
      const vetoes = event.edgeEvaluations.filter(
        (evaluation) => evaluation.verdict === "inactive",
      );
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: "neutral",
        title: `${title} · skipped — branch not taken`,
        detail:
          vetoes.length > 0 ? (
            <span>
              {`${vetoes.map((evaluation) => evaluation.edgeId).join(", ")} did not activate`}
            </span>
          ) : null,
        expandable: null,
      };
    }

    case "graph-workflow-route-resolved": {
      const title =
        contextLookup.get(event.sourceContextId) ?? event.sourceContextId;
      // An unconditional source never emits this event, so a row here always
      // means a guard set decided something.
      const taken =
        event.activatedEdgeIds.length > 0
          ? event.activatedEdgeIds.join(", ")
          : "no branch";
      return {
        key,
        occurredAt,
        contextId: event.sourceContextId,
        dot: "neutral",
        title: `${title} · routes resolved — ${taken}`,
        detail:
          event.inactiveEdgeIds.length > 0 ? (
            <span>{`${event.inactiveEdgeIds.join(", ")} did not activate`}</span>
          ) : null,
        expandable: null,
      };
    }

    case "graph-workflow-loop-decision": {
      const exitTitle =
        contextLookup.get(event.exitContextId) ?? event.exitContextId;
      const outcome =
        event.outcome === "materialized"
          ? `pass ${event.nextPass ?? event.pass + 1} materialized`
          : event.outcome;
      return {
        key,
        occurredAt,
        contextId: event.exitContextId,
        dot: "neutral",
        title: `${event.loopGroupId} pass ${event.pass} · ${event.verdict} — ${outcome}`,
        detail: (
          <span>{`${exitTitle} · control revision ${event.loopControlRevision}, template v${event.templateVersion}`}</span>
        ),
        expandable: null,
      };
    }

    case "graph-workflow-merge-status": {
      const formatted = formatMergeStatus(event.mergeStatus);
      if (!formatted) return null;
      const title = contextLookup.get(event.contextId) ?? event.contextId;
      const branchSuffix = event.branchName ? ` → ${event.branchName}` : "";
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: formatted.dot,
        title: `${formatted.verb} · ${title}${branchSuffix}`,
        detail: event.lastMergeError ? (
          <pre className={eventPreClass}>{event.lastMergeError}</pre>
        ) : null,
        expandable: null,
      };
    }

    case "graph-workflow-validation-result": {
      const title = contextLookup.get(event.contextId) ?? event.contextId;
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: event.pass ? "pass" : "fail",
        title: `Validation ${event.pass ? "passed" : "failed"} · ${title}`,
        detail: event.summary ? (
          <CompactMarkdown content={event.summary} />
        ) : null,
        expandable:
          event.issues.length > 0 ? (
            <ul className={eventIssuesClass}>
              {event.issues.map((issue, idx) => (
                <li key={idx} className={eventIssueItemClass}>
                  <strong className={eventIssueTitleClass}>
                    {issue.title}
                  </strong>
                  <CompactMarkdown content={issue.description} />
                </li>
              ))}
            </ul>
          ) : null,
      };
    }

    // A cohort member's own verdict, while the round is still running. The log
    // shows the round's conclusion, not each reviewer reporting in — rendering
    // both would read as one context failing validation several times.
    case "graph-workflow-validation-specialist-result":
      return null;

    case "graph-workflow-validation-incident": {
      const title = contextLookup.get(event.contextId) ?? event.contextId;
      // Deliberately NOT a pass/fail dot: nobody rendered a verdict here, and a
      // red "fail" dot would read as the reviewer rejecting the work.
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: "retry",
        title: `${incidentHeadline(event.incident)} ${event.roundSeq} · ${title}`,
        detail: <p>{event.message}</p>,
        expandable: null,
      };
    }

    case "graph-workflow-circuit-breaker": {
      const title = contextLookup.get(event.contextId) ?? event.contextId;
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: "breaker",
        title: `Circuit breaker · ${title} (${event.failureCount} failures, ${event.condition})`,
        detail: event.summary ? <p>{event.summary}</p> : null,
        expandable: null,
      };
    }

    case "graph-workflow-execution-amended": {
      const added = [
        ...event.addedContextIds.map((id) => `context ${id}`),
        ...event.addedTaskIds.map((id) => `task ${id}`),
        ...event.addedEdgeIds.map((id) => `edge ${id}`),
      ];
      return {
        key,
        occurredAt,
        contextId: null,
        dot: "neutral",
        title: `Definition amended · ${added.length} addition${added.length === 1 ? "" : "s"} by ${event.actor}`,
        detail: <p>{event.reason}</p>,
        expandable: (
          <ul className={eventIssuesClass}>
            {added.map((entry) => (
              <li key={entry} className={eventIssueItemClass}>
                + {entry}
              </li>
            ))}
            <li className={eventIssueItemClass}>
              working definition {event.previousWorkingDefinitionHash} →{" "}
              {event.workingDefinitionHash}
            </li>
            <li className={eventIssueItemClass}>
              admitted by {event.policyBasis}
            </li>
          </ul>
        ),
      };
    }

    case "graph-workflow-execution-released": {
      return {
        key,
        occurredAt,
        contextId: null,
        dot: "neutral",
        title: `Slot released · ${event.status}${event.actor === null ? "" : ` by ${event.actor}`}`,
        detail: <p>{event.reason}</p>,
        expandable: null,
      };
    }

    case "graph-workflow-plan-repair": {
      const title = contextLookup.get(event.contextId) ?? event.contextId;
      const dot: EventDotKind =
        event.outcome === "repaired"
          ? "pass"
          : event.outcome === "superseded"
            ? "retry"
            : "fail";
      const suffix =
        event.outcome === "repaired"
          ? `${event.operationCount} op(s)${event.resumed ? ", resumed" : ""}`
          : event.outcome;
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot,
        title: `Plan repair · ${title} (attempt ${event.attempt}, ${suffix})`,
        detail: event.diagnosis ? (
          <pre className={eventPreClass}>{event.diagnosis}</pre>
        ) : null,
        expandable: null,
      };
    }

    case "graph-workflow-graph-expanded": {
      const invoker =
        contextLookup.get(event.invokerContextId) ?? event.invokerContextId;
      const summary =
        event.outcome === "accepted"
          ? `+${event.addedContextIds.length} context(s), +${event.addedTaskIds.length} task(s)`
          : (event.refusalCode ?? "refused");
      return {
        key,
        occurredAt,
        contextId: event.invokerContextId,
        dot: event.outcome === "accepted" ? "pass" : "fail",
        title: `Graph expansion · ${invoker} (${summary})`,
        detail:
          event.outcome === "accepted" && event.rejoinContextIds.length > 0 ? (
            <pre className={eventPreClass}>
              {`rejoins: ${event.rejoinContextIds.join(", ")}`}
            </pre>
          ) : null,
        expandable: null,
      };
    }

    case "graph-workflow-status": {
      const dot: EventDotKind = (() => {
        switch (event.workflowStatus) {
          case "paused":
            return "workflow-paused";
          case "running":
            return "workflow-resumed";
          case "aborted":
            return "workflow-aborted";
          case "halted":
            return "workflow-halted";
          case "completed":
            return "workflow-completed";
          case "pending":
            return "neutral";
        }
      })();
      const haltSummary = event.haltReason
        ? formatGraphWorkflowHaltReason(event.haltReason).headline
        : null;
      return {
        key,
        occurredAt,
        contextId: null,
        dot,
        title: `Workflow ${event.workflowStatus}`,
        detail: haltSummary ? <span>{haltSummary}</span> : null,
        expandable: null,
      };
    }

    case "graph-workflow-batch-scheduled": {
      const titles = event.contextIds
        .map((id) => contextLookup.get(id) ?? id)
        .join(", ");
      return {
        key,
        occurredAt,
        contextId: event.contextIds[0] ?? null,
        dot: "neutral",
        title: `Batch scheduled · ${titles}`,
        detail: null,
        expandable: null,
      };
    }

    case "graph-workflow-lane-status": {
      const laneLabel = event.branchName
        ? `${event.laneId} (${event.branchName})`
        : event.laneId;
      const memberSummary =
        event.includedContextIds.length > 0
          ? `members: ${event.includedContextIds
              .map((id) => contextLookup.get(id) ?? id)
              .join(", ")}`
          : null;
      const detailText = [
        `kind: ${event.kind}`,
        memberSummary,
        event.lastCommittingContextId
          ? `last commit: ${contextLookup.get(event.lastCommittingContextId) ?? event.lastCommittingContextId}`
          : null,
      ]
        .filter((s): s is string => s !== null)
        .join(" · ");
      return {
        key,
        occurredAt,
        contextId: event.lastCommittingContextId,
        dot: "neutral",
        title: `Lane ${event.status} · ${laneLabel}`,
        detail: detailText ? <span>{detailText}</span> : null,
        expandable: null,
      };
    }

    case "graph-workflow-lane-created":
      return {
        key,
        occurredAt,
        contextId: null,
        dot: "neutral",
        title: `Lane created · ${event.laneId}`,
        detail: (
          <span>
            {event.kind} · placement: {event.placementSource}
          </span>
        ),
        expandable: null,
      };

    case "graph-workflow-lane-concurrent-admission":
      return {
        key,
        occurredAt,
        contextId: event.memberContextIds[0] ?? null,
        dot: "task-running",
        title: `Concurrent lane admission · ${event.laneId}`,
        detail: (
          <span>
            {event.memberContextIds
              .map((id) => contextLookup.get(id) ?? id)
              .join(", ")}{" "}
            · canonical check: {event.canonicalCheckResult}
          </span>
        ),
        expandable: null,
      };

    case "graph-workflow-lane-landed": {
      const contextTitle =
        contextLookup.get(event.contextId) ?? event.contextId;
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: "task-completed",
        title: `Lane landed · ${contextTitle}`,
        detail: (
          <span>
            {event.laneId} · {event.commitSha ?? "no commit"}
            {event.ownedPathspec
              ? ` · paths: ${event.ownedPathspec.join(", ")}`
              : " · full worktree"}
          </span>
        ),
        expandable: null,
      };
    }

    case "graph-workflow-lane-drift-halted": {
      const contextTitle =
        contextLookup.get(event.contextId) ?? event.contextId;
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: "task-failed",
        title: `Lane drift halted · ${event.laneId} · ${contextTitle}`,
        detail: <span>{event.unattributedPaths.join(", ")}</span>,
        expandable: null,
      };
    }

    case "graph-workflow-plan-defect-halted": {
      const contextTitle =
        contextLookup.get(event.contextId) ?? event.contextId;
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: "task-failed",
        title: `Plan defect halted · ${contextTitle}${
          event.roundSeq === null ? "" : ` · round ${event.roundSeq}`
        }`,
        detail: (
          <span>
            {event.defects
              .map((defect) => `${defect.conflictingContract}: ${defect.title}`)
              .join(" · ")}
          </span>
        ),
        expandable: null,
      };
    }

    case "graph-workflow-lane-commit": {
      const contextTitle =
        contextLookup.get(event.contextId) ?? event.contextId;
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot: "neutral",
        title: `Lane commit · ${contextTitle}`,
        detail: (
          <span>
            {event.laneId} · {event.sha}
          </span>
        ),
        expandable: null,
      };
    }

    case "graph-workflow-join-status": {
      const joinLabel =
        event.kind === "final_publish" ? "Session publish" : "Join";
      const kindLabel =
        event.kind === "final_publish" ? "session publish" : "context merge";
      const sourceSummary = event.sourceLaneIds.join(", ");
      const progress =
        event.mergedSourceLaneIds.length > 0
          ? `merged: ${event.mergedSourceLaneIds.join(", ")}`
          : null;
      const errorSummary =
        event.status === "failed" || event.status === "conflicts"
          ? event.errorMessage
          : null;
      const dot: EventDotKind =
        event.status === "succeeded"
          ? "task-completed"
          : event.status === "failed" || event.status === "conflicts"
            ? "task-failed"
            : event.status === "running"
              ? "task-running"
              : "neutral";
      const detailText = [
        `kind: ${kindLabel}`,
        `sources: ${sourceSummary} -> ${event.targetLaneId}`,
        progress,
      ]
        .filter((s): s is string => s !== null)
        .join(" · ");
      return {
        key,
        occurredAt,
        contextId: event.contextId,
        dot,
        title: `${joinLabel} ${event.status} · ${event.joinId}`,
        detail: errorSummary ? (
          <pre className={eventPreClass}>{errorSummary}</pre>
        ) : detailText ? (
          <span>{detailText}</span>
        ) : null,
        expandable: null,
      };
    }

    case "graph-workflow-shared-documents-updated":
    case "graph-workflow-pending-halt-reason":
    case "graph-workflow-approval-pending":
    case "graph-workflow-approval-resolved":
    case "graph-workflow-user-input-pending":
    case "graph-workflow-user-input-resolved":
    case "graph-workflow-charter-registered":
    case "graph-workflow-charter-updated":
    case "graph-workflow-live-edit-applied":
      return null;
  }
}

const eventPreClass =
  "font-mono text-[0.7rem] bg-[var(--cc-graph-ink-a40)] border border-border-dim rounded-sm py-[6px] px-[8px] m-0 whitespace-pre-wrap break-words text-text-secondary max-h-[160px] overflow-auto";

const eventIssuesClass = "list-none p-0 m-0 flex flex-col gap-[8px]";

const eventIssueItemClass =
  "py-[6px] px-[8px] bg-[var(--cc-graph-ink-a40)] border border-border-dim rounded-sm";

const eventIssueTitleClass =
  "block text-text-primary text-[0.72rem] font-semibold mb-[2px]";

const dotBaseClass = "w-[6px] h-[6px] rounded-full shrink-0";

const dotStatusClass: Record<EventDotKind, string> = {
  pass: "bg-green shadow-[0_0_6px_var(--green-glow)]",
  fail: "bg-red",
  retry: "bg-amber shadow-[0_0_6px_var(--amber-glow)]",
  breaker:
    "bg-red shadow-[0_0_0_1px_var(--cc-red-a40),0_0_6px_var(--cc-red-a50)]",
  "merge-start":
    "bg-green shadow-[0_0_6px_var(--green-glow)] animate-[pulse-dot_1.2s_ease-in-out_infinite]",
  "merge-success": "bg-green shadow-[0_0_6px_var(--green-glow)]",
  "merge-fail": "bg-red",
  "task-completed": "bg-green",
  "task-running": "bg-cyan shadow-[0_0_6px_var(--cyan-glow)]",
  "task-failed": "bg-red",
  "context-running": "bg-cyan shadow-[0_0_6px_var(--cyan-glow)]",
  "context-completed": "bg-green shadow-[0_0_6px_var(--green-glow)]",
  "context-halted": "bg-red",
  "context-ready": "bg-text-tertiary",
  "workflow-paused": "bg-amber",
  "workflow-resumed": "bg-cyan shadow-[0_0_6px_var(--cyan-glow)]",
  "workflow-aborted": "bg-text-tertiary",
  "workflow-halted": "bg-red",
  "workflow-completed": "bg-green shadow-[0_0_6px_var(--green-glow)]",
  neutral: "bg-text-tertiary",
};

function dotClassName(dot: EventDotKind): string {
  return cn(dotBaseClass, dotStatusClass[dot]);
}

// Identifies the entity whose status a given event reports, so consecutive
// re-affirmations of the same rendered status for that entity can be collapsed.
// Status-bearing events (workflow/context/task/merge/lane/join) re-fire whenever
// an ancillary field changes (e.g. activeContextIds, iterationCount) even though
// the human-readable row is identical; one-shot events (validation, circuit
// breaker, batch scheduled) return null and are never collapsed.
function eventStreamKey(event: GraphWorkflowSSEEvent): string | null {
  switch (event.type) {
    case "graph-workflow-status":
      return "workflow-status";
    case "graph-workflow-context-status":
      return `context-status:${event.contextId}`;
    case "graph-workflow-task-status":
      return `task-status:${event.taskId}`;
    case "graph-workflow-merge-status":
      return `merge-status:${event.contextId}`;
    case "graph-workflow-lane-status":
      return `lane-status:${event.laneId}`;
    case "graph-workflow-lane-commit":
      return null;
    case "graph-workflow-join-status":
      return `join-status:${event.joinId}`;
    default:
      return null;
  }
}

function EventRow({
  event,
  onSelectContext,
}: {
  event: NormalizedEvent;
  onSelectContext?: (contextId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = event.detail != null;
  const hasExpandable = event.expandable != null;
  const isClickable = hasExpandable || hasDetail;

  return (
    <div
      data-expanded={expanded}
      className="border-b border-border-dim py-[8px] [contain-intrinsic-size:auto_32px] [content-visibility:auto] last:border-b-0 data-[expanded=true]:bg-[var(--cc-white-a015)]"
    >
      <div
        className="flex items-center gap-[8px] text-[0.72rem]"
        role={isClickable ? "button" : undefined}
        tabIndex={isClickable ? 0 : -1}
        onClick={() => {
          if (isClickable) setExpanded((v) => !v);
        }}
        onKeyDown={(e) => {
          if (isClickable && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        style={isClickable ? { cursor: "pointer" } : undefined}
      >
        <span className={dotClassName(event.dot)} aria-hidden="true" />
        <span className="min-w-0 flex-1 text-text-secondary">
          {event.title}
        </span>
        {event.contextId && onSelectContext && (
          <button
            type="button"
            className="cursor-pointer rounded-[3px] border border-border-subtle bg-transparent px-[6px] py-0 font-[inherit] text-[0.7rem] leading-[1.4] text-text-tertiary hover:border-cyan-dim hover:bg-[var(--cc-cyan-a05)] hover:text-cyan"
            onClick={(e) => {
              e.stopPropagation();
              if (event.contextId) onSelectContext(event.contextId);
            }}
            title="Open context"
          >
            ↗
          </button>
        )}
        <span className="ml-auto shrink-0 text-[0.7rem] whitespace-nowrap text-text-tertiary">
          {formatTimestamp(event.occurredAt)}
        </span>
        {isClickable && (
          <span
            className="ml-[4px] shrink-0 text-[0.65rem] text-text-tertiary"
            aria-hidden="true"
          >
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </div>
      {expanded && hasDetail && (
        <div className="mt-[4px] pl-[14px] text-[0.7rem] leading-[1.4] text-text-tertiary">
          <CollapsibleText maxCollapsedHeight={140}>
            {event.detail}
          </CollapsibleText>
        </div>
      )}
      {expanded && hasExpandable && (
        <div className="mt-[4px] pl-[14px] text-[0.7rem] leading-[1.4] text-text-tertiary">
          {event.expandable}
        </div>
      )}
    </div>
  );
}

export default function WorkflowEventLog({
  execution,
  events,
  contextId,
  limit,
  onSelectContext,
}: WorkflowEventLogProps) {
  const contextLookup = useMemo(
    () => buildContextLookup(execution),
    [execution],
  );
  const taskLookup = useMemo(() => buildTaskLookup(execution), [execution]);

  const normalizedEvents = useMemo(() => {
    // Walk oldest→newest, keeping the first event of each run of identical
    // rendered rows per entity. A status-bearing event re-fires whenever an
    // ancillary field changes (active-set, iteration count) while the rendered
    // status is unchanged; those re-fires would otherwise show as duplicate
    // rows. A genuine status transition (e.g. running→halted→running) breaks the
    // run because its rendered row differs, so it is preserved.
    const normalized: NormalizedEvent[] = [];
    const lastRowByStream = new Map<string, string>();
    for (let i = 0; i < events.length; i++) {
      const entry = events[i];
      if (!entry || entry.preReset) continue;
      const normalizedEvent = normalizeEvent(
        entry,
        i,
        contextLookup,
        taskLookup,
      );
      if (!normalizedEvent) continue;
      if (contextId && normalizedEvent.contextId !== contextId) continue;
      const streamKey = eventStreamKey(entry.event);
      if (streamKey) {
        const row = `${normalizedEvent.dot} ${normalizedEvent.title}`;
        if (lastRowByStream.get(streamKey) === row) continue;
        lastRowByStream.set(streamKey, row);
      }
      normalized.push(normalizedEvent);
    }
    normalized.reverse();
    return limit ? normalized.slice(0, limit) : normalized;
  }, [events, contextLookup, taskLookup, contextId, limit]);

  if (normalizedEvents.length === 0) {
    return (
      <div className="py-[8px] text-[0.72rem] text-text-tertiary italic">
        <span className="min-w-0 flex-1 text-text-secondary">
          No events yet
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {normalizedEvents.map((event) => (
        <EventRow
          key={event.key}
          event={event}
          onSelectContext={onSelectContext}
        />
      ))}
    </div>
  );
}
