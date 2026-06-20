"use client";

import { useEffect, useMemo, useState } from "react";
import { Tab, Tabs } from "@/components/ui/Tabs";
import { cn } from "@/lib/ui/cn";
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

const WB_INSPECTOR_CLASS =
  "flex w-[340px] min-w-[340px] flex-col overflow-hidden border-l border-solid border-border-subtle bg-bg-surface max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:border-l-0 max-768:[.app[data-page=workflow-builder][data-mobile-panel=graph]_&]:hidden";

const WB_BTN_BASE =
  "inline-flex items-center justify-center gap-[6px] whitespace-nowrap cursor-pointer rounded-sm border border-solid border-border-default font-medium transition-all duration-150";
const WB_BTN_SM = "h-[28px] px-[12px] py-[5px] text-[0.72rem]";
const WB_BTN_XS = "h-[22px] px-[8px] py-[3px] text-[0.7rem]";
const WB_BTN_DEFAULT =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:border-border-strong hover:text-text-primary";
const WB_BTN_PRIMARY =
  "bg-[var(--cc-cyan-a12)] text-cyan border-[var(--cyan-glow-strong)] hover:bg-[var(--cc-cyan-a20)] hover:shadow-[0_0_12px_var(--cyan-glow)]";
const WB_BTN_DANGER =
  "bg-bg-raised text-red border-[var(--cc-red-a25)] hover:bg-[var(--cc-red-a10)]";

// .wb-field input/textarea/select recipe (descendant element rule reattached).
const WB_FIELD_INPUT =
  "w-full rounded-sm border border-solid border-border-default bg-bg-base px-[10px] py-[8px] font-[inherit] text-[0.78rem] text-text-primary outline-none transition-[border-color] duration-150 focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";
const WB_FIELD_TEXTAREA = "min-h-[64px] resize-y leading-[1.5]";
// .invalid override for .wb-field controls.
const WB_FIELD_INVALID =
  "border-red focus:border-red focus:shadow-[0_0_0_1px_var(--cc-red-a25)]";

const WB_FIELD_LABEL =
  "mb-xs block text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";
const WB_FIELD_HINT =
  "mt-xs font-mono text-[0.7rem] leading-[1.5] text-text-tertiary";

// .wb-task-detail-field input/textarea recipe.
const WB_TASK_INPUT =
  "box-border w-full rounded-sm border border-solid border-border-default bg-bg-base px-[10px] py-[7px] font-[inherit] text-[0.75rem] text-text-primary outline-none transition-[border-color] duration-150 focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";

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
  return (
    <div className="mt-[4px] text-[0.7rem] leading-[1.3] text-red">
      {error.message}
    </div>
  );
}

function RequiredMark(): React.JSX.Element {
  return <span className="font-semibold text-red">*</span>;
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
      <aside className={WB_INSPECTOR_CLASS}>
        <div className="wb-inspector-body flex-1 overflow-y-auto p-md">
          Loading workflow definition...
        </div>
      </aside>
    );
  }

  const contextTabEnabled = selectedContext != null;
  const contextTabLabel = selectedContext
    ? `Context: ${selectedContext.title}`
    : "Context";

  const workflowConfig = draftDefinition.workflowConfig ?? {};

  return (
    <aside className={WB_INSPECTOR_CLASS}>
      <header className="flex min-h-[44px] items-center justify-between gap-sm border-b border-solid border-border-dim px-md py-[12px]">
        <Tabs
          role="tablist"
          aria-label="Inspector scope"
          layoutClassName="flex-[1_1_auto] min-w-0 overflow-hidden"
        >
          <Tab
            type="button"
            role="tab"
            aria-selected={activeTab === "workflow"}
            active={activeTab === "workflow"}
            layoutClassName="shrink-0"
            onClick={() => setActiveTab("workflow")}
          >
            Workflow
          </Tab>
          <Tab
            type="button"
            role="tab"
            aria-selected={activeTab === "context"}
            aria-disabled={!contextTabEnabled}
            disabled={!contextTabEnabled}
            active={activeTab === "context"}
            title={
              contextTabEnabled ? undefined : "Select a context in the graph"
            }
            layoutClassName="min-w-0 overflow-hidden text-ellipsis"
            onClick={() => {
              if (contextTabEnabled) setActiveTab("context");
            }}
          >
            {contextTabLabel}
          </Tab>
        </Tabs>
        <button
          className={cn(
            WB_BTN_BASE,
            WB_BTN_SM,
            "flex-shrink-0",
            dirty ? WB_BTN_PRIMARY : WB_BTN_DEFAULT,
          )}
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

      <div className="wb-inspector-body flex-1 overflow-y-auto p-md">
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
    <div className="flex flex-col gap-sm" data-scope="workflow">
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
    <div className="flex flex-col gap-sm" data-scope="context">
      <section
        className="mb-xs flex flex-col gap-md border-b border-solid border-border-dim pb-md"
        data-section="header"
      >
        <div className="mb-md">
          <label className={WB_FIELD_LABEL} htmlFor="context-title">
            Title <RequiredMark />
          </label>
          <input
            id="context-title"
            type="text"
            className={WB_FIELD_INPUT}
            value={context.title}
            onChange={(event) => onUpdateContext({ title: event.target.value })}
          />
        </div>
        <div className="mb-md">
          <label className={WB_FIELD_LABEL} htmlFor="context-description">
            Description
          </label>
          <textarea
            id="context-description"
            rows={2}
            className={cn(WB_FIELD_INPUT, WB_FIELD_TEXTAREA)}
            value={context.description ?? ""}
            onChange={(event) =>
              onUpdateContext({ description: event.target.value })
            }
          />
        </div>
        <div className="mb-md">
          <label
            className={WB_FIELD_LABEL}
            htmlFor="context-acceptance-criteria"
          >
            Acceptance Criteria <RequiredMark />
          </label>
          <textarea
            id="context-acceptance-criteria"
            className={cn(
              WB_FIELD_INPUT,
              WB_FIELD_TEXTAREA,
              "min-h-[140px]",
              acError && WB_FIELD_INVALID,
            )}
            value={context.acceptanceCriteria}
            onChange={(event) =>
              onUpdateContext({ acceptanceCriteria: event.target.value })
            }
          />
          <FieldError error={acError} />
          <div className={WB_FIELD_HINT}>
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

      <section className="mb-md" data-section="tasks">
        <div className="flex cursor-pointer items-center justify-between py-[8px] select-none">
          <span className="text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
            Tasks
          </span>
        </div>
        <div className="border-t border-solid border-border-dim py-sm">
          <div className="list-none">
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
                  className={cn(
                    "mb-[2px] rounded-sm border border-solid border-transparent",
                    expanded && "border-border-dim bg-bg-base",
                  )}
                  key={task.id}
                >
                  <div
                    className={cn(
                      "flex cursor-pointer items-center gap-[8px] rounded-sm px-[10px] py-[8px] transition-[background] duration-150 hover:bg-bg-elevated",
                      expanded && "bg-bg-raised",
                      hasTaskErrors && "border-l-2 border-solid border-l-red",
                    )}
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
                    <span className="w-[16px] flex-shrink-0 text-center text-[0.7rem] font-semibold text-text-tertiary">
                      {task.order}
                    </span>
                    <span className="flex-1 overflow-hidden text-[0.75rem] text-ellipsis whitespace-nowrap text-text-primary">
                      {task.title || "(untitled)"}
                    </span>
                    {hasTaskErrors && (
                      <span className="mr-[4px] ml-auto h-[6px] w-[6px] flex-shrink-0 rounded-full bg-red" />
                    )}
                    <span
                      className={cn(
                        "flex-shrink-0 text-[0.7rem] text-text-tertiary transition-transform duration-150",
                        expanded && "rotate-90",
                      )}
                    >
                      ▸
                    </span>
                  </div>

                  {expanded ? (
                    <div className="px-[10px] pt-[8px] pb-[10px] pl-[34px] text-[0.72rem] leading-[1.5] text-text-secondary">
                      <div className="mb-[10px]">
                        <label
                          className="mb-[4px] block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase"
                          htmlFor={`task-title-${task.id}`}
                        >
                          Title <RequiredMark />
                        </label>
                        <input
                          className={cn(
                            WB_TASK_INPUT,
                            titleError && WB_FIELD_INVALID,
                          )}
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

                      <div className="mb-[10px]">
                        <label
                          className="mb-[4px] block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase"
                          htmlFor={`task-instructions-${task.id}`}
                        >
                          Instructions <RequiredMark />
                        </label>
                        <textarea
                          className={cn(
                            WB_TASK_INPUT,
                            "mb-[2px] min-h-[56px] resize-y",
                            instrError && WB_FIELD_INVALID,
                          )}
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

                      <div className="mt-[8px] flex gap-[6px] border-t border-solid border-border-dim pt-[8px]">
                        <button
                          className={cn(WB_BTN_BASE, WB_BTN_XS, WB_BTN_DEFAULT)}
                          disabled={firstTask}
                          onClick={() => onMoveTask(task.id, "up")}
                          type="button"
                        >
                          Move Up
                        </button>
                        <button
                          className={cn(WB_BTN_BASE, WB_BTN_XS, WB_BTN_DEFAULT)}
                          disabled={lastTask}
                          onClick={() => onMoveTask(task.id, "down")}
                          type="button"
                        >
                          Move Down
                        </button>
                        <button
                          className={cn(WB_BTN_BASE, WB_BTN_XS, WB_BTN_DANGER)}
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

          <button
            className="w-full cursor-pointer rounded-sm border border-dashed border-border-default bg-bg-base p-[8px] font-[inherit] text-[0.72rem] text-text-tertiary transition-all duration-150 hover:border-cyan-dim hover:bg-[var(--cc-cyan-a04)] hover:text-cyan"
            onClick={onAddTask}
            type="button"
          >
            + Add Task
          </button>
        </div>
      </section>

      <section className="mb-md" data-section="delete-context">
        <div className="border-t border-solid border-border-dim py-sm">
          <button
            className={cn(WB_BTN_BASE, WB_BTN_SM, WB_BTN_DANGER)}
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
        className={cn(
          "flex flex-col gap-sm rounded-md transition-[background] duration-150 ease-[ease]",
          enabled && "-m-sm bg-amber-glow p-sm",
        )}
      >
        <div
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
          <div
            className={cn(
              enabled &&
                "border-[var(--amber-dim)] bg-amber-glow shadow-[0_0_10px_var(--amber-glow)]",
            )}
          >
            <div className={cn(enabled && "bg-amber")} />
          </div>
          <span>{enabled ? "ON" : "OFF"}</span>
        </div>
        <div className={WB_FIELD_HINT}>{hint}</div>
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
    <div className="flex flex-col gap-sm">
      <div
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
        <div>
          <div />
        </div>
        <span>{value ? "ON" : "OFF"}</span>
      </div>
      <div className={WB_FIELD_HINT}>
        Runs the project&apos;s{" "}
        <code className="rounded-[3px] bg-bg-raised px-[5px] py-[1px] font-mono text-[0.7rem] text-cyan">
          preMergeCommand
        </code>{" "}
        before agent validation.
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
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-md gap-y-[3px] p-0 font-mono">
      {entries.map(([key, value]) => (
        <div className="[display:contents]" key={key}>
          <dt className="min-w-0 overflow-hidden text-[0.7rem] font-medium tracking-normal text-ellipsis whitespace-nowrap text-text-tertiary normal-case">
            {key}
          </dt>
          <dd className="m-0 min-w-0 justify-self-end text-right text-[0.72rem] font-medium [overflow-wrap:anywhere] text-text-primary">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
