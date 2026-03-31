"use client";

import { useEffect, useMemo, useState } from "react";
import ModelSelector, { type ModelId } from "@/components/ModelSelector";
import ReasoningLevelSelector, {
  type EffortLevel,
} from "@/components/ReasoningLevelSelector";
import { getEffortLevelsForModel, clampEffortToModel } from "@/lib/schemas";
import {
  addTaskToContext,
  moveTaskWithinContext,
  removeTask,
  updateExecutionContext,
  updateTask,
} from "@/lib/workflow-graph/builder-draft";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/types";

interface WorkflowInspectorPanelProps {
  onSave: () => Promise<void>;
  onDelete: (contextId: string) => void;
  saving: boolean;
  defaultModel?: ModelId;
}

type InspectorTab = "config" | "tasks";

const DEFAULT_SECTION_IDS = [
  "title-description",
  "implementation-agent",
  "task-validation",
  "context-validation",
  "circuit-breaker",
  "iteration-policy",
  "mutability",
  "delete-context",
] as const;

function sortTasks(
  tasks: GraphWorkflowTaskDefinition[],
): GraphWorkflowTaskDefinition[] {
  return [...tasks].sort((left, right) => left.order - right.order);
}

function countEnabledValidators(
  context: GraphWorkflowExecutionContextDefinition,
): number {
  return [
    context.taskValidation?.enabled,
    context.contextValidation?.agentValidator?.enabled,
    context.contextValidation?.scriptValidator?.enabled,
  ].filter(Boolean).length;
}

function createDefaultAgentConfig(
  model: ModelId = "sonnet",
): GraphWorkflowExecutionContextDefinition["agent"] {
  return {
    model,
    reasoningEffort: "medium",
  };
}

function createDefaultTaskValidation(
  model?: ModelId,
): NonNullable<GraphWorkflowExecutionContextDefinition["taskValidation"]> {
  return {
    enabled: false,
    autoCreateFixTasks: false,
    agent: createDefaultAgentConfig(model),
    instructions: "",
  };
}

function createDefaultContextAgentValidator(
  model?: ModelId,
): NonNullable<
  NonNullable<
    GraphWorkflowExecutionContextDefinition["contextValidation"]
  >["agentValidator"]
> {
  return {
    enabled: false,
    autoCreateFixTasks: false,
    agent: createDefaultAgentConfig(model),
    instructions: "",
  };
}

function createDefaultContextValidation(): NonNullable<
  GraphWorkflowExecutionContextDefinition["contextValidation"]
> {
  return {
    onFail: {
      mode: "halt",
      retryScope: "same_context",
      maxAttempts: 1,
    },
  };
}

function getPositiveNumber(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function getOptionalPositiveNumber(value: string): number | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }

  return parsed;
}

function findFieldError(
  errors: WorkflowGraphValidationError[],
  code: string,
  contextId?: string,
  taskId?: string,
): WorkflowGraphValidationError | undefined {
  return errors.find(
    (e) =>
      e.code === code &&
      (contextId === undefined || e.contextId === contextId) &&
      (taskId === undefined || e.taskId === taskId),
  );
}

function FieldError({
  error,
}: {
  error?: WorkflowGraphValidationError;
}): React.JSX.Element | null {
  if (!error) return null;
  return <div className="wb-field-error">{error.message}</div>;
}

function RequiredMark(): React.JSX.Element {
  return <span className="wb-required">*</span>;
}

function AgentConfigFields({
  model,
  reasoningEffort,
  onModelChange,
  onReasoningChange,
  disabled = false,
}: {
  model: ModelId;
  reasoningEffort: EffortLevel;
  onModelChange: (model: ModelId) => void;
  onReasoningChange: (effort: EffortLevel) => void;
  disabled?: boolean;
}): React.JSX.Element {
  const availableLevels = getEffortLevelsForModel(model);
  const effortSupported = availableLevels.length > 0;

  return (
    <>
      <div className="wb-inline-field">
        <span className="wb-inline-field-label">Model</span>
        <ModelSelector
          value={model}
          onChange={onModelChange}
          disabled={disabled}
        />
      </div>
      {effortSupported && (
        <div className="wb-inline-field">
          <span className="wb-inline-field-label">Reasoning</span>
          <ReasoningLevelSelector
            value={reasoningEffort}
            onChange={onReasoningChange}
            disabled={disabled}
            availableLevels={availableLevels}
          />
        </div>
      )}
    </>
  );
}

export default function WorkflowInspectorPanel({
  onSave,
  onDelete,
  saving,
  defaultModel = "sonnet",
}: WorkflowInspectorPanelProps): React.JSX.Element {
  const draftDefinition = _useGraphWorkflowBuilderStore(
    (state) => state.draftDefinition,
  );
  const draftLayout = _useGraphWorkflowBuilderStore(
    (state) => state.draftLayout,
  );
  const selectedContextId = _useGraphWorkflowBuilderStore(
    (state) => state.selectedContextId,
  );
  const selectedTaskId = _useGraphWorkflowBuilderStore(
    (state) => state.selectedTaskId,
  );
  const dirty = _useGraphWorkflowBuilderStore((state) => state.dirty);
  const validationErrors = _useGraphWorkflowBuilderStore(
    (state) => state.validationErrors,
  );
  const updateDefinition = _useGraphWorkflowBuilderStore(
    (state) => state.updateDefinition,
  );
  const setSelectedContextId = _useGraphWorkflowBuilderStore(
    (state) => state.setSelectedContextId,
  );
  const setSelectedTaskId = _useGraphWorkflowBuilderStore(
    (state) => state.setSelectedTaskId,
  );

  const [activeTab, setActiveTab] = useState<InspectorTab>("config");
  const [openSections, setOpenSections] = useState<Set<string>>(
    () => new Set(DEFAULT_SECTION_IDS),
  );

  const selectedContext = useMemo(() => {
    return draftDefinition?.executionContexts.find(
      (context) => context.id === selectedContextId,
    );
  }, [draftDefinition, selectedContextId]);

  const selectedContextTasks = useMemo(() => {
    if (!draftDefinition || !selectedContextId) {
      return [];
    }

    return sortTasks(
      draftDefinition.tasks.filter(
        (task) => task.contextId === selectedContextId,
      ),
    );
  }, [draftDefinition, selectedContextId]);

  const contextTitleById = useMemo(() => {
    return new Map(
      draftDefinition?.executionContexts.map((context) => [
        context.id,
        context.title,
      ]) ?? [],
    );
  }, [draftDefinition]);

  const validatorCount = useMemo(() => {
    return (
      draftDefinition?.executionContexts.reduce(
        (count, context) => count + countEnabledValidators(context),
        0,
      ) ?? 0
    );
  }, [draftDefinition]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab("config");
    setOpenSections(new Set(DEFAULT_SECTION_IDS));
  }, [selectedContextId]);

  useEffect(() => {
    if (selectedContextId && !selectedContext) {
      setSelectedContextId(null);
    }
  }, [selectedContext, selectedContextId, setSelectedContextId]);

  useEffect(() => {
    if (
      selectedTaskId &&
      !selectedContextTasks.some((task) => task.id === selectedTaskId)
    ) {
      setSelectedTaskId(null);
    }
  }, [selectedContextTasks, selectedTaskId, setSelectedTaskId]);

  function toggleSection(sectionId: string) {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }

  function isSectionOpen(sectionId: string): boolean {
    return openSections.has(sectionId);
  }

  function applyContextUpdate(
    updates: Partial<WorkflowSemanticDefinition["executionContexts"][number]>,
  ) {
    if (!draftDefinition || !selectedContextId) {
      return;
    }

    updateDefinition(
      updateExecutionContext(draftDefinition, selectedContextId, updates),
    );
  }

  function handleTaskSelection(taskId: string) {
    setSelectedTaskId(selectedTaskId === taskId ? null : taskId);
  }

  function renderSection(
    sectionId: string,
    title: string,
    content: React.JSX.Element,
  ): React.JSX.Element {
    const open = isSectionOpen(sectionId);

    return (
      <section className="wb-section" key={sectionId}>
        <div
          className="wb-section-header"
          onClick={() => toggleSection(sectionId)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggleSection(sectionId);
            }
          }}
        >
          <span className="wb-section-title">{title}</span>
          <span className={`wb-section-toggle${open ? " open" : ""}`}>▸</span>
        </div>
        {open ? <div className="wb-section-content">{content}</div> : null}
      </section>
    );
  }

  if (!draftDefinition || !draftLayout) {
    return (
      <aside className="wb-inspector">
        <header className="wb-inspector-header">
          <span className="wb-inspector-title">Overview</span>
        </header>
        <div className="wb-inspector-body">Loading workflow definition...</div>
      </aside>
    );
  }

  if (!selectedContextId || !selectedContext) {
    return (
      <aside className="wb-inspector">
        <header className="wb-inspector-header">
          <span className="wb-inspector-title">Overview</span>
          <button
            className={`wb-btn wb-btn-sm ${dirty ? "wb-btn-primary" : "wb-btn-default"}`}
            disabled={!dirty || saving}
            onClick={() => void onSave()}
            title={
              validationErrors.length > 0
                ? `${validationErrors.length} validation issue${validationErrors.length === 1 ? "" : "s"} present`
                : undefined
            }
            type="button"
          >
            {saving ? "Saving..." : dirty ? "Save" : "Saved"}
          </button>
        </header>

        <div className="wb-inspector-body">
          <div className="wb-overview-stat-grid">
            <div className="wb-overview-stat">
              <div className="wb-overview-stat-value">
                {draftDefinition.executionContexts.length}
              </div>
              <div className="wb-overview-stat-label">Contexts</div>
            </div>
            <div className="wb-overview-stat">
              <div className="wb-overview-stat-value">
                {draftDefinition.tasks.length}
              </div>
              <div className="wb-overview-stat-label">Tasks</div>
            </div>
            <div className="wb-overview-stat">
              <div className="wb-overview-stat-value">
                {draftDefinition.edges.length}
              </div>
              <div className="wb-overview-stat-label">Edges</div>
            </div>
            <div className="wb-overview-stat">
              <div className="wb-overview-stat-value">{validatorCount}</div>
              <div className="wb-overview-stat-label">Validators</div>
            </div>
          </div>

          <section className="wb-overview-section">
            <div className="wb-overview-section-title">Validation</div>
            {draftDefinition.executionContexts.length > 0 ? (
              draftDefinition.executionContexts.map((context) => {
                const badges = [
                  context.taskValidation?.enabled ? "Task" : null,
                  context.contextValidation?.agentValidator?.enabled
                    ? "Agent"
                    : null,
                  context.contextValidation?.scriptValidator?.enabled
                    ? "Script"
                    : null,
                ].filter((value): value is string => value !== null);

                return (
                  <div className="wb-overview-config-row" key={context.id}>
                    <span>{context.title}</span>
                    <div
                      style={{
                        display: "flex",
                        gap: 6,
                        flexWrap: "wrap",
                        justifyContent: "flex-end",
                      }}
                    >
                      {badges.length > 0 ? (
                        badges.map((badge) => (
                          <span
                            className="wb-overview-config-badge enabled"
                            key={`${context.id}-${badge}`}
                          >
                            {badge}
                          </span>
                        ))
                      ) : (
                        <span className="wb-overview-config-badge disabled">
                          None
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="wb-overview-config-row">
                <span>No execution contexts configured.</span>
              </div>
            )}
          </section>

          <section className="wb-overview-section">
            <div className="wb-overview-section-title">Edges</div>
            {draftDefinition.edges.length > 0 ? (
              draftDefinition.edges.map((edge) => (
                <div className="wb-overview-edge" key={edge.id}>
                  <span>
                    {contextTitleById.get(edge.sourceContextId) ??
                      edge.sourceContextId}
                  </span>
                  <span className="wb-overview-edge-arrow">→</span>
                  <span>
                    {contextTitleById.get(edge.targetContextId) ??
                      edge.targetContextId}
                  </span>
                </div>
              ))
            ) : (
              <div className="wb-overview-config-row">
                <span>No dependencies configured.</span>
              </div>
            )}
          </section>
        </div>
      </aside>
    );
  }

  const taskValidation =
    selectedContext.taskValidation ?? createDefaultTaskValidation(defaultModel);
  const contextValidation =
    selectedContext.contextValidation ?? createDefaultContextValidation();
  const agentValidator =
    contextValidation.agentValidator ??
    createDefaultContextAgentValidator(defaultModel);
  const scriptValidatorEnabled =
    contextValidation.scriptValidator?.enabled ?? false;

  return (
    <aside className="wb-inspector">
      <header className="wb-inspector-header">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
          }}
        >
          <button
            className="wb-inspector-back"
            onClick={() => setSelectedContextId(null)}
            type="button"
          >
            ← Overview
          </button>
          <span
            className="wb-inspector-title"
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {selectedContext.title}
          </span>
        </div>
        <button
          className={`wb-btn wb-btn-sm ${dirty ? "wb-btn-primary" : "wb-btn-default"}`}
          disabled={!dirty || saving}
          onClick={() => void onSave()}
          title={
            validationErrors.length > 0
              ? `${validationErrors.length} validation issue${validationErrors.length === 1 ? "" : "s"} present`
              : undefined
          }
          type="button"
        >
          {saving ? "Saving..." : dirty ? "Save" : "Saved"}
        </button>
      </header>

      <div className="wb-inspector-tabs">
        <button
          className={`wb-inspector-tab${activeTab === "config" ? " active" : ""}`}
          onClick={() => setActiveTab("config")}
          type="button"
        >
          Config
        </button>
        <button
          className={`wb-inspector-tab${activeTab === "tasks" ? " active" : ""}`}
          onClick={() => setActiveTab("tasks")}
          type="button"
        >
          Tasks
        </button>
      </div>

      {(() => {
        const contextErrorCount = validationErrors.filter(
          (e) => e.contextId === selectedContextId,
        ).length;
        if (contextErrorCount === 0) return null;
        return (
          <div className="wb-validation-banner">
            {contextErrorCount} validation{" "}
            {contextErrorCount === 1 ? "issue" : "issues"}
          </div>
        );
      })()}

      <div className="wb-inspector-body">
        {activeTab === "config" ? (
          <>
            {renderSection(
              "title-description",
              "Title & Description",
              (() => {
                const titleError = findFieldError(
                  validationErrors,
                  "empty-context-title",
                  selectedContext.id,
                );
                return (
                  <>
                    <div className="wb-field">
                      <label
                        className="wb-field-label"
                        htmlFor="workflow-context-title"
                      >
                        Title <RequiredMark />
                      </label>
                      <input
                        className={titleError ? "invalid" : undefined}
                        id="workflow-context-title"
                        onChange={(event) =>
                          applyContextUpdate({
                            title: event.target.value,
                          })
                        }
                        type="text"
                        value={selectedContext.title}
                      />
                      <FieldError error={titleError} />
                    </div>
                    <div className="wb-field">
                      <label
                        className="wb-field-label"
                        htmlFor="workflow-context-description"
                      >
                        Description
                      </label>
                      <textarea
                        id="workflow-context-description"
                        onChange={(event) =>
                          applyContextUpdate({
                            description: event.target.value,
                          })
                        }
                        value={selectedContext.description ?? ""}
                      />
                    </div>
                  </>
                );
              })(),
            )}

            {renderSection(
              "implementation-agent",
              "Implementation Agent",
              <AgentConfigFields
                model={selectedContext.agent.model as ModelId}
                reasoningEffort={
                  selectedContext.agent.reasoningEffort as EffortLevel
                }
                onModelChange={(model) => {
                  const clamped = clampEffortToModel(
                    selectedContext.agent.reasoningEffort as EffortLevel,
                    model,
                  );
                  applyContextUpdate({
                    agent: { model, reasoningEffort: clamped ?? "medium" },
                  });
                }}
                onReasoningChange={(effort) =>
                  applyContextUpdate({
                    agent: {
                      ...selectedContext.agent,
                      reasoningEffort: effort,
                    },
                  })
                }
              />,
            )}

            {renderSection(
              "task-validation",
              "Task Validation",
              <>
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">Enabled</span>
                  <div
                    className={`wb-toggle${taskValidation.enabled ? " on" : ""}`}
                    onClick={() =>
                      applyContextUpdate({
                        taskValidation: selectedContext.taskValidation
                          ? {
                              ...selectedContext.taskValidation,
                              enabled: !selectedContext.taskValidation.enabled,
                            }
                          : {
                              ...createDefaultTaskValidation(defaultModel),
                              enabled: true,
                            },
                      })
                    }
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        applyContextUpdate({
                          taskValidation: selectedContext.taskValidation
                            ? {
                                ...selectedContext.taskValidation,
                                enabled:
                                  !selectedContext.taskValidation.enabled,
                              }
                            : {
                                ...createDefaultTaskValidation(defaultModel),
                                enabled: true,
                              },
                        });
                      }
                    }}
                  />
                </div>
                {(() => {
                  const instrError = findFieldError(
                    validationErrors,
                    "empty-task-validator-instructions",
                    selectedContext.id,
                  );
                  return (
                    <div className="wb-field">
                      <label
                        className="wb-field-label"
                        htmlFor="workflow-task-validation-instructions"
                      >
                        Instructions{" "}
                        {taskValidation.enabled && <RequiredMark />}
                      </label>
                      <textarea
                        className={instrError ? "invalid" : undefined}
                        disabled={!taskValidation.enabled}
                        id="workflow-task-validation-instructions"
                        onChange={(event) =>
                          applyContextUpdate({
                            taskValidation: {
                              ...taskValidation,
                              instructions: event.target.value,
                            },
                          })
                        }
                        value={taskValidation.instructions}
                      />
                      <FieldError error={instrError} />
                    </div>
                  );
                })()}
                <div className="wb-subsection-label">Validator Agent</div>
                <AgentConfigFields
                  model={taskValidation.agent.model as ModelId}
                  reasoningEffort={
                    taskValidation.agent.reasoningEffort as EffortLevel
                  }
                  disabled={!taskValidation.enabled}
                  onModelChange={(model) => {
                    const clamped = clampEffortToModel(
                      taskValidation.agent.reasoningEffort as EffortLevel,
                      model,
                    );
                    applyContextUpdate({
                      taskValidation: {
                        ...taskValidation,
                        agent: { model, reasoningEffort: clamped ?? "medium" },
                      },
                    });
                  }}
                  onReasoningChange={(effort) =>
                    applyContextUpdate({
                      taskValidation: {
                        ...taskValidation,
                        agent: {
                          ...taskValidation.agent,
                          reasoningEffort: effort,
                        },
                      },
                    })
                  }
                />
              </>,
            )}

            {renderSection(
              "context-validation",
              "Context Validation",
              <>
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">Agent Validator</span>
                  <div
                    className={`wb-toggle${agentValidator.enabled ? " on" : ""}`}
                    onClick={() =>
                      applyContextUpdate({
                        contextValidation: {
                          ...contextValidation,
                          agentValidator: selectedContext.contextValidation
                            ?.agentValidator
                            ? {
                                ...selectedContext.contextValidation
                                  .agentValidator,
                                enabled:
                                  !selectedContext.contextValidation
                                    .agentValidator.enabled,
                              }
                            : {
                                ...createDefaultContextAgentValidator(
                                  defaultModel,
                                ),
                                enabled: true,
                              },
                        },
                      })
                    }
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        applyContextUpdate({
                          contextValidation: {
                            ...contextValidation,
                            agentValidator: selectedContext.contextValidation
                              ?.agentValidator
                              ? {
                                  ...selectedContext.contextValidation
                                    .agentValidator,
                                  enabled:
                                    !selectedContext.contextValidation
                                      .agentValidator.enabled,
                                }
                              : {
                                  ...createDefaultContextAgentValidator(
                                    defaultModel,
                                  ),
                                  enabled: true,
                                },
                          },
                        });
                      }
                    }}
                  />
                </div>
                {(() => {
                  const instrError = findFieldError(
                    validationErrors,
                    "empty-context-validator-instructions",
                    selectedContext.id,
                  );
                  return (
                    <div className="wb-field">
                      <label
                        className="wb-field-label"
                        htmlFor="workflow-context-validation-instructions"
                      >
                        Instructions{" "}
                        {agentValidator.enabled && <RequiredMark />}
                      </label>
                      <textarea
                        className={instrError ? "invalid" : undefined}
                        disabled={!agentValidator.enabled}
                        id="workflow-context-validation-instructions"
                        onChange={(event) =>
                          applyContextUpdate({
                            contextValidation: {
                              ...contextValidation,
                              agentValidator: {
                                ...agentValidator,
                                instructions: event.target.value,
                              },
                            },
                          })
                        }
                        value={agentValidator.instructions}
                      />
                      <FieldError error={instrError} />
                    </div>
                  );
                })()}
                <div className="wb-subsection-label">Validator Agent</div>
                <AgentConfigFields
                  model={agentValidator.agent.model as ModelId}
                  reasoningEffort={
                    agentValidator.agent.reasoningEffort as EffortLevel
                  }
                  disabled={!agentValidator.enabled}
                  onModelChange={(model) => {
                    const clamped = clampEffortToModel(
                      agentValidator.agent.reasoningEffort as EffortLevel,
                      model,
                    );
                    applyContextUpdate({
                      contextValidation: {
                        ...contextValidation,
                        agentValidator: {
                          ...agentValidator,
                          agent: {
                            model,
                            reasoningEffort: clamped ?? "medium",
                          },
                        },
                      },
                    });
                  }}
                  onReasoningChange={(effort) =>
                    applyContextUpdate({
                      contextValidation: {
                        ...contextValidation,
                        agentValidator: {
                          ...agentValidator,
                          agent: {
                            ...agentValidator.agent,
                            reasoningEffort: effort,
                          },
                        },
                      },
                    })
                  }
                />
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">
                    Script Validator
                  </span>
                  <div
                    className={`wb-toggle${scriptValidatorEnabled ? " on" : ""}`}
                    onClick={() =>
                      applyContextUpdate({
                        contextValidation: {
                          ...contextValidation,
                          scriptValidator: {
                            enabled: !scriptValidatorEnabled,
                          },
                        },
                      })
                    }
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        applyContextUpdate({
                          contextValidation: {
                            ...contextValidation,
                            scriptValidator: {
                              enabled: !scriptValidatorEnabled,
                            },
                          },
                        });
                      }
                    }}
                  />
                </div>
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">
                    Auto-create Fix Tasks
                  </span>
                  <div
                    className={`wb-toggle${agentValidator.autoCreateFixTasks ? " on" : ""}${!agentValidator.enabled ? " disabled" : ""}`}
                    onClick={() => {
                      if (!agentValidator.enabled) return;
                      applyContextUpdate({
                        contextValidation: {
                          ...contextValidation,
                          agentValidator: {
                            ...agentValidator,
                            autoCreateFixTasks:
                              !agentValidator.autoCreateFixTasks,
                          },
                        },
                      });
                    }}
                    role="button"
                    tabIndex={agentValidator.enabled ? 0 : -1}
                    aria-disabled={!agentValidator.enabled}
                    onKeyDown={(event) => {
                      if (!agentValidator.enabled) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        applyContextUpdate({
                          contextValidation: {
                            ...contextValidation,
                            agentValidator: {
                              ...agentValidator,
                              autoCreateFixTasks:
                                !agentValidator.autoCreateFixTasks,
                            },
                          },
                        });
                      }
                    }}
                  />
                </div>
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">On Failure</span>
                  <select
                    onChange={(event) =>
                      applyContextUpdate({
                        contextValidation: {
                          ...contextValidation,
                          onFail: {
                            ...contextValidation.onFail,
                            mode: event.target.value as "halt" | "retry",
                          },
                        },
                      })
                    }
                    value={contextValidation.onFail.mode}
                  >
                    <option value="halt">halt</option>
                    <option value="retry">retry</option>
                  </select>
                </div>
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">Max Attempts</span>
                  <input
                    disabled={contextValidation.onFail.mode !== "retry"}
                    min={1}
                    onChange={(event) =>
                      applyContextUpdate({
                        contextValidation: {
                          ...contextValidation,
                          onFail: {
                            ...contextValidation.onFail,
                            maxAttempts: getPositiveNumber(
                              event.target.value,
                              contextValidation.onFail.maxAttempts,
                            ),
                          },
                        },
                      })
                    }
                    type="number"
                    value={contextValidation.onFail.maxAttempts}
                  />
                </div>
              </>,
            )}

            {renderSection(
              "circuit-breaker",
              "Circuit Breaker",
              <span className="wb-inline-field-label">
                Circuit breaker is enabled for this context.
              </span>,
            )}

            {renderSection(
              "iteration-policy",
              "Iteration Policy",
              <>
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">Max Iterations</span>
                  <input
                    min={1}
                    onChange={(event) =>
                      applyContextUpdate({
                        iterationPolicy: {
                          ...selectedContext.iterationPolicy,
                          maxIterations: getPositiveNumber(
                            event.target.value,
                            selectedContext.iterationPolicy.maxIterations,
                          ),
                        },
                      })
                    }
                    type="number"
                    value={selectedContext.iterationPolicy.maxIterations}
                  />
                </div>
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">
                    Soft Context Limit
                  </span>
                  <input
                    min={1}
                    onChange={(event) =>
                      applyContextUpdate({
                        iterationPolicy: {
                          ...selectedContext.iterationPolicy,
                          contextSoftLimitTokens: getOptionalPositiveNumber(
                            event.target.value,
                          ),
                        },
                      })
                    }
                    type="number"
                    value={
                      selectedContext.iterationPolicy.contextSoftLimitTokens ??
                      ""
                    }
                  />
                </div>
                <div className="wb-inline-field">
                  <span className="wb-inline-field-label">
                    Hard Context Limit
                  </span>
                  <input
                    min={1}
                    onChange={(event) =>
                      applyContextUpdate({
                        iterationPolicy: {
                          ...selectedContext.iterationPolicy,
                          contextHardLimitTokens: getOptionalPositiveNumber(
                            event.target.value,
                          ),
                        },
                      })
                    }
                    type="number"
                    value={
                      selectedContext.iterationPolicy.contextHardLimitTokens ??
                      ""
                    }
                  />
                </div>
              </>,
            )}

            {renderSection(
              "mutability",
              "Mutability",
              <div className="wb-inline-field">
                <span className="wb-inline-field-label">
                  Allow Agent Task Add
                </span>
                <div
                  className={`wb-toggle${selectedContext.mutability.allowAgentTaskAdd ? " on" : ""}`}
                  onClick={() =>
                    applyContextUpdate({
                      mutability: {
                        ...selectedContext.mutability,
                        allowAgentTaskAdd:
                          !selectedContext.mutability.allowAgentTaskAdd,
                      },
                    })
                  }
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      applyContextUpdate({
                        mutability: {
                          ...selectedContext.mutability,
                          allowAgentTaskAdd:
                            !selectedContext.mutability.allowAgentTaskAdd,
                        },
                      });
                    }
                  }}
                />
              </div>,
            )}

            {renderSection(
              "delete-context",
              "Delete Context",
              <button
                className="wb-btn wb-btn-sm wb-btn-danger"
                onClick={() => onDelete(selectedContext.id)}
                type="button"
              >
                Delete Context
              </button>,
            )}
          </>
        ) : (
          <>
            <div className="wb-task-list">
              {selectedContextTasks.map((task, index) => {
                const expanded = selectedTaskId === task.id;
                const firstTask = index === 0;
                const lastTask = index === selectedContextTasks.length - 1;
                const hasTaskErrors = validationErrors.some(
                  (e) => e.taskId === task.id,
                );

                return (
                  <div
                    className={`wb-task-item${expanded ? " expanded active-task" : ""}${hasTaskErrors ? " has-errors" : ""}`}
                    key={task.id}
                  >
                    <div
                      className="wb-task-item-main"
                      onClick={() => handleTaskSelection(task.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          handleTaskSelection(task.id);
                        }
                      }}
                    >
                      <span className="wb-task-order">{task.order}</span>
                      <span className="wb-task-title">
                        {task.title || "(untitled)"}
                      </span>
                      {hasTaskErrors && <span className="wb-task-error-dot" />}
                      <span className="wb-task-expand">▸</span>
                    </div>

                    <div className="wb-task-detail">
                      {(() => {
                        const titleError = findFieldError(
                          validationErrors,
                          "empty-task-title",
                          undefined,
                          task.id,
                        );
                        const instrError = findFieldError(
                          validationErrors,
                          "empty-task-instructions",
                          undefined,
                          task.id,
                        );
                        return (
                          <>
                            <div className="wb-task-detail-field">
                              <label
                                className="wb-task-detail-label"
                                htmlFor={`task-title-${task.id}`}
                              >
                                Title <RequiredMark />
                              </label>
                              <input
                                className={titleError ? "invalid" : undefined}
                                id={`task-title-${task.id}`}
                                onChange={(event) =>
                                  updateDefinition(
                                    updateTask(draftDefinition, task.id, {
                                      title: event.target.value,
                                    }),
                                  )
                                }
                                type="text"
                                value={task.title}
                              />
                              <FieldError error={titleError} />
                            </div>

                            <div className="wb-task-detail-field">
                              <label
                                className="wb-task-detail-label"
                                htmlFor={`task-instructions-${task.id}`}
                              >
                                Instructions <RequiredMark />
                              </label>
                              <textarea
                                className={instrError ? "invalid" : undefined}
                                id={`task-instructions-${task.id}`}
                                onChange={(event) =>
                                  updateDefinition(
                                    updateTask(draftDefinition, task.id, {
                                      instructions: event.target.value,
                                    }),
                                  )
                                }
                                value={task.instructions}
                              />
                              <FieldError error={instrError} />
                            </div>
                          </>
                        );
                      })()}

                      <div className="wb-task-detail-actions">
                        <button
                          className="wb-btn wb-btn-xs wb-btn-default"
                          disabled={firstTask}
                          onClick={() =>
                            updateDefinition(
                              moveTaskWithinContext(
                                draftDefinition,
                                selectedContext.id,
                                task.id,
                                "up",
                              ),
                            )
                          }
                          type="button"
                        >
                          Move Up
                        </button>
                        <button
                          className="wb-btn wb-btn-xs wb-btn-default"
                          disabled={lastTask}
                          onClick={() =>
                            updateDefinition(
                              moveTaskWithinContext(
                                draftDefinition,
                                selectedContext.id,
                                task.id,
                                "down",
                              ),
                            )
                          }
                          type="button"
                        >
                          Move Down
                        </button>
                        <button
                          className="wb-btn wb-btn-xs wb-btn-danger"
                          onClick={() => {
                            updateDefinition(
                              removeTask(
                                draftDefinition,
                                selectedContext.id,
                                task.id,
                              ),
                            );
                            setSelectedTaskId(null);
                          }}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              className="wb-btn-add-task"
              onClick={() => {
                const result = addTaskToContext(
                  draftDefinition,
                  selectedContext.id,
                );
                updateDefinition(result.definition);
                setSelectedTaskId(result.taskId);
              }}
              type="button"
            >
              + Add Task
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
