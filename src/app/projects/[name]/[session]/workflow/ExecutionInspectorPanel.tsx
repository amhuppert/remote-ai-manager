"use client";

import { useMemo, useState } from "react";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowRetryEvent,
  GraphWorkflowCircuitBreakerEvent,
} from "@/types";

interface ExecutionInspectorPanelProps {
  execution: GraphWorkflowExecution;
  selectedContextId: string | null;
  onDeselectContext: () => void;
  onAddTask: (contextId: string, title: string, instructions: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: { title?: string; instructions?: string },
  ) => void;
  onRemoveTask: (taskId: string) => void;
  onReorderTask: (contextId: string, orderedTaskIds: string[]) => void;
  isMutating: boolean;
}

type DetailTab = "tasks" | "history";

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
      } =>
        entry.event.type === "graph-workflow-validation-result" &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map((entry) => entry.event)
    .reverse();
  const retryEvents = execution.history
    .filter(
      (
        entry,
      ): entry is {
        occurredAt: string;
        event: GraphWorkflowRetryEvent;
      } =>
        entry.event.type === "graph-workflow-retry" &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map((entry) => entry.event)
    .reverse();
  const circuitBreakerEvents = execution.history
    .filter(
      (
        entry,
      ): entry is {
        occurredAt: string;
        event: GraphWorkflowCircuitBreakerEvent;
      } =>
        entry.event.type === "graph-workflow-circuit-breaker" &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map((entry) => entry.event)
    .reverse();

  return { validationEvents, retryEvents, circuitBreakerEvents };
}

function getStatusBadgeClass(status?: string): string {
  switch (status) {
    case "running":
      return "running";
    case "validating":
      return "validating";
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
    case "validating":
      return "Validating";
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

function countEnabledValidators(execution: GraphWorkflowExecution): number {
  return execution.workingDefinition.executionContexts.reduce(
    (count, ctx) =>
      count +
      [
        ctx.taskValidation?.enabled,
        ctx.contextValidation?.agentValidator?.enabled,
        ctx.contextValidation?.scriptValidator?.enabled,
      ].filter(Boolean).length,
    0,
  );
}

// ---- Overview View (no context selected) ----

function OverviewView({ execution }: { execution: GraphWorkflowExecution }) {
  const totalContexts = execution.workingDefinition.executionContexts.length;
  const completedContexts = Object.values(execution.contextStates).filter(
    (cs) => cs.status === "completed",
  ).length;
  const totalTasks = execution.workingDefinition.tasks.length;
  const completedTasks = Object.values(execution.taskStates).filter(
    (ts) => ts.status === "completed",
  ).length;
  const edgeCount = execution.workingDefinition.edges.length;
  const validatorCount = countEnabledValidators(execution);

  const history = useMemo(() => getHistoryEntries(execution), [execution]);

  return (
    <aside className="wb-inspector">
      <header className="wb-inspector-header">
        <span className="wb-inspector-title">Overview</span>
      </header>
      <div className="wb-inspector-body">
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
            <div className="wb-overview-stat-value">{validatorCount}</div>
            <div className="wb-overview-stat-label">Validators</div>
          </div>
        </div>

        {history.validationEvents.length > 0 && (
          <section className="wb-overview-section">
            <div className="wb-overview-section-title">Recent Validations</div>
            {history.validationEvents.slice(0, 5).map((event, index) => (
              <div key={`val-${index}`} className="wb-exec-event">
                <div className="wb-exec-event-header">
                  <span
                    className={`wb-exec-event-dot ${event.pass ? "pass" : "fail"}`}
                  />
                  <span className="wb-exec-event-text">{event.summary}</span>
                </div>
                {event.issues[0] && (
                  <div className="wb-exec-event-detail">
                    {event.issues[0].title}: {event.issues[0].description}
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {history.retryEvents.length > 0 && (
          <section className="wb-overview-section">
            <div className="wb-overview-section-title">Retries</div>
            {history.retryEvents.slice(0, 5).map((event, index) => {
              const ctxTitle =
                execution.workingDefinition.executionContexts.find(
                  (ctx) => ctx.id === event.contextId,
                )?.title ?? event.contextId;
              return (
                <div key={`retry-${index}`} className="wb-exec-event">
                  <div className="wb-exec-event-header">
                    <span className="wb-exec-event-dot retry" />
                    <span className="wb-exec-event-text">
                      {ctxTitle}: attempt {event.attempt}/{event.maxAttempts}
                    </span>
                  </div>
                </div>
              );
            })}
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
  onDeselectContext,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
  isMutating,
}: {
  execution: GraphWorkflowExecution;
  contextId: string;
  onDeselectContext: () => void;
  onAddTask: (contextId: string, title: string, instructions: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: { title?: string; instructions?: string },
  ) => void;
  onRemoveTask: (taskId: string) => void;
  onReorderTask: (contextId: string, orderedTaskIds: string[]) => void;
  isMutating: boolean;
}) {
  const [activeTab, setActiveTab] = useState<DetailTab>("tasks");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addInstructions, setAddInstructions] = useState("");

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

  if (!context) return null;

  const status = contextState?.status;
  const completedCount = contextState?.completedTaskCount ?? 0;
  const totalCount = contextState?.totalTaskCount ?? tasks.length;
  const iterationCount = contextState?.iterationCount ?? 0;

  const canAddTasks =
    contextState?.status !== "completed" &&
    context.mutability?.allowAgentTaskAdd;

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
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    const reordered = [...tasks];
    const curr = reordered[index];
    const target = reordered[targetIndex];
    if (curr && target) {
      reordered[index] = target;
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
        {context.description && (
          <div className="wb-exec-description">{context.description}</div>
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
                  const isEditable = taskState?.status !== "completed";
                  const itemClassName = [
                    "wb-task-item",
                    isExpanded && "expanded",
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
                          {task.instructions}
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
              <div className="wb-overview-section-title">Validations</div>
              {history.validationEvents.length > 0 ? (
                history.validationEvents.map((event, index) => (
                  <div key={`val-${index}`} className="wb-exec-event">
                    <div className="wb-exec-event-header">
                      <span
                        className={`wb-exec-event-dot ${event.pass ? "pass" : "fail"}`}
                      />
                      <span className="wb-exec-event-text">
                        {event.summary}
                      </span>
                    </div>
                    {event.issues.length > 0 && (
                      <div className="wb-exec-event-detail">
                        {event.issues.map((issue, issueIdx) => (
                          <div key={`issue-${issueIdx}`}>
                            {issue.title}: {issue.description}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
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

            {history.retryEvents.length > 0 && (
              <section className="wb-overview-section">
                <div className="wb-overview-section-title">Retries</div>
                {history.retryEvents.map((event, index) => (
                  <div key={`retry-${index}`} className="wb-exec-event">
                    <div className="wb-exec-event-header">
                      <span className="wb-exec-event-dot retry" />
                      <span className="wb-exec-event-text">
                        Attempt {event.attempt}/{event.maxAttempts}
                      </span>
                    </div>
                  </div>
                ))}
              </section>
            )}

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
                    </div>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

// ---- Main Component ----

export default function ExecutionInspectorPanel({
  execution,
  selectedContextId,
  onDeselectContext,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
  isMutating,
}: ExecutionInspectorPanelProps) {
  const selectedContext = selectedContextId
    ? execution.workingDefinition.executionContexts.find(
        (ctx) => ctx.id === selectedContextId,
      )
    : null;

  if (!selectedContext || !selectedContextId) {
    return <OverviewView execution={execution} />;
  }

  return (
    <DetailView
      execution={execution}
      contextId={selectedContextId}
      onDeselectContext={onDeselectContext}
      onAddTask={onAddTask}
      onUpdateTask={onUpdateTask}
      onRemoveTask={onRemoveTask}
      onReorderTask={onReorderTask}
      isMutating={isMutating}
    />
  );
}
