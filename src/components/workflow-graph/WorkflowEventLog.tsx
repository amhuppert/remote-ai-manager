"use client";

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import dynamic from "next/dynamic";

const MarkdownContent = dynamic(() => import("@/components/MarkdownContent"), {
  ssr: false,
});
import CollapsibleText from "@/components/CollapsibleText";
import { formatGraphWorkflowHaltReason } from "./ContextHaltCard";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  GraphWorkflowLaneKind,
  GraphWorkflowMergeStatusValue,
  GraphWorkflowContextStatus,
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
            <pre className="wb-exec-event-pre">{event.failureMessage}</pre>
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
          <pre className="wb-exec-event-pre">{event.lastMergeError}</pre>
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
            <ul className="wb-exec-event-issues">
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
          <pre className="wb-exec-event-pre">{errorSummary}</pre>
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
    case "graph-workflow-charter-registered":
    case "graph-workflow-charter-updated":
      return null;
  }
}

function dotClassName(dot: EventDotKind): string {
  return `wb-exec-event-dot wb-exec-event-dot--${dot}`;
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
    <div className={`wb-exec-event ${expanded ? "expanded" : ""}`.trim()}>
      <div
        className="wb-exec-event-header"
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
        <span className="wb-exec-event-text">{event.title}</span>
        {event.contextId && onSelectContext && (
          <button
            type="button"
            className="wb-exec-event-jump"
            onClick={(e) => {
              e.stopPropagation();
              if (event.contextId) onSelectContext(event.contextId);
            }}
            title="Open context"
          >
            ↗
          </button>
        )}
        <span className="wb-exec-event-timestamp">
          {formatTimestamp(event.occurredAt)}
        </span>
        {isClickable && (
          <span className="wb-exec-event-caret" aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
        )}
      </div>
      {expanded && hasDetail && (
        <div className="wb-exec-event-detail">
          <CollapsibleText maxCollapsedHeight={140}>
            {event.detail}
          </CollapsibleText>
        </div>
      )}
      {expanded && hasExpandable && (
        <div className="wb-exec-event-detail">{event.expandable}</div>
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
    const normalized: NormalizedEvent[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
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
      normalized.push(normalizedEvent);
      if (limit && normalized.length >= limit) break;
    }
    return normalized;
  }, [events, contextLookup, taskLookup, contextId, limit]);

  if (normalizedEvents.length === 0) {
    return (
      <div className="wb-exec-event-empty">
        <span className="wb-exec-event-text">No events yet</span>
      </div>
    );
  }

  return (
    <div className="wb-exec-event-log">
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
