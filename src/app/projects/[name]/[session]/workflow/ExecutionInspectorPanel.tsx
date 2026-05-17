"use client";

import { useMemo, useState } from "react";
import MarkdownContent from "@/components/MarkdownContent";
import CollapsibleText from "@/components/CollapsibleText";
import ConfirmDialog from "@/components/ConfirmDialog";
import ContextHaltCard from "@/components/workflow-graph/ContextHaltCard";
import WorkflowEventLog from "@/components/workflow-graph/WorkflowEventLog";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowLaneKind,
  GraphWorkflowHaltReason,
} from "@/types";
import { isTaskConversationLive, isTaskEditable } from "./task-runtime-state";

interface ExecutionInspectorPanelProps {
  execution: GraphWorkflowExecution;
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
  execution: GraphWorkflowExecution,
  contextId?: string,
) {
  const validationEvents = execution.history
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
  const circuitBreakerEvents = execution.history
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
    <div className="wb-validation-codex-artifact">
      <div className="wb-validation-section-label">Codex Review</div>
      <div className="wb-validation-codex-thread">
        Thread: <code>{reviewArtifact.threadId}</code>
      </div>
      {reviewArtifact.response && (
        <CollapsibleText maxCollapsedHeight={120}>
          {parsed ? (
            <>
              <div className="wb-validation-codex-response wb-markdown-inline">
                <MarkdownContent content={parsed.summary} />
              </div>
              {parsed.issues.length > 0 && (
                <div className="wb-validation-body">
                  <div className="wb-validation-section-label">
                    Issues ({parsed.issues.length})
                  </div>
                  <ul className="wb-validation-issues-list">
                    {parsed.issues.map((issue, idx) => (
                      <li key={idx} className="wb-validation-issue">
                        <div className="wb-validation-issue-title">
                          {issue.title}
                        </div>
                        <div className="wb-validation-issue-desc wb-markdown-inline">
                          <MarkdownContent content={issue.description} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="wb-validation-codex-response wb-markdown-inline">
              <MarkdownContent content={reviewArtifact.response} />
            </div>
          )}
        </CollapsibleText>
      )}
      {reviewArtifact.usage && (
        <div className="wb-validation-codex-usage">
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
    <div className="wb-validation-card">
      <div className="wb-validation-header">
        <span className={`wb-validation-dot ${event.pass ? "pass" : "fail"}`} />
        <span className="wb-validation-summary wb-markdown-inline">
          <MarkdownContent content={event.summary} />
        </span>
        <span className="wb-validation-timestamp">
          {formatTimestamp(event.occurredAt)}
        </span>
      </div>
      {sessionRef && (
        <div className="wb-validation-meta">
          {laneBadge && (
            <span className="wb-validation-lane-badge task">{laneBadge}</span>
          )}
          <span className="wb-validation-engine-badge">
            {sessionRef.engine}
          </span>
          {isReusedSession && (
            <span className="wb-validation-reuse-badge">↺ continued</span>
          )}
          {sessionRef.engine === "claude" && onViewConversation && (
            <button
              className="wb-btn wb-btn-xs wb-btn-default wb-validation-view-btn"
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
        <div className="wb-validation-body">
          <div className="wb-validation-section-label">
            Issues ({event.issues.length})
          </div>
          <CollapsibleText maxCollapsedHeight={140}>
            <ul className="wb-validation-issues-list">
              {event.issues.map((issue, idx) => (
                <li key={idx} className="wb-validation-issue">
                  <div className="wb-validation-issue-title">{issue.title}</div>
                  <div className="wb-validation-issue-desc wb-markdown-inline">
                    <MarkdownContent content={issue.description} />
                  </div>
                </li>
              ))}
            </ul>
          </CollapsibleText>
        </div>
      )}
      {event.reopenTaskIds.length > 0 && (
        <div className="wb-validation-body">
          <div className="wb-validation-section-label">
            Reopened Tasks ({event.reopenTaskIds.length})
          </div>
          <ul className="wb-validation-issues-list">
            {event.reopenTaskIds.map((taskId) => (
              <li key={taskId} className="wb-validation-issue">
                <div className="wb-validation-issue-title">
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
  onSelectContext,
  onViewConversation,
}: {
  execution: GraphWorkflowExecution;
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

  const history = useMemo(() => getHistoryEntries(execution), [execution]);

  return (
    <aside className="wb-inspector">
      <header className="wb-inspector-header">
        <span className="wb-inspector-title">Overview</span>
      </header>
      <div className="wb-inspector-body">
        {execution.haltReason && (
          <ContextHaltCard
            primary={execution.haltReason}
            secondary={execution.secondaryHaltReasons}
            variant="card"
          />
        )}

        <div className="wb-overview-stat-grid">
          <div className="wb-overview-stat">
            <div className="wb-overview-stat-value">
              {completedContexts}/{totalContexts}
            </div>
            <div className="wb-overview-stat-label">Contexts</div>
          </div>
          <div className="wb-overview-stat">
            <div className="wb-overview-stat-value">
              {completedTasks}/{totalTasks}
            </div>
            <div className="wb-overview-stat-label">Tasks</div>
          </div>
          <div className="wb-overview-stat">
            <div className="wb-overview-stat-value">{edgeCount}</div>
            <div className="wb-overview-stat-label">Edges</div>
          </div>
          <div className="wb-overview-stat">
            <div className="wb-overview-stat-value">
              {mergeCounts.merged}/{mergeCounts.total}
            </div>
            <div className="wb-overview-stat-label">Merges</div>
          </div>
        </div>

        <section className="wb-overview-section">
          <div className="wb-overview-section-title">Events</div>
          <WorkflowEventLog
            execution={execution}
            onSelectContext={onSelectContext}
          />
        </section>

        {history.validationEvents.length > 0 && (
          <section className="wb-overview-section">
            <div className="wb-overview-section-title">Recent Validations</div>
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
          <section className="wb-overview-section">
            <div className="wb-overview-section-title">Circuit Breakers</div>
            {history.circuitBreakerEvents.slice(0, 5).map((event, index) => {
              const ctxTitle =
                execution.workingDefinition.executionContexts.find(
                  (ctx) => ctx.id === event.contextId,
                )?.title ?? event.contextId;
              return (
                <div key={`cb-${index}`} className="wb-exec-event">
                  <div className="wb-exec-event-header">
                    <span className="wb-exec-event-dot breaker" />
                    <span className="wb-exec-event-text">
                      {ctxTitle}: {event.failureCount} failures (
                      {event.condition})
                    </span>
                    <span className="wb-exec-event-timestamp">
                      {formatTimestamp(event.occurredAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {execution.sharedDocuments.length > 0 && (
          <section className="wb-overview-section">
            <div className="wb-overview-section-title">Shared Documents</div>
            {execution.sharedDocuments.map((doc) => (
              <div key={doc.id} className="wb-exec-event">
                <div className="wb-exec-event-header">
                  <span className="wb-exec-event-text">{doc.description}</span>
                </div>
                <div className="wb-exec-event-detail">{doc.relativePath}</div>
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
    () => getHistoryEntries(execution, contextId),
    [execution, contextId],
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
    <aside className="wb-inspector">
      <header className="wb-inspector-header">
        <button
          className="wb-inspector-back"
          onClick={onDeselectContext}
          type="button"
        >
          ◂ Back
        </button>
        <span className={`graph-node-badge ${getStatusBadgeClass(status)}`}>
          {getStatusLabel(status)}
        </span>
        {canResetContext && (
          <button
            className="wb-btn wb-btn-xs wb-btn-danger"
            onClick={() => setResetConfirmOpen(true)}
            disabled={isMutating}
            type="button"
          >
            Reset Context
          </button>
        )}
      </header>

      <div className="wb-inspector-tabs">
        <button
          className={`wb-inspector-tab${activeTab === "tasks" ? " active" : ""}`}
          onClick={() => setActiveTab("tasks")}
          type="button"
        >
          Tasks
        </button>
        <button
          className={`wb-inspector-tab${activeTab === "history" ? " active" : ""}`}
          onClick={() => setActiveTab("history")}
          type="button"
        >
          History
        </button>
      </div>

      <div className="wb-inspector-body">
        {contextHaltReason && (
          <ContextHaltCard primary={contextHaltReason} variant="card" />
        )}
        {context.description && (
          <div className="wb-exec-description">
            <CollapsibleText maxCollapsedHeight={100}>
              <div className="wb-markdown-inline">
                <MarkdownContent content={context.description} />
              </div>
            </CollapsibleText>
          </div>
        )}

        <div className="wb-overview-stat-grid">
          <div className="wb-overview-stat">
            <div className="wb-overview-stat-value">
              {completedCount}/{totalCount}
            </div>
            <div className="wb-overview-stat-label">Tasks</div>
          </div>
          <div className="wb-overview-stat">
            <div className="wb-overview-stat-value">{iterationCount}</div>
            <div className="wb-overview-stat-label">Iterations</div>
          </div>
        </div>

        {activeTab === "tasks" && (
          <>
            <section className="wb-overview-section">
              <div className="wb-overview-section-title">
                Tasks ({completedCount}/{totalCount})
              </div>
              <div className="wb-task-list">
                {tasks.map((task, index) => {
                  const taskState = execution.taskStates[task.id];
                  const isExpanded = expandedTaskId === task.id;
                  const isEditable = isTaskEditable(execution, task.id);
                  const hasConversation = !!taskState?.lastConversationId;
                  const isRunning = isTaskConversationLive(execution, task.id);
                  const isViewing = viewingTaskId === task.id;
                  const itemClassName = [
                    "wb-task-item",
                    isExpanded && "expanded",
                    isViewing && "viewing",
                    taskState?.failureMessage && "has-errors",
                  ]
                    .filter(Boolean)
                    .join(" ");

                  return (
                    <div key={task.id} className={itemClassName}>
                      <div
                        className="wb-task-item-main"
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
                        <span className="wb-task-order">{index + 1}</span>
                        <span className="wb-task-title">{task.title}</span>
                        {hasConversation && (
                          <button
                            className={`wb-task-view-btn${isRunning ? " live" : ""}`}
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
                          <span className="wb-task-error-dot" />
                        )}
                        <span
                          className={`wb-task-status-dot ${getTaskStatusDotClass(taskState?.status)}`}
                        />
                        <span className="wb-task-expand">▸</span>
                      </div>
                      <div className="wb-task-detail">
                        <div className="wb-task-detail-field">
                          <span className="wb-task-detail-label">
                            Instructions
                          </span>
                          <CollapsibleText maxCollapsedHeight={100}>
                            <div className="wb-markdown-inline">
                              <MarkdownContent content={task.instructions} />
                            </div>
                          </CollapsibleText>
                        </div>
                        {taskState?.failureMessage && (
                          <div className="wb-task-detail-field">
                            <span className="wb-task-detail-label">
                              Failure
                            </span>
                            <span style={{ color: "var(--red)" }}>
                              {taskState.failureMessage}
                            </span>
                          </div>
                        )}
                        {isEditable && isExpanded && (
                          <>
                            <div className="wb-task-detail-field">
                              <span className="wb-task-detail-label">
                                Edit Title
                              </span>
                              <input
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                              />
                            </div>
                            <div className="wb-task-detail-field">
                              <span className="wb-task-detail-label">
                                Edit Instructions
                              </span>
                              <textarea
                                rows={3}
                                value={editInstructions}
                                onChange={(e) =>
                                  setEditInstructions(e.target.value)
                                }
                              />
                            </div>
                            <div className="wb-task-detail-actions">
                              <button
                                className="wb-btn wb-btn-xs wb-btn-primary"
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
                                  className="wb-btn wb-btn-xs wb-btn-default"
                                  onClick={() => handleSwapTask(index, "up")}
                                  disabled={isMutating}
                                  type="button"
                                >
                                  ▴ Up
                                </button>
                              )}
                              {index < tasks.length - 1 && (
                                <button
                                  className="wb-btn wb-btn-xs wb-btn-default"
                                  onClick={() => handleSwapTask(index, "down")}
                                  disabled={isMutating}
                                  type="button"
                                >
                                  ▾ Down
                                </button>
                              )}
                              <button
                                className="wb-btn wb-btn-xs wb-btn-danger"
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
              <section className="wb-overview-section">
                <div className="wb-overview-section-title">Add Task</div>
                <label className="wb-field">
                  <span className="wb-field-label">Title</span>
                  <input
                    value={addTitle}
                    onChange={(e) => setAddTitle(e.target.value)}
                    placeholder="Task title"
                  />
                </label>
                <label className="wb-field">
                  <span className="wb-field-label">Instructions</span>
                  <textarea
                    rows={3}
                    value={addInstructions}
                    onChange={(e) => setAddInstructions(e.target.value)}
                    placeholder="Task instructions"
                  />
                </label>
                <button
                  className="wb-btn wb-btn-sm wb-btn-primary"
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
            <section className="wb-overview-section">
              <div className="wb-overview-section-title">Events</div>
              <WorkflowEventLog
                execution={execution}
                contextId={contextId}
                onSelectContext={onSelectContext}
              />
            </section>
            <section className="wb-overview-section">
              <div className="wb-overview-section-title">Validations</div>
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
                <div className="wb-exec-event">
                  <div className="wb-exec-event-header">
                    <span className="wb-exec-event-text">
                      No validations yet
                    </span>
                  </div>
                </div>
              )}
            </section>

            {history.circuitBreakerEvents.length > 0 && (
              <section className="wb-overview-section">
                <div className="wb-overview-section-title">
                  Circuit Breakers
                </div>
                {history.circuitBreakerEvents.map((event, index) => (
                  <div key={`cb-${index}`} className="wb-exec-event">
                    <div className="wb-exec-event-header">
                      <span className="wb-exec-event-dot breaker" />
                      <span className="wb-exec-event-text">
                        {event.failureCount} failures ({event.condition})
                      </span>
                      <span className="wb-exec-event-timestamp">
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
        onSelectContext={onSelectContext}
        onViewConversation={onViewConversation}
      />
    );
  }

  return (
    <DetailView
      execution={execution}
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
