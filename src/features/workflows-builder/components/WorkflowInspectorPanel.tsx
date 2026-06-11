"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addTaskToContext,
  clearContextBlockOverride,
  clearWorkflowConfigOverride,
  disableContextValidator,
  enableContextValidator,
  moveTaskWithinContext,
  removeTask,
  setContextBlockOverride,
  setWorkflowConfigOverride,
  updateExecutionContext,
  updateTask,
} from "@/lib/workflow-graph/builder-draft";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import type { CodexConfig } from "@/lib/agent-backends/schemas";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import type {
  ContextValidatorOverride,
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowHumanApprovalGateConfig,
  GraphWorkflowIterationPolicy,
  GraphWorkflowMutabilityPolicy,
  GraphWorkflowScriptValidatorConfig,
  GraphWorkflowTaskDefinition,
  WorkflowCollaborationConfig,
  WorkflowConfigOverride,
  WorkflowGraphValidationError,
} from "@/lib/workflows/schemas";
import {
  resolveContextCollaboration,
  resolveWorkflowCollaboration,
} from "./collaboration-cascade";
import InspectorConfigBlock, {
  type InspectorConfigBlockSource,
} from "./InspectorConfigBlock";
import {
  CircuitBreakerEditor,
  CollaborationEditor,
  ContextValidatorEditor,
  ImplementerEditor,
  IterationPolicyEditor,
  MutabilityEditor,
} from "./InspectorFieldEditors";

interface WorkflowInspectorPanelProps {
  onSave: () => Promise<void>;
  onDelete: (contextId: string) => void;
  saving: boolean;
  defaultImplementerConfig?: GraphWorkflowAgentConfig;
  codexConfig?: CodexConfig;
  globalDefaults?: WorkflowDefaults;
  activeTab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
}

export type InspectorTab = "workflow" | "context";

const SEEDED_DEFAULTS: WorkflowDefaults = {
  implementer: {
    backend: "claude",
    model: "opus",
    reasoningEffort: "medium",
  },
  contextValidator: {
    type: "claude",
    enabled: true,
    continuity: { enabled: true },
    agent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
  },
  scriptValidator: {
    enabled: false,
  },
  humanApprovalGate: {
    enabled: false,
  },
  iterationPolicy: {
    maxIterations: 20,
    continuity: { enabled: true },
  },
  circuitBreaker: {
    consecutiveFailureThreshold: 3,
  },
  mutability: {
    allowAgentTaskAdd: false,
  },
  collaboration: {
    secondAgent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
    negotiationRounds: 3,
    autonomousResolutionThreshold: "minor",
  },
};

function sortTasks(
  tasks: GraphWorkflowTaskDefinition[],
): GraphWorkflowTaskDefinition[] {
  return [...tasks].sort((left, right) => left.order - right.order);
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

function summarizeImplementer(config: GraphWorkflowAgentConfig): string {
  const parts: string[] = [config.backend, config.model];
  if (config.reasoningEffort) parts.push(config.reasoningEffort);
  return parts.join(" · ");
}

function summarizeValidator(
  validator: GraphWorkflowAgentValidatorConfig,
): string {
  const enabledLabel = validator.enabled ? "enabled" : "off";
  if (validator.type === "claude") {
    return `claude · ${validator.agent.model} · ${enabledLabel}`;
  }
  const model = validator.codex?.model ?? "default";
  return `codex · ${model} · ${enabledLabel}`;
}

function summarizeScriptValidator(
  validator: GraphWorkflowScriptValidatorConfig,
): string {
  return validator.enabled ? "enabled" : "off";
}

function summarizeHumanApprovalGate(
  gate: GraphWorkflowHumanApprovalGateConfig,
): string {
  return gate.enabled ? "enabled" : "off";
}

function summarizeIterationPolicy(
  policy: GraphWorkflowIterationPolicy,
): string {
  const continuity = policy.continuity.enabled
    ? `continuity on${policy.continuity.contextLimitTokens ? ` · limit ${policy.continuity.contextLimitTokens}` : ""}`
    : "continuity off";
  return `max ${policy.maxIterations} · ${continuity}`;
}

function summarizeCircuitBreaker(
  policy: GraphWorkflowCircuitBreakerPolicy,
): string {
  return `threshold ${policy.consecutiveFailureThreshold ?? "default"}`;
}

function summarizeMutability(policy: GraphWorkflowMutabilityPolicy): string {
  return `agent-add ${policy.allowAgentTaskAdd ? "on" : "off"}`;
}

function summarizeCollaboration(config: WorkflowCollaborationConfig): string {
  const agent = `${config.secondAgent.backend} ${config.secondAgent.model}`;
  return `${agent} · ${config.negotiationRounds} rounds · auto ${config.autonomousResolutionThreshold}`;
}

type ResolvedContextCascade = {
  implementer: {
    value: GraphWorkflowAgentConfig;
    source: InspectorConfigBlockSource;
  };
  contextValidator:
    | {
        value: GraphWorkflowAgentValidatorConfig;
        source: Exclude<InspectorConfigBlockSource, "disabled">;
      }
    | { source: "disabled" };
  scriptValidator: {
    value: GraphWorkflowScriptValidatorConfig;
    source: Exclude<InspectorConfigBlockSource, "disabled">;
  };
  humanApprovalGate: {
    value: GraphWorkflowHumanApprovalGateConfig;
    source: Exclude<InspectorConfigBlockSource, "disabled">;
  };
  iterationPolicy: {
    value: GraphWorkflowIterationPolicy;
    source: InspectorConfigBlockSource;
  };
  circuitBreaker: {
    value: GraphWorkflowCircuitBreakerPolicy;
    source: InspectorConfigBlockSource;
  };
  mutability: {
    value: GraphWorkflowMutabilityPolicy;
    source: InspectorConfigBlockSource;
  };
  collaboration: {
    value: WorkflowCollaborationConfig;
    source: InspectorConfigBlockSource;
  };
};

function computeContextCascade(
  context: GraphWorkflowExecutionContextDefinition,
  workflowConfig: WorkflowConfigOverride,
  globalDefaults: WorkflowDefaults,
): ResolvedContextCascade {
  function resolvePlain<
    K extends
      | "implementer"
      | "scriptValidator"
      | "humanApprovalGate"
      | "iterationPolicy"
      | "circuitBreaker"
      | "mutability",
  >(key: K): ResolvedContextCascade[K] {
    const contextOverride = context[key];
    if (contextOverride !== undefined) {
      return {
        value: contextOverride,
        source: "context-override",
      } as ResolvedContextCascade[K];
    }
    const workflowOverride = workflowConfig[key];
    if (workflowOverride !== undefined) {
      return {
        value: workflowOverride,
        source: "workflow",
      } as ResolvedContextCascade[K];
    }
    return {
      value: globalDefaults[key],
      source: "global",
    } as ResolvedContextCascade[K];
  }

  let validator: ResolvedContextCascade["contextValidator"];
  if (context.contextValidator?.kind === "disabled") {
    validator = { source: "disabled" };
  } else if (context.contextValidator?.kind === "use") {
    validator = {
      value: context.contextValidator.value,
      source: "context-override",
    };
  } else if (workflowConfig.contextValidator !== undefined) {
    validator = {
      value: workflowConfig.contextValidator,
      source: "workflow",
    };
  } else {
    validator = {
      value: globalDefaults.contextValidator,
      source: "global",
    };
  }

  return {
    implementer: resolvePlain("implementer"),
    contextValidator: validator,
    scriptValidator: resolvePlain("scriptValidator"),
    humanApprovalGate: resolvePlain("humanApprovalGate"),
    iterationPolicy: resolvePlain("iterationPolicy"),
    circuitBreaker: resolvePlain("circuitBreaker"),
    mutability: resolvePlain("mutability"),
    collaboration: resolveContextCollaboration(
      context.collaboration,
      workflowConfig.collaboration,
      globalDefaults.collaboration,
    ),
  };
}

type WorkflowCascade = {
  implementer: {
    value: GraphWorkflowAgentConfig;
    source: "global" | "context-override";
  };
  contextValidator: {
    value: GraphWorkflowAgentValidatorConfig;
    source: "global" | "context-override";
  };
  scriptValidator: {
    value: GraphWorkflowScriptValidatorConfig;
    source: "global" | "context-override";
  };
  humanApprovalGate: {
    value: GraphWorkflowHumanApprovalGateConfig;
    source: "global" | "context-override";
  };
  iterationPolicy: {
    value: GraphWorkflowIterationPolicy;
    source: "global" | "context-override";
  };
  circuitBreaker: {
    value: GraphWorkflowCircuitBreakerPolicy;
    source: "global" | "context-override";
  };
  mutability: {
    value: GraphWorkflowMutabilityPolicy;
    source: "global" | "context-override";
  };
  collaboration: {
    value: WorkflowCollaborationConfig;
    source: "global" | "context-override";
  };
};

function computeWorkflowCascade(
  workflowConfig: WorkflowConfigOverride,
  globalDefaults: WorkflowDefaults,
): WorkflowCascade {
  function resolve<K extends keyof WorkflowCascade>(
    key: K,
  ): WorkflowCascade[K] {
    const override = workflowConfig[key];
    if (override !== undefined) {
      return {
        value: override,
        source: "context-override",
      } as WorkflowCascade[K];
    }
    return {
      value: globalDefaults[key],
      source: "global",
    } as WorkflowCascade[K];
  }

  return {
    implementer: resolve("implementer"),
    contextValidator: resolve("contextValidator"),
    scriptValidator: resolve("scriptValidator"),
    humanApprovalGate: resolve("humanApprovalGate"),
    iterationPolicy: resolve("iterationPolicy"),
    circuitBreaker: resolve("circuitBreaker"),
    mutability: resolve("mutability"),
    collaboration: resolveWorkflowCollaboration(
      workflowConfig.collaboration,
      globalDefaults.collaboration,
    ),
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export default function WorkflowInspectorPanel({
  onSave,
  onDelete,
  saving,
  globalDefaults,
  activeTab: controlledActiveTab,
  onTabChange,
}: WorkflowInspectorPanelProps): React.JSX.Element {
  const defaults = globalDefaults ?? SEEDED_DEFAULTS;
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
  const setSelectedTaskId = _useGraphWorkflowBuilderStore(
    (state) => state.setSelectedTaskId,
  );

  const [internalActiveTab, setInternalActiveTab] =
    useState<InspectorTab>("workflow");
  const activeTab = controlledActiveTab ?? internalActiveTab;

  function setActiveTab(tab: InspectorTab) {
    if (onTabChange) onTabChange(tab);
    if (controlledActiveTab === undefined) setInternalActiveTab(tab);
  }

  useEffect(() => {
    if (selectedContextId && activeTab !== "context") {
      if (controlledActiveTab === undefined) {
        setInternalActiveTab("context");
      }
      if (onTabChange) onTabChange("context");
    }
    // Only react to selection changes, not tab flips
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedContextId]);

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

  if (!draftDefinition || !draftLayout) {
    return (
      <aside className="wb-inspector wb-inspector-panel">
        <div className="wb-inspector-body">Loading workflow definition...</div>
      </aside>
    );
  }

  const contextTabEnabled = selectedContext != null;
  const contextTabLabel = selectedContext
    ? `Context: ${selectedContext.title}`
    : "Context";

  const workflowConfig = draftDefinition.workflowConfig ?? {};

  return (
    <aside className="wb-inspector wb-inspector-panel">
      <header className="wb-inspector-header">
        <div
          className="cc-tabs wb-inspector-tabs"
          role="tablist"
          aria-label="Inspector scope"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "workflow"}
            className={`cc-tab cc-tab--fixed${activeTab === "workflow" ? " active" : ""}`}
            onClick={() => setActiveTab("workflow")}
          >
            Workflow
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "context"}
            aria-disabled={!contextTabEnabled}
            disabled={!contextTabEnabled}
            title={
              contextTabEnabled ? undefined : "Select a context in the graph"
            }
            className={`cc-tab${activeTab === "context" ? " active" : ""}`}
            onClick={() => {
              if (contextTabEnabled) setActiveTab("context");
            }}
          >
            {contextTabLabel}
          </button>
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

      <div className="wb-inspector-body">
        {activeTab === "workflow" || !selectedContext ? (
          <WorkflowTabBody
            workflowConfig={workflowConfig}
            globalDefaults={defaults}
            onSetOverride={(block, value) => {
              updateDefinition(
                setWorkflowConfigOverride(draftDefinition, block, value),
              );
            }}
            onClearOverride={(block) => {
              updateDefinition(
                clearWorkflowConfigOverride(draftDefinition, block),
              );
            }}
          />
        ) : (
          <ContextTabBody
            context={selectedContext}
            tasks={selectedContextTasks}
            validationErrors={validationErrors}
            workflowConfig={workflowConfig}
            globalDefaults={defaults}
            selectedTaskId={selectedTaskId}
            onUpdateContext={(updates) => {
              updateDefinition(
                updateExecutionContext(
                  draftDefinition,
                  selectedContext.id,
                  updates,
                ),
              );
            }}
            onSetContextOverride={(block, value) => {
              updateDefinition(
                setContextBlockOverride(
                  draftDefinition,
                  selectedContext.id,
                  block,
                  value,
                ),
              );
            }}
            onClearContextOverride={(block) => {
              updateDefinition(
                clearContextBlockOverride(
                  draftDefinition,
                  selectedContext.id,
                  block,
                ),
              );
            }}
            onDisableValidator={() => {
              updateDefinition(
                disableContextValidator(draftDefinition, selectedContext.id),
              );
            }}
            onEnableValidator={() => {
              updateDefinition(
                enableContextValidator(draftDefinition, selectedContext.id),
              );
            }}
            onAddTask={() => {
              const result = addTaskToContext(
                draftDefinition,
                selectedContext.id,
              );
              updateDefinition(result.definition);
              setSelectedTaskId(result.taskId);
            }}
            onUpdateTask={(taskId, updates) => {
              updateDefinition(updateTask(draftDefinition, taskId, updates));
            }}
            onRemoveTask={(taskId) => {
              updateDefinition(
                removeTask(draftDefinition, selectedContext.id, taskId),
              );
              setSelectedTaskId(null);
            }}
            onMoveTask={(taskId, direction) => {
              updateDefinition(
                moveTaskWithinContext(
                  draftDefinition,
                  selectedContext.id,
                  taskId,
                  direction,
                ),
              );
            }}
            onSelectTask={(taskId) => {
              setSelectedTaskId(selectedTaskId === taskId ? null : taskId);
            }}
            onDelete={() => onDelete(selectedContext.id)}
          />
        )}
      </div>
    </aside>
  );
}

function WorkflowTabBody({
  workflowConfig,
  globalDefaults,
  onSetOverride,
  onClearOverride,
}: {
  workflowConfig: WorkflowConfigOverride;
  globalDefaults: WorkflowDefaults;
  onSetOverride: <K extends keyof WorkflowConfigOverride>(
    block: K,
    value: NonNullable<WorkflowConfigOverride[K]>,
  ) => void;
  onClearOverride: (block: keyof WorkflowConfigOverride) => void;
}): React.JSX.Element {
  const cascade = computeWorkflowCascade(workflowConfig, globalDefaults);
  const isWorkflowOverride = (source: "global" | "context-override") =>
    source === "context-override";

  return (
    <div className="wb-inspector-blocks" data-scope="workflow">
      <InspectorConfigBlock
        label="Implementer"
        summary={summarizeImplementer(cascade.implementer.value)}
        source={cascade.implementer.source}
        onOverride={() =>
          onSetOverride("implementer", deepClone(cascade.implementer.value))
        }
        onReset={() => onClearOverride("implementer")}
      >
        <ImplementerEditor
          value={cascade.implementer.value}
          onChange={(next) => onSetOverride("implementer", next)}
          readOnly={!isWorkflowOverride(cascade.implementer.source)}
        />
      </InspectorConfigBlock>

      <InspectorConfigBlock
        label="Collaboration"
        summary={summarizeCollaboration(cascade.collaboration.value)}
        source={cascade.collaboration.source}
        onOverride={() =>
          onSetOverride("collaboration", deepClone(cascade.collaboration.value))
        }
        onReset={() => onClearOverride("collaboration")}
      >
        <CollaborationEditor
          value={cascade.collaboration.value}
          onChange={(next) => onSetOverride("collaboration", next)}
          readOnly={!isWorkflowOverride(cascade.collaboration.source)}
        />
      </InspectorConfigBlock>

      <InspectorConfigBlock
        label="Context validator"
        summary={summarizeValidator(cascade.contextValidator.value)}
        source={cascade.contextValidator.source}
        onOverride={() =>
          onSetOverride(
            "contextValidator",
            deepClone(cascade.contextValidator.value),
          )
        }
        onReset={() => onClearOverride("contextValidator")}
      >
        <ContextValidatorEditor
          value={cascade.contextValidator.value}
          onChange={(next) => onSetOverride("contextValidator", next)}
          readOnly={!isWorkflowOverride(cascade.contextValidator.source)}
        />
      </InspectorConfigBlock>

      <ScriptValidatorBlock
        scopeLabel="Workflow script validator"
        cascade={cascade.scriptValidator}
        onChange={(value) => onSetOverride("scriptValidator", deepClone(value))}
        onReset={() => onClearOverride("scriptValidator")}
      />

      <HumanApprovalGateBlock
        scopeLabel="Workflow human approval gate"
        hint="Applies to every context without its own override."
        cascade={cascade.humanApprovalGate}
        onChange={(value) =>
          onSetOverride("humanApprovalGate", deepClone(value))
        }
        onReset={() => onClearOverride("humanApprovalGate")}
      />

      <InspectorConfigBlock
        label="Iteration policy"
        summary={summarizeIterationPolicy(cascade.iterationPolicy.value)}
        source={cascade.iterationPolicy.source}
        onOverride={() =>
          onSetOverride(
            "iterationPolicy",
            deepClone(cascade.iterationPolicy.value),
          )
        }
        onReset={() => onClearOverride("iterationPolicy")}
      >
        <IterationPolicyEditor
          value={cascade.iterationPolicy.value}
          onChange={(next) => onSetOverride("iterationPolicy", next)}
          readOnly={!isWorkflowOverride(cascade.iterationPolicy.source)}
        />
      </InspectorConfigBlock>

      <InspectorConfigBlock
        label="Circuit breaker"
        summary={summarizeCircuitBreaker(cascade.circuitBreaker.value)}
        source={cascade.circuitBreaker.source}
        onOverride={() =>
          onSetOverride(
            "circuitBreaker",
            deepClone(cascade.circuitBreaker.value),
          )
        }
        onReset={() => onClearOverride("circuitBreaker")}
      >
        <CircuitBreakerEditor
          value={cascade.circuitBreaker.value}
          onChange={(next) => onSetOverride("circuitBreaker", next)}
          readOnly={!isWorkflowOverride(cascade.circuitBreaker.source)}
        />
      </InspectorConfigBlock>

      <InspectorConfigBlock
        label="Mutability"
        summary={summarizeMutability(cascade.mutability.value)}
        source={cascade.mutability.source}
        onOverride={() =>
          onSetOverride("mutability", deepClone(cascade.mutability.value))
        }
        onReset={() => onClearOverride("mutability")}
      >
        <MutabilityEditor
          value={cascade.mutability.value}
          onChange={(next) => onSetOverride("mutability", next)}
          readOnly={!isWorkflowOverride(cascade.mutability.source)}
        />
      </InspectorConfigBlock>
    </div>
  );
}

type ContextBlock =
  | "implementer"
  | "contextValidator"
  | "scriptValidator"
  | "humanApprovalGate"
  | "iterationPolicy"
  | "circuitBreaker"
  | "mutability"
  | "collaboration";

function ContextTabBody({
  context,
  tasks,
  validationErrors,
  workflowConfig,
  globalDefaults,
  selectedTaskId,
  onUpdateContext,
  onSetContextOverride,
  onClearContextOverride,
  onDisableValidator,
  onEnableValidator,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onMoveTask,
  onSelectTask,
  onDelete,
}: {
  context: GraphWorkflowExecutionContextDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  validationErrors: WorkflowGraphValidationError[];
  workflowConfig: WorkflowConfigOverride;
  globalDefaults: WorkflowDefaults;
  selectedTaskId: string | null;
  onUpdateContext: (
    updates: Partial<GraphWorkflowExecutionContextDefinition>,
  ) => void;
  onSetContextOverride: <K extends ContextBlock>(
    block: K,
    value: NonNullable<GraphWorkflowExecutionContextDefinition[K]>,
  ) => void;
  onClearContextOverride: (block: ContextBlock) => void;
  onDisableValidator: () => void;
  onEnableValidator: () => void;
  onAddTask: () => void;
  onUpdateTask: (
    taskId: string,
    updates: Partial<GraphWorkflowTaskDefinition>,
  ) => void;
  onRemoveTask: (taskId: string) => void;
  onMoveTask: (taskId: string, direction: "up" | "down") => void;
  onSelectTask: (taskId: string) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const cascade = computeContextCascade(
    context,
    workflowConfig,
    globalDefaults,
  );
  const acError = findFieldError(
    validationErrors,
    "empty-context-acceptance-criteria",
    context.id,
  );

  return (
    <div className="wb-inspector-blocks" data-scope="context">
      <section className="wb-inspector-header-group" data-section="header">
        <div className="wb-field">
          <label className="wb-field-label" htmlFor="context-title">
            Title <RequiredMark />
          </label>
          <input
            id="context-title"
            type="text"
            value={context.title}
            onChange={(event) => onUpdateContext({ title: event.target.value })}
          />
        </div>
        <div className="wb-field">
          <label className="wb-field-label" htmlFor="context-description">
            Description
          </label>
          <textarea
            id="context-description"
            rows={2}
            value={context.description ?? ""}
            onChange={(event) =>
              onUpdateContext({ description: event.target.value })
            }
          />
        </div>
        <div className="wb-field">
          <label
            className="wb-field-label"
            htmlFor="context-acceptance-criteria"
          >
            Acceptance Criteria <RequiredMark />
          </label>
          <textarea
            id="context-acceptance-criteria"
            className={acError ? "invalid wb-field-tall" : "wb-field-tall"}
            value={context.acceptanceCriteria}
            onChange={(event) =>
              onUpdateContext({ acceptanceCriteria: event.target.value })
            }
          />
          <FieldError error={acError} />
          <div className="wb-field-hint">
            Acceptance criteria is passed to the implementer, and — when the
            validator is enabled — to the validator as well.
          </div>
        </div>
      </section>

      <InspectorConfigBlock
        label="Implementer"
        summary={summarizeImplementer(cascade.implementer.value)}
        source={cascade.implementer.source}
        onOverride={() =>
          onSetContextOverride(
            "implementer",
            deepClone(cascade.implementer.value),
          )
        }
        onReset={() => onClearContextOverride("implementer")}
      >
        <ImplementerEditor
          value={cascade.implementer.value}
          onChange={(next) => onSetContextOverride("implementer", next)}
          readOnly={cascade.implementer.source !== "context-override"}
        />
      </InspectorConfigBlock>

      <InspectorConfigBlock
        label="Collaboration"
        summary={summarizeCollaboration(cascade.collaboration.value)}
        source={cascade.collaboration.source}
        onOverride={() =>
          onSetContextOverride(
            "collaboration",
            deepClone(cascade.collaboration.value),
          )
        }
        onReset={() => onClearContextOverride("collaboration")}
      >
        <CollaborationEditor
          value={cascade.collaboration.value}
          onChange={(next) => onSetContextOverride("collaboration", next)}
          readOnly={cascade.collaboration.source !== "context-override"}
        />
      </InspectorConfigBlock>

      <ContextValidatorBlock
        cascade={cascade.contextValidator}
        onOverride={(value) => {
          const override: ContextValidatorOverride = {
            kind: "use",
            value: deepClone(value),
          };
          onSetContextOverride("contextValidator", override);
        }}
        onChange={(value) => {
          const override: ContextValidatorOverride = {
            kind: "use",
            value,
          };
          onSetContextOverride("contextValidator", override);
        }}
        onReset={() => onClearContextOverride("contextValidator")}
        onDisable={onDisableValidator}
        onEnable={onEnableValidator}
      />

      <ScriptValidatorBlock
        scopeLabel="Context script validator"
        cascade={cascade.scriptValidator}
        onChange={(value) =>
          onSetContextOverride("scriptValidator", deepClone(value))
        }
        onReset={() => onClearContextOverride("scriptValidator")}
      />

      <HumanApprovalGateBlock
        scopeLabel="Context human approval gate"
        hint="After all validators pass, this context parks for your review before merge. Reject sends feedback into the next iteration."
        cascade={cascade.humanApprovalGate}
        onChange={(value) =>
          onSetContextOverride("humanApprovalGate", deepClone(value))
        }
        onReset={() => onClearContextOverride("humanApprovalGate")}
      />

      <InspectorConfigBlock
        label="Iteration policy"
        summary={summarizeIterationPolicy(cascade.iterationPolicy.value)}
        source={cascade.iterationPolicy.source}
        onOverride={() =>
          onSetContextOverride(
            "iterationPolicy",
            deepClone(cascade.iterationPolicy.value),
          )
        }
        onReset={() => onClearContextOverride("iterationPolicy")}
      >
        <IterationPolicyEditor
          value={cascade.iterationPolicy.value}
          onChange={(next) => onSetContextOverride("iterationPolicy", next)}
          readOnly={cascade.iterationPolicy.source !== "context-override"}
        />
      </InspectorConfigBlock>

      <InspectorConfigBlock
        label="Circuit breaker"
        summary={summarizeCircuitBreaker(cascade.circuitBreaker.value)}
        source={cascade.circuitBreaker.source}
        onOverride={() =>
          onSetContextOverride(
            "circuitBreaker",
            deepClone(cascade.circuitBreaker.value),
          )
        }
        onReset={() => onClearContextOverride("circuitBreaker")}
      >
        <CircuitBreakerEditor
          value={cascade.circuitBreaker.value}
          onChange={(next) => onSetContextOverride("circuitBreaker", next)}
          readOnly={cascade.circuitBreaker.source !== "context-override"}
        />
      </InspectorConfigBlock>

      <InspectorConfigBlock
        label="Mutability"
        summary={summarizeMutability(cascade.mutability.value)}
        source={cascade.mutability.source}
        onOverride={() =>
          onSetContextOverride(
            "mutability",
            deepClone(cascade.mutability.value),
          )
        }
        onReset={() => onClearContextOverride("mutability")}
      >
        <MutabilityEditor
          value={cascade.mutability.value}
          onChange={(next) => onSetContextOverride("mutability", next)}
          readOnly={cascade.mutability.source !== "context-override"}
        />
      </InspectorConfigBlock>

      <section className="wb-section" data-section="tasks">
        <div className="wb-section-header">
          <span className="wb-section-title">Tasks</span>
        </div>
        <div className="wb-section-content">
          <div className="wb-task-list">
            {tasks.map((task, index) => {
              const expanded = selectedTaskId === task.id;
              const firstTask = index === 0;
              const lastTask = index === tasks.length - 1;
              const hasTaskErrors = validationErrors.some(
                (e) => e.taskId === task.id,
              );
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
                <div
                  className={`wb-task-item${expanded ? " expanded active-task" : ""}${hasTaskErrors ? " has-errors" : ""}`}
                  key={task.id}
                >
                  <div
                    className="wb-task-item-main"
                    onClick={() => onSelectTask(task.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectTask(task.id);
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

                  {expanded ? (
                    <div className="wb-task-detail">
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
                            onUpdateTask(task.id, {
                              title: event.target.value,
                            })
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
                            onUpdateTask(task.id, {
                              instructions: event.target.value,
                            })
                          }
                          value={task.instructions}
                        />
                        <FieldError error={instrError} />
                      </div>

                      <div className="wb-task-detail-actions">
                        <button
                          className="wb-btn wb-btn-xs wb-btn-default"
                          disabled={firstTask}
                          onClick={() => onMoveTask(task.id, "up")}
                          type="button"
                        >
                          Move Up
                        </button>
                        <button
                          className="wb-btn wb-btn-xs wb-btn-default"
                          disabled={lastTask}
                          onClick={() => onMoveTask(task.id, "down")}
                          type="button"
                        >
                          Move Down
                        </button>
                        <button
                          className="wb-btn wb-btn-xs wb-btn-danger"
                          onClick={() => onRemoveTask(task.id)}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          <button className="wb-btn-add-task" onClick={onAddTask} type="button">
            + Add Task
          </button>
        </div>
      </section>

      <section className="wb-section" data-section="delete-context">
        <div className="wb-section-content">
          <button
            className="wb-btn wb-btn-sm wb-btn-danger"
            onClick={onDelete}
            type="button"
          >
            Delete Context
          </button>
        </div>
      </section>
    </div>
  );
}

function ContextValidatorBlock({
  cascade,
  onOverride,
  onChange,
  onReset,
  onDisable,
  onEnable,
}: {
  cascade: ResolvedContextCascade["contextValidator"];
  onOverride: (value: GraphWorkflowAgentValidatorConfig) => void;
  onChange: (value: GraphWorkflowAgentValidatorConfig) => void;
  onReset: () => void;
  onDisable: () => void;
  onEnable: () => void;
}): React.JSX.Element {
  if (cascade.source === "disabled") {
    return (
      <InspectorConfigBlock
        label="Context validator"
        summary="disabled"
        source="disabled"
        onOverride={() => {
          // Re-enable then transition to override with seeded claude validator
          const seedValidator: GraphWorkflowAgentValidatorConfig = {
            type: "claude",
            enabled: true,
            continuity: { enabled: true },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          };
          onOverride(seedValidator);
        }}
        onToggleDisabled={onEnable}
      >
        <ReadonlyBlockPreview
          entries={[["status", "disabled for this context"]]}
        />
      </InspectorConfigBlock>
    );
  }

  const validator = cascade.value;

  return (
    <InspectorConfigBlock
      label="Context validator"
      summary={summarizeValidator(validator)}
      source={cascade.source}
      onOverride={() => onOverride(validator)}
      onReset={cascade.source === "context-override" ? onReset : undefined}
      onToggleDisabled={onDisable}
    >
      <ContextValidatorEditor
        value={validator}
        onChange={onChange}
        readOnly={cascade.source !== "context-override"}
      />
    </InspectorConfigBlock>
  );
}

function ScriptValidatorBlock({
  scopeLabel,
  cascade,
  onChange,
  onReset,
}: {
  scopeLabel: string;
  cascade:
    | ResolvedContextCascade["scriptValidator"]
    | WorkflowCascade["scriptValidator"];
  onChange: (value: GraphWorkflowScriptValidatorConfig) => void;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <InspectorConfigBlock
      label="Script validator"
      summary={summarizeScriptValidator(cascade.value)}
      source={cascade.source}
      defaultOpen
      allowInheritedEditing
      onReset={cascade.source === "context-override" ? onReset : undefined}
    >
      <ScriptValidatorControl
        label={scopeLabel}
        value={cascade.value.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
    </InspectorConfigBlock>
  );
}

function HumanApprovalGateBlock({
  scopeLabel,
  hint,
  cascade,
  onChange,
  onReset,
}: {
  scopeLabel: string;
  hint: string;
  cascade:
    | ResolvedContextCascade["humanApprovalGate"]
    | WorkflowCascade["humanApprovalGate"];
  onChange: (value: GraphWorkflowHumanApprovalGateConfig) => void;
  onReset: () => void;
}): React.JSX.Element {
  const enabled = cascade.value.enabled;
  return (
    <InspectorConfigBlock
      label="Human approval gate"
      summary={summarizeHumanApprovalGate(cascade.value)}
      source={cascade.source}
      defaultOpen
      allowInheritedEditing
      onReset={cascade.source === "context-override" ? onReset : undefined}
    >
      <div
        className={`wb-approval-gate-control${enabled ? " wb-approval-gate-control--on" : ""}`}
      >
        <div
          className="config-toggle config-toggle--gate"
          onClick={() => onChange({ enabled: !enabled })}
          role="switch"
          aria-label={scopeLabel}
          aria-checked={enabled}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onChange({ enabled: !enabled });
            }
          }}
        >
          <div className={`config-toggle-track${enabled ? " active" : ""}`}>
            <div className="config-toggle-knob" />
          </div>
          <span className="config-toggle-label">{enabled ? "ON" : "OFF"}</span>
        </div>
        <div className="wb-field-hint">{hint}</div>
      </div>
    </InspectorConfigBlock>
  );
}

function ScriptValidatorControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="wb-script-validator-control">
      <div
        className="config-toggle"
        onClick={() => onChange(!value)}
        role="switch"
        aria-label={label}
        aria-checked={value}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onChange(!value);
          }
        }}
      >
        <div className={`config-toggle-track${value ? " active" : ""}`}>
          <div className="config-toggle-knob" />
        </div>
        <span className="config-toggle-label">{value ? "ON" : "OFF"}</span>
      </div>
      <div className="wb-field-hint">
        Runs the project&apos;s <code>preMergeCommand</code> before agent
        validation.
      </div>
    </div>
  );
}

function ReadonlyBlockPreview({
  entries,
}: {
  entries: Array<[string, string]>;
}): React.JSX.Element {
  return (
    <dl className="wb-inspector-block__preview">
      {entries.map(([key, value]) => (
        <div className="wb-inspector-block__preview-row" key={key}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
