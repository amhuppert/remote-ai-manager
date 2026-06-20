"use client";

import { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { cn } from "@/lib/ui/cn";

const wbBtn =
  "inline-flex items-center justify-center gap-[6px] font-medium rounded-sm cursor-pointer transition-all duration-150 border border-border-default whitespace-nowrap";
const wbBtnXs = "text-[0.7rem] py-[3px] px-[8px] h-[22px]";
const wbBtnSm = "text-[0.72rem] py-[5px] px-[12px] h-[28px]";
const wbBtnDefault =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:text-text-primary hover:border-border-strong";
const wbBtnPrimary =
  "bg-[var(--cc-cyan-a12)] text-cyan border-[var(--cyan-glow-strong)] hover:bg-[var(--cc-cyan-a20)] hover:shadow-[0_0_12px_var(--cyan-glow)]";
const wbBtnDanger =
  "bg-bg-raised text-red border-[var(--cc-red-a25)] hover:bg-[var(--cc-red-a10)]";

const wbInspector =
  "w-[340px] min-w-[340px] bg-bg-surface border-l border-border-subtle flex flex-col overflow-hidden max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:border-l-0 max-768:[.app[data-page=workflow][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow][data-mobile-panel=log]_&]:hidden";
const wbInspectorHeader =
  "flex items-center justify-between gap-sm py-3 px-md border-b border-border-dim min-h-[44px]";
const wbInspectorTitle =
  "text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-primary";
const wbInspectorBody = "flex-1 overflow-y-auto p-md";
const wbOverviewSection = "mb-lg";
const wbOverviewSectionTitle =
  "text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-secondary mb-sm pb-xs border-b border-border-dim";
const wbOverviewStatGrid = "grid grid-cols-2 gap-sm mb-lg";
const wbOverviewStat = "bg-bg-raised border border-border-dim rounded-md p-3";
const wbOverviewStatValue =
  "text-[1.4rem] font-bold text-text-primary leading-none mb-1";
const wbOverviewStatLabel =
  "text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

const wbExecEvent =
  "py-2 border-b border-border-dim last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_32px]";
const wbExecEventHeader = "flex items-center gap-[8px] text-[0.72rem]";
const wbExecEventText = "text-text-secondary flex-1 min-w-0";
const wbExecEventDetail =
  "text-[0.7rem] text-text-tertiary mt-1 pl-[14px] leading-[1.4]";
const wbExecEventTimestamp =
  "text-[0.7rem] text-text-tertiary whitespace-nowrap shrink-0 ml-auto";
const wbExecEventDotBreaker =
  "w-[6px] h-[6px] rounded-full shrink-0 bg-red shadow-[0_0_0_1px_var(--cc-red-a40),0_0_6px_var(--cc-red-a50)]";

const wbValidationSectionLabel =
  "text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-text-tertiary mb-1 mt-2 first:mt-0";
const wbValidationBody = "mt-2 pl-[14px]";
const wbValidationIssuesList =
  "list-none p-0 m-0 border-l-2 border-border-default pl-[10px]";
const wbValidationIssue =
  "py-1 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border-dim";
const wbValidationIssueTitle =
  "text-[0.72rem] font-semibold text-text-primary leading-[1.3]";
const wbValidationIssueDesc =
  "text-[0.7rem] text-text-tertiary leading-[1.4] mt-px";

const graphNodeBadgeBase =
  "text-[0.7rem] font-semibold uppercase tracking-[0.06em] py-1 px-[10px] rounded-[20px] whitespace-nowrap shrink-0 mt-[2px]";
const graphNodeBadgeByStatus: Record<string, string> = {
  pending: "bg-transparent text-text-tertiary border border-border-default",
  running:
    "bg-[var(--cc-cyan-a08)] text-cyan border border-[var(--cyan-glow-strong)]",
  completed:
    "bg-[var(--cc-green-a08)] text-green border border-[var(--cc-green-border)]",
  halted: "bg-[var(--cc-red-a08)] text-red border border-[var(--cc-red-a25)]",
  "awaiting-approval":
    "bg-[var(--cc-amber-a10)] text-amber border border-[var(--cc-amber-a30)]",
};

const taskStatusDotByStatus: Record<string, string> = {
  completed: "bg-green",
  running: "bg-cyan animate-[pulse-dot_2s_ease-in-out_infinite]",
  failed: "bg-red",
  pending: "bg-text-tertiary",
};

const wbFieldInput =
  "w-full bg-bg-base border border-border-default rounded-sm text-text-primary text-[0.78rem] py-2 px-[10px] outline-none transition-[border-color] duration-150 focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";
const wbFieldTextarea = "resize-y min-h-[64px] leading-[1.5]";
const wbTaskDetailInput =
  "w-full bg-bg-base border border-border-default rounded-sm text-text-primary text-[0.75rem] py-[7px] px-[10px] outline-none transition-[border-color] duration-150 box-border focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";
const wbTaskDetailTextarea = "resize-y min-h-[56px] mb-[2px]";

const MarkdownContent = dynamic(() => import("@/components/MarkdownContent"), {
  ssr: false,
});
import CollapsibleText from "@/components/CollapsibleText";
import ConfirmDialog from "@/components/ConfirmDialog";
import ContextHaltCard from "@/components/workflow-graph/ContextHaltCard";
import WorkflowEventLog from "@/components/workflow-graph/WorkflowEventLog";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowLaneKind,
  GraphWorkflowHaltReason,
} from "@/lib/workflows/schemas";
import { isTaskConversationLive, isTaskEditable } from "./task-runtime-state";

interface ExecutionInspectorPanelProps {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  selectedContextId: string | null;
  onSelectContext?: (contextId: string) => void;
  onDeselectContext: () => void;
  onAddTask: (contextId: string, title: string, instructions: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: { title?: string; instructions?: string },
  ) => void;
  onRemoveTask: (taskId: string) => void;
  onReorderTask: (contextId: string, orderedTaskIds: string[]) => void;
  onResetContext?: (contextId: string) => void;
  onViewTask: (taskId: string) => void;
  viewingTaskId: string | null;
  isMutating: boolean;
  onViewConversation?: (
    conversationId: string,
    lane: GraphWorkflowLaneKind,
    contextId: string,
  ) => void;
}

function findContextHaltReason(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowHaltReason | null {
  const all = [execution.haltReason, ...execution.secondaryHaltReasons].filter(
    (r): r is GraphWorkflowHaltReason => r != null,
  );
  for (const reason of all) {
    if ("contextId" in reason && reason.contextId === contextId) {
      return reason;
    }
  }
  return null;
}

function countMerges(execution: GraphWorkflowExecution): {
  merged: number;
  total: number;
} {
  let merged = 0;
  let total = 0;
  for (const state of Object.values(execution.contextStates)) {
    if (state.mergeStatus === "not-applicable") continue;
    total++;
    if (state.mergeStatus === "merged-success") merged++;
  }
  return { merged, total };
}

type DetailTab = "tasks" | "history";

type Timestamped<T> = T & { occurredAt: string };

function getContextTasks(execution: GraphWorkflowExecution, contextId: string) {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order);
}

function getHistoryEntries(
  events: GraphWorkflowExecutionEvent[],
  contextId?: string,
) {
  const validationEvents = events
    .filter(
      (
        entry,
      ): entry is {
        occurredAt: string;
        event: GraphWorkflowValidationResultEvent;
        preReset: boolean;
      } =>
        entry.event.type === "graph-workflow-validation-result" &&
        entry.preReset !== true &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map(
      (entry): Timestamped<GraphWorkflowValidationResultEvent> => ({
        ...entry.event,
        occurredAt: entry.occurredAt,
      }),
    )
    .reverse();
  const circuitBreakerEvents = events
    .filter(
      (
        entry,
      ): entry is {
        occurredAt: string;
        event: GraphWorkflowCircuitBreakerEvent;
        preReset: boolean;
      } =>
        entry.event.type === "graph-workflow-circuit-breaker" &&
        entry.preReset !== true &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map(
      (entry): Timestamped<GraphWorkflowCircuitBreakerEvent> => ({
        ...entry.event,
        occurredAt: entry.occurredAt,
      }),
    )
    .reverse();

  return { validationEvents, circuitBreakerEvents };
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

function getStatusBadgeClass(status?: string): string {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "halted":
      return "halted";
    case "awaiting_approval":
      return "awaiting-approval";
    default:
      return "pending";
  }
}

function getStatusLabel(status?: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "halted":
      return "Halted";
    case "ready":
      return "Ready";
    case "awaiting_approval":
      return "Awaiting Approval";
    default:
      return "Pending";
  }
}

function getTaskStatusDotClass(status?: string): string {
  switch (status) {
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function computeReusedSessions(
  events: Timestamped<GraphWorkflowValidationResultEvent>[],
): Set<number> {
  const seenByLane = new Map<string, string>();
  const reusedIndices = new Set<number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const ref = event.sessionRef;
    if (!ref) continue;
    const sessionId =
      ref.engine === "claude" ? ref.conversationId : ref.threadId;
    const laneKey = `${ref.lane}:${ref.engine}`;
    const seen = seenByLane.get(laneKey);
    if (seen !== undefined && seen === sessionId) {
      reusedIndices.add(i);
    } else {
      seenByLane.set(laneKey, sessionId);
    }
  }
  return reusedIndices;
}

// ---- Codex response parsing ----

interface ParsedValidatorResponse {
  summary: string;
  issues: Array<{ title: string; description: string }>;
}

function parseCodexValidatorResponse(
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

function CodexArtifactSection({
  reviewArtifact,
}: {
  reviewArtifact: {
    engine: "codex";
    threadId: string;
    response: string;
    usage: {
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
    } | null;
  };
}) {
  const parsed = useMemo(
    () => parseCodexValidatorResponse(reviewArtifact.response),
    [reviewArtifact.response],
  );

  return (
    <div className="mt-2 pl-[14px]">
      <div className={wbValidationSectionLabel}>Codex Review</div>
      <div className="mb-1 text-[0.68rem] text-text-tertiary">
        Thread:{" "}
        <code className="font-mono text-[0.65rem] text-text-secondary">
          {reviewArtifact.threadId}
        </code>
      </div>
      {reviewArtifact.response && (
        <CollapsibleText maxCollapsedHeight={120}>
          {parsed ? (
            <>
              <div className="wb-markdown-inline text-[0.72rem] leading-[1.45] break-words text-text-secondary">
                <MarkdownContent content={parsed.summary} />
              </div>
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
                        <div
                          className={cn(
                            wbValidationIssueDesc,
                            "wb-markdown-inline",
                          )}
                        >
                          <MarkdownContent content={issue.description} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="wb-markdown-inline text-[0.72rem] leading-[1.45] break-words text-text-secondary">
              <MarkdownContent content={reviewArtifact.response} />
            </div>
          )}
        </CollapsibleText>
      )}
      {reviewArtifact.usage && (
        <div className="mt-1 text-[0.65rem] text-text-tertiary">
          {reviewArtifact.usage.inputTokens}↑{" "}
          {reviewArtifact.usage.cachedInputTokens}⊙{" "}
          {reviewArtifact.usage.outputTokens}↓ tokens
        </div>
      )}
    </div>
  );
}

function ValidationCard({
  event,
  isReusedSession,
  onViewConversation,
}: {
  event: Timestamped<GraphWorkflowValidationResultEvent>;
  isReusedSession?: boolean;
  onViewConversation?: (
    conversationId: string,
    lane: GraphWorkflowLaneKind,
    contextId: string,
  ) => void;
}) {
  const hasIssues = event.issues.length > 0;
  const sessionRef = event.sessionRef;
  const reviewArtifact = event.reviewArtifact;

  const laneBadge = getLaneBadgeLabel(sessionRef?.lane);

  return (
    <div className="border-b border-border-dim py-[10px] last:border-b-0">
      <div className="flex items-start gap-[8px] text-[0.72rem]">
        <span
          className={cn(
            "mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full",
            event.pass
              ? "bg-green shadow-[0_0_6px_var(--green-glow)]"
              : "bg-red",
          )}
        />
        <span className="wb-markdown-inline min-w-0 flex-1 leading-[1.4] text-text-secondary">
          <MarkdownContent content={event.summary} />
        </span>
        <span className="shrink-0 text-[0.7rem] whitespace-nowrap text-text-tertiary">
          {formatTimestamp(event.occurredAt)}
        </span>
      </div>
      {sessionRef && (
        <div className="mt-[5px] flex flex-wrap items-center gap-[5px] pl-[14px]">
          {laneBadge && (
            <span className="rounded-[3px] bg-blue-glow px-[5px] py-px text-[0.64rem] font-bold tracking-[0.06em] text-blue uppercase">
              {laneBadge}
            </span>
          )}
          <span className="rounded-[3px] bg-bg-raised px-[5px] py-px text-[0.64rem] text-text-tertiary">
            {sessionRef.engine}
          </span>
          {isReusedSession && (
            <span className="text-[0.64rem] text-text-tertiary opacity-80">
              ↺ continued
            </span>
          )}
          {sessionRef.engine === "claude" && onViewConversation && (
            <button
              className={cn(
                wbBtn,
                wbBtnXs,
                wbBtnDefault,
                "ml-auto text-[0.68rem]",
              )}
              onClick={() =>
                onViewConversation(
                  sessionRef.conversationId,
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
      {reviewArtifact?.engine === "codex" && (
        <CodexArtifactSection reviewArtifact={reviewArtifact} />
      )}
      {hasIssues && (
        <div className={wbValidationBody}>
          <div className={wbValidationSectionLabel}>
            Issues ({event.issues.length})
          </div>
          <CollapsibleText maxCollapsedHeight={140}>
            <ul className={wbValidationIssuesList}>
              {event.issues.map((issue, idx) => (
                <li key={idx} className={wbValidationIssue}>
                  <div className={wbValidationIssueTitle}>{issue.title}</div>
                  <div
                    className={cn(wbValidationIssueDesc, "wb-markdown-inline")}
                  >
                    <MarkdownContent content={issue.description} />
                  </div>
                </li>
              ))}
            </ul>
          </CollapsibleText>
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

// ---- Overview View (no context selected) ----

function OverviewView({
  execution,
  events,
  onSelectContext,
  onViewConversation,
}: {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  onSelectContext?: (contextId: string) => void;
  onViewConversation?: ExecutionInspectorPanelProps["onViewConversation"];
}) {
  const totalContexts = execution.workingDefinition.executionContexts.length;
  const completedContexts = Object.values(execution.contextStates).filter(
    (cs) => cs.status === "completed",
  ).length;
  const totalTasks = execution.workingDefinition.tasks.length;
  const completedTasks = Object.values(execution.taskStates).filter(
    (ts) => ts.status === "completed",
  ).length;
  const edgeCount = execution.workingDefinition.edges.length;
  const mergeCounts = countMerges(execution);

  const history = useMemo(() => getHistoryEntries(events), [events]);

  return (
    <aside className={wbInspector}>
      <header className={wbInspectorHeader}>
        <span className={wbInspectorTitle}>Overview</span>
      </header>
      <div className={cn(wbInspectorBody, "wb-inspector-body")}>
        {execution.haltReason && (
          <ContextHaltCard
            primary={execution.haltReason}
            secondary={execution.secondaryHaltReasons}
            variant="card"
          />
        )}

        <div className={wbOverviewStatGrid}>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>
              {completedContexts}/{totalContexts}
            </div>
            <div className={wbOverviewStatLabel}>Contexts</div>
          </div>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>
              {completedTasks}/{totalTasks}
            </div>
            <div className={wbOverviewStatLabel}>Tasks</div>
          </div>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>{edgeCount}</div>
            <div className={wbOverviewStatLabel}>Edges</div>
          </div>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>
              {mergeCounts.merged}/{mergeCounts.total}
            </div>
            <div className={wbOverviewStatLabel}>Merges</div>
          </div>
        </div>

        <section className={wbOverviewSection}>
          <div className={wbOverviewSectionTitle}>Events</div>
          <WorkflowEventLog
            execution={execution}
            events={events}
            onSelectContext={onSelectContext}
          />
        </section>

        {history.validationEvents.length > 0 && (
          <section className={wbOverviewSection}>
            <div className={wbOverviewSectionTitle}>Recent Validations</div>
            {(() => {
              const reused = computeReusedSessions(history.validationEvents);
              return history.validationEvents
                .slice(0, 5)
                .map((event, index) => (
                  <ValidationCard
                    key={`val-${index}`}
                    event={event}
                    isReusedSession={reused.has(index)}
                    onViewConversation={onViewConversation}
                  />
                ));
            })()}
          </section>
        )}

        {history.circuitBreakerEvents.length > 0 && (
          <section className={wbOverviewSection}>
            <div className={wbOverviewSectionTitle}>Circuit Breakers</div>
            {history.circuitBreakerEvents.slice(0, 5).map((event, index) => {
              const ctxTitle =
                execution.workingDefinition.executionContexts.find(
                  (ctx) => ctx.id === event.contextId,
                )?.title ?? event.contextId;
              return (
                <div key={`cb-${index}`} className={wbExecEvent}>
                  <div className={wbExecEventHeader}>
                    <span className={wbExecEventDotBreaker} />
                    <span className={wbExecEventText}>
                      {ctxTitle}: {event.failureCount} failures (
                      {event.condition})
                    </span>
                    <span className={wbExecEventTimestamp}>
                      {formatTimestamp(event.occurredAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {execution.sharedDocuments.length > 0 && (
          <section className={wbOverviewSection}>
            <div className={wbOverviewSectionTitle}>Shared Documents</div>
            {execution.sharedDocuments.map((doc) => (
              <div key={doc.id} className={wbExecEvent}>
                <div className={wbExecEventHeader}>
                  <span className={wbExecEventText}>{doc.description}</span>
                </div>
                <div className={wbExecEventDetail}>{doc.relativePath}</div>
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  );
}

// ---- Detail View (context selected) ----

function DetailView({
  execution,
  events,
  contextId,
  onSelectContext,
  onDeselectContext,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
  onResetContext,
  onViewTask,
  viewingTaskId,
  isMutating,
  onViewConversation,
}: {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  contextId: string;
  onSelectContext?: (contextId: string) => void;
  onDeselectContext: () => void;
  onAddTask: (contextId: string, title: string, instructions: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: { title?: string; instructions?: string },
  ) => void;
  onRemoveTask: (taskId: string) => void;
  onReorderTask: (contextId: string, orderedTaskIds: string[]) => void;
  onResetContext?: (contextId: string) => void;
  onViewTask: (taskId: string) => void;
  viewingTaskId: string | null;
  isMutating: boolean;
  onViewConversation?: ExecutionInspectorPanelProps["onViewConversation"];
}) {
  const [activeTab, setActiveTab] = useState<DetailTab>("tasks");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addInstructions, setAddInstructions] = useState("");
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  const context = execution.workingDefinition.executionContexts.find(
    (ctx) => ctx.id === contextId,
  );
  const contextState = execution.contextStates[contextId];
  const tasks = useMemo(
    () => getContextTasks(execution, contextId),
    [execution, contextId],
  );
  const history = useMemo(
    () => getHistoryEntries(events, contextId),
    [events, contextId],
  );
  const contextHaltReason = useMemo(
    () => findContextHaltReason(execution, contextId),
    [execution, contextId],
  );

  if (!context) return null;

  const status = contextState?.status;
  const completedCount = contextState?.completedTaskCount ?? 0;
  const totalCount = contextState?.totalTaskCount ?? tasks.length;
  const iterationCount = contextState?.iterationCount ?? 0;

  const canAddTasks =
    contextState?.status !== "completed" &&
    context.mutability?.allowAgentTaskAdd;

  const canResetContext =
    onResetContext != null &&
    (execution.status === "paused" || execution.status === "halted") &&
    contextState?.status !== "completed";

  function handleExpandTask(taskId: string) {
    if (expandedTaskId === taskId) {
      setExpandedTaskId(null);
    } else {
      setExpandedTaskId(taskId);
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        setEditTitle(task.title);
        setEditInstructions(task.instructions);
      }
    }
  }

  function handleSwapTask(index: number, direction: "up" | "down") {
    const editableTasks = tasks.filter((task) =>
      isTaskEditable(execution, task.id),
    );
    const currentTask = tasks[index];
    if (!currentTask) {
      return;
    }

    const editableIndex = editableTasks.findIndex(
      (task) => task.id === currentTask.id,
    );
    const targetIndex =
      direction === "up" ? editableIndex - 1 : editableIndex + 1;
    const reordered = [...editableTasks];
    const curr = reordered[editableIndex];
    const target = reordered[targetIndex];
    if (curr && target) {
      reordered[editableIndex] = target;
      reordered[targetIndex] = curr;
      onReorderTask(
        contextId,
        reordered.map((t) => t.id),
      );
    }
  }

  return (
    <aside className={wbInspector}>
      <header className={wbInspectorHeader}>
        <button
          className="-mx-2 -my-1 flex cursor-pointer appearance-none items-center gap-[6px] rounded-sm border-0 bg-transparent px-2 py-1 text-[0.72rem] font-medium text-text-secondary transition-all duration-150 hover:bg-bg-elevated hover:text-text-primary"
          onClick={onDeselectContext}
          type="button"
        >
          ◂ Back
        </button>
        <span
          className={cn(
            graphNodeBadgeBase,
            graphNodeBadgeByStatus[getStatusBadgeClass(status)],
          )}
        >
          {getStatusLabel(status)}
        </span>
        {canResetContext && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnDanger)}
            onClick={() => setResetConfirmOpen(true)}
            disabled={isMutating}
            type="button"
          >
            Reset Context
          </button>
        )}
      </header>

      <div className="flex shrink-0 border-b border-border-dim bg-bg-surface">
        <button
          className={cn(
            "-mb-px flex-1 cursor-pointer appearance-none border-0 border-b-2 bg-transparent px-3 py-[10px] text-center text-[0.72rem] font-semibold tracking-[0.06em] uppercase transition-all duration-150",
            activeTab === "tasks"
              ? "border-b-cyan text-cyan"
              : "border-b-transparent text-text-tertiary hover:text-text-secondary",
          )}
          onClick={() => setActiveTab("tasks")}
          type="button"
        >
          Tasks
        </button>
        <button
          className={cn(
            "-mb-px flex-1 cursor-pointer appearance-none border-0 border-b-2 bg-transparent px-3 py-[10px] text-center text-[0.72rem] font-semibold tracking-[0.06em] uppercase transition-all duration-150",
            activeTab === "history"
              ? "border-b-cyan text-cyan"
              : "border-b-transparent text-text-tertiary hover:text-text-secondary",
          )}
          onClick={() => setActiveTab("history")}
          type="button"
        >
          History
        </button>
      </div>

      <div className={cn(wbInspectorBody, "wb-inspector-body")}>
        {contextHaltReason && (
          <ContextHaltCard primary={contextHaltReason} variant="card" />
        )}
        {context.description && (
          <div className="mb-md border-b border-border-dim pb-sm text-[0.75rem] leading-[1.5] text-text-secondary">
            <CollapsibleText maxCollapsedHeight={100}>
              <div className="wb-markdown-inline">
                <MarkdownContent content={context.description} />
              </div>
            </CollapsibleText>
          </div>
        )}

        <div className={wbOverviewStatGrid}>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>
              {completedCount}/{totalCount}
            </div>
            <div className={wbOverviewStatLabel}>Tasks</div>
          </div>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>{iterationCount}</div>
            <div className={wbOverviewStatLabel}>Iterations</div>
          </div>
        </div>

        {activeTab === "tasks" && (
          <>
            <section className={wbOverviewSection}>
              <div className={wbOverviewSectionTitle}>
                Tasks ({completedCount}/{totalCount})
              </div>
              <div>
                {tasks.map((task, index) => {
                  const taskState = execution.taskStates[task.id];
                  const isExpanded = expandedTaskId === task.id;
                  const isEditable = isTaskEditable(execution, task.id);
                  const hasConversation = !!taskState?.lastConversationId;
                  const isRunning = isTaskConversationLive(execution, task.id);
                  const isViewing = viewingTaskId === task.id;
                  const hasErrors = !!taskState?.failureMessage;

                  return (
                    <div
                      key={task.id}
                      className={cn(
                        "mb-[2px] rounded-sm border",
                        isExpanded
                          ? "border-border-dim bg-bg-base"
                          : "border-transparent",
                      )}
                    >
                      <div
                        className={cn(
                          "flex cursor-pointer items-center gap-[8px] rounded-sm px-[10px] py-2 transition-[background] duration-150 hover:bg-bg-elevated",
                          hasErrors && "border-l-2 border-l-red",
                          isViewing && "border-l-2 border-l-cyan bg-bg-raised",
                        )}
                        data-testid="wf-task-item"
                        onClick={() => handleExpandTask(task.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleExpandTask(task.id);
                          }
                        }}
                      >
                        <span className="w-4 shrink-0 text-center text-[0.7rem] font-semibold text-text-tertiary">
                          {index + 1}
                        </span>
                        <span className="flex-1 overflow-hidden text-[0.75rem] text-ellipsis whitespace-nowrap text-text-primary">
                          {task.title}
                        </span>
                        {hasConversation && (
                          <button
                            className={cn(
                              "shrink-0 cursor-pointer rounded-[3px] border bg-transparent px-[6px] py-[2px] font-mono text-[0.65rem] font-semibold tracking-[0.04em] whitespace-nowrap uppercase transition-all duration-150",
                              isRunning
                                ? "border-[var(--cyan-glow-strong)] text-cyan hover:bg-[var(--cc-cyan-a08)]"
                                : "border-border-default text-text-tertiary hover:border-border-strong hover:bg-bg-elevated hover:text-text-secondary",
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              onViewTask(task.id);
                            }}
                            type="button"
                          >
                            {isRunning ? "Watch" : "View"}
                          </button>
                        )}
                        {taskState?.failureMessage && (
                          <span className="mr-1 ml-auto h-[6px] w-[6px] shrink-0 rounded-full bg-red" />
                        )}
                        <span
                          className={cn(
                            "h-[6px] w-[6px] shrink-0 rounded-full",
                            taskStatusDotByStatus[
                              getTaskStatusDotClass(taskState?.status)
                            ],
                          )}
                        />
                        <span
                          className={cn(
                            "shrink-0 text-[0.7rem] text-text-tertiary transition-transform duration-150",
                            isExpanded && "rotate-90",
                          )}
                        >
                          ▸
                        </span>
                      </div>
                      <div
                        className={cn(
                          isExpanded
                            ? "block pt-2 pr-[10px] pb-[10px] pl-[34px] text-[0.72rem] leading-[1.5] text-text-secondary"
                            : "hidden",
                        )}
                      >
                        <div className="mb-[10px]">
                          <span className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                            Instructions
                          </span>
                          <CollapsibleText maxCollapsedHeight={100}>
                            <div className="wb-markdown-inline">
                              <MarkdownContent content={task.instructions} />
                            </div>
                          </CollapsibleText>
                        </div>
                        {taskState?.failureMessage && (
                          <div className="mb-[10px]">
                            <span className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                              Failure
                            </span>
                            <span style={{ color: "var(--red)" }}>
                              {taskState.failureMessage}
                            </span>
                          </div>
                        )}
                        {isEditable && isExpanded && (
                          <>
                            <div className="mb-[10px]">
                              <span className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                                Edit Title
                              </span>
                              <input
                                className={wbTaskDetailInput}
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                              />
                            </div>
                            <div className="mb-[10px]">
                              <span className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                                Edit Instructions
                              </span>
                              <textarea
                                className={cn(
                                  wbTaskDetailInput,
                                  wbTaskDetailTextarea,
                                )}
                                rows={3}
                                value={editInstructions}
                                onChange={(e) =>
                                  setEditInstructions(e.target.value)
                                }
                              />
                            </div>
                            <div className="mt-2 flex gap-[6px] border-t border-border-dim pt-2">
                              <button
                                className={cn(wbBtn, wbBtnXs, wbBtnPrimary)}
                                onClick={() => {
                                  onUpdateTask(task.id, {
                                    title: editTitle,
                                    instructions: editInstructions,
                                  });
                                  setExpandedTaskId(null);
                                }}
                                disabled={isMutating}
                                type="button"
                              >
                                Save
                              </button>
                              {index > 0 && (
                                <button
                                  className={cn(wbBtn, wbBtnXs, wbBtnDefault)}
                                  onClick={() => handleSwapTask(index, "up")}
                                  disabled={isMutating}
                                  type="button"
                                >
                                  ▴ Up
                                </button>
                              )}
                              {index < tasks.length - 1 && (
                                <button
                                  className={cn(wbBtn, wbBtnXs, wbBtnDefault)}
                                  onClick={() => handleSwapTask(index, "down")}
                                  disabled={isMutating}
                                  type="button"
                                >
                                  ▾ Down
                                </button>
                              )}
                              <button
                                className={cn(wbBtn, wbBtnXs, wbBtnDanger)}
                                onClick={() => onRemoveTask(task.id)}
                                disabled={isMutating}
                                type="button"
                              >
                                Remove
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {canAddTasks && (
              <section className={wbOverviewSection}>
                <div className={wbOverviewSectionTitle}>Add Task</div>
                <label className="mb-md">
                  <span className="mb-xs block text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                    Title
                  </span>
                  <input
                    className={wbFieldInput}
                    value={addTitle}
                    onChange={(e) => setAddTitle(e.target.value)}
                    placeholder="Task title"
                  />
                </label>
                <label className="mb-md">
                  <span className="mb-xs block text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
                    Instructions
                  </span>
                  <textarea
                    className={cn(wbFieldInput, wbFieldTextarea)}
                    rows={3}
                    value={addInstructions}
                    onChange={(e) => setAddInstructions(e.target.value)}
                    placeholder="Task instructions"
                  />
                </label>
                <button
                  className={cn(wbBtn, wbBtnSm, wbBtnPrimary)}
                  onClick={() => {
                    onAddTask(contextId, addTitle, addInstructions);
                    setAddTitle("");
                    setAddInstructions("");
                  }}
                  disabled={
                    isMutating ||
                    addTitle.trim().length === 0 ||
                    addInstructions.trim().length === 0
                  }
                  type="button"
                >
                  + Add Task
                </button>
              </section>
            )}
          </>
        )}

        {activeTab === "history" && (
          <>
            <section className={wbOverviewSection}>
              <div className={wbOverviewSectionTitle}>Events</div>
              <WorkflowEventLog
                execution={execution}
                events={events}
                contextId={contextId}
                onSelectContext={onSelectContext}
              />
            </section>
            <section className={wbOverviewSection}>
              <div className={wbOverviewSectionTitle}>Validations</div>
              {history.validationEvents.length > 0 ? (
                (() => {
                  const reused = computeReusedSessions(
                    history.validationEvents,
                  );
                  return history.validationEvents.map((event, index) => (
                    <ValidationCard
                      key={`val-${index}`}
                      event={event}
                      isReusedSession={reused.has(index)}
                      onViewConversation={onViewConversation}
                    />
                  ));
                })()
              ) : (
                <div className={wbExecEvent}>
                  <div className={wbExecEventHeader}>
                    <span className={wbExecEventText}>No validations yet</span>
                  </div>
                </div>
              )}
            </section>

            {history.circuitBreakerEvents.length > 0 && (
              <section className={wbOverviewSection}>
                <div className={wbOverviewSectionTitle}>Circuit Breakers</div>
                {history.circuitBreakerEvents.map((event, index) => (
                  <div key={`cb-${index}`} className={wbExecEvent}>
                    <div className={wbExecEventHeader}>
                      <span className={wbExecEventDotBreaker} />
                      <span className={wbExecEventText}>
                        {event.failureCount} failures ({event.condition})
                      </span>
                      <span className={wbExecEventTimestamp}>
                        {formatTimestamp(event.occurredAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={resetConfirmOpen}
        title="Reset context?"
        message="Clear implementer and validator conversations, unmark completed tasks, and reset runtime state for this context. The workflow will remain paused until you resume it."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          setResetConfirmOpen(false);
          onResetContext?.(contextId);
        }}
        onCancel={() => setResetConfirmOpen(false)}
      />
    </aside>
  );
}

// ---- Main Component ----

export default function ExecutionInspectorPanel({
  execution,
  events,
  selectedContextId,
  onSelectContext,
  onDeselectContext,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
  onResetContext,
  onViewTask,
  viewingTaskId,
  isMutating,
  onViewConversation,
}: ExecutionInspectorPanelProps) {
  const selectedContext = selectedContextId
    ? execution.workingDefinition.executionContexts.find(
        (ctx) => ctx.id === selectedContextId,
      )
    : null;

  if (!selectedContext || !selectedContextId) {
    return (
      <OverviewView
        execution={execution}
        events={events}
        onSelectContext={onSelectContext}
        onViewConversation={onViewConversation}
      />
    );
  }

  return (
    <DetailView
      execution={execution}
      events={events}
      contextId={selectedContextId}
      onSelectContext={onSelectContext}
      onDeselectContext={onDeselectContext}
      onAddTask={onAddTask}
      onUpdateTask={onUpdateTask}
      onRemoveTask={onRemoveTask}
      onReorderTask={onReorderTask}
      onResetContext={onResetContext}
      onViewTask={onViewTask}
      viewingTaskId={viewingTaskId}
      isMutating={isMutating}
      onViewConversation={onViewConversation}
    />
  );
}
