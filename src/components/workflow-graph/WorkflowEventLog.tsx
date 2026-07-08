"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import dynamic from "next/dynamic";

const MarkdownContent = dynamic(() => import("@/components/MarkdownContent"), {
  ssr: false,
});
import CollapsibleText from "@/components/CollapsibleText";
import { cn } from "@/lib/ui/cn";
import { formatGraphWorkflowHaltReason } from "./ContextHaltCard";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  GraphWorkflowLaneKind,
  GraphWorkflowMergeStatusValue,
  GraphWorkflowContextStatus,
  GraphWorkflowSSEEvent,
} from "@/lib/workflows/schemas";
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
            <div className="wb-markdown-inline">
              <MarkdownContent content={event.summary} />
            </div>
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
          <div className="wb-markdown-inline">
            <MarkdownContent content={event.summary} />
          </div>
        ) : null,
        expandable:
          event.issues.length > 0 ? (
            <ul className={eventIssuesClass}>
              {event.issues.map((issue, idx) => (
                <li key={idx}>
                  <strong>{issue.title}</strong>
                  <div className="wb-markdown-inline">
                    <MarkdownContent content={issue.description} />
                  </div>
                </li>
              ))}
            </ul>
          ) : null,
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

    case "graph-workflow-join-status": {
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
        `kind: ${event.kind}`,
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
        title: `Join ${event.status} · ${event.joinId}`,
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

const eventIssuesClass =
  "list-none p-0 m-0 flex flex-col gap-[8px] [&_li]:py-[6px] [&_li]:px-[8px] [&_li]:bg-[var(--cc-graph-ink-a40)] [&_li]:border [&_li]:border-border-dim [&_li]:rounded-sm [&_strong]:block [&_strong]:text-text-primary [&_strong]:text-[0.72rem] [&_strong]:font-semibold [&_strong]:mb-[2px]";

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
