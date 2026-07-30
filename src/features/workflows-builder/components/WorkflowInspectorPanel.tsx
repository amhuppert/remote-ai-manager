"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import {
  MultilineInput,
  MultilinePrimaryActionScope,
  useMultilinePrimaryActionRegistry,
} from "@/components/MultilineInput";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "@/components/ui/Tabs";
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
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { WorkflowCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  ContextValidatorOverride,
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowAskUserQuestionsConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowHumanApprovalGateConfig,
  GraphWorkflowIterationPolicy,
  GraphWorkflowMutabilityPolicy,
  GraphWorkflowPlanRepairPolicy,
  GraphWorkflowScriptValidatorConfig,
} from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowConfigOverride,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import {
  resolveContextCollaboration,
  resolveWorkflowCollaboration,
} from "./collaboration-cascade";
import InspectorConfigBlock, {
  type InspectorConfigBlockSource,
} from "./InspectorConfigBlock";
import ParameterDeclarationEditor from "./ParameterDeclarationEditor";
import { SectionLabel } from "@/components/ui/SectionHeader";
import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";
import {
  CircuitBreakerEditor,
  CollaborationEditor,
  ContextValidatorEditor,
  ImplementerEditor,
  IterationPolicyEditor,
  PlanRepairEditor,
} from "@/components/workflow-config/FieldEditors";
import InspectorFocusSheet from "./InspectorFocusSheet";
import {
  ApprovalGlyphIcon,
  BackendChip,
  EditGlyphIcon,
  ExpandGlyphIcon,
  GateChip,
  QuestionGlyphIcon,
  ScriptGlyphIcon,
  implementerChipLabel,
  validatorChipLabel,
} from "@/components/workflow-config/InspectorChips";

const WB_INSPECTOR_CLASS =
  "flex w-[500px] min-w-[500px] flex-col overflow-hidden border-l border-solid border-border-subtle bg-bg-surface max-1180:w-[420px] max-1180:min-w-[420px] max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:border-l-0 max-768:[.app[data-page=workflow-builder][data-mobile-panel=graph]_&]:hidden";

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

// .invalid override for the inspector's field controls.
const WB_FIELD_INVALID =
  "border-red focus:border-red focus:shadow-[0_0_0_1px_var(--cc-red-a25)]";

const WB_FIELD_LABEL =
  "mb-xs block text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";
// Enlarged, weighted title input (the context's headline field).
const WB_TITLE_INPUT =
  "w-full rounded-sm border border-solid border-border-default bg-bg-base px-[12px] py-[10px] font-[inherit] text-[0.9rem] font-semibold text-text-primary outline-none transition-[border-color] duration-150 focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";

// Rendered-Markdown read view for the long-form brief fields; click (or
// Enter/Space) opens the focus sheet.
const WB_READ_VIEW =
  "w-full box-border cursor-text rounded-sm border border-solid border-border-default bg-bg-base px-[14px] py-[10px] text-left font-[inherit] text-[0.82rem] leading-[1.6] text-text-primary transition-[border-color] duration-150 hover:border-border-strong focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

// Small inline affordance in a field's label row (Edit / Edit in focus view).
const WB_FIELD_ACTION =
  "inline-flex cursor-pointer items-center gap-[5px] rounded-sm border-0 bg-transparent px-[6px] py-[2px] font-mono text-[0.7rem] text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

// .wb-task-detail-field input/textarea recipe.
const WB_TASK_INPUT =
  "box-border w-full rounded-sm border border-solid border-border-default bg-bg-base px-[10px] py-[7px] font-[inherit] text-[0.75rem] text-text-primary outline-none transition-[border-color] duration-150 focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";

interface WorkflowInspectorPanelProps {
  onSave: () => Promise<void>;
  onDelete: (contextId: string) => void;
  saving: boolean;
  globalDefaults?: WorkflowDefaults;
  activeTab?: InspectorTab;
  onTabChange?: (tab: InspectorTab) => void;
  voiceProjectName?: string | null;
}

export type InspectorTab = "workflow" | "context";

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

// Accept-time lint codes that pertain to parameter declarations and their
// references. Surfaced as the parameter editor's `saveError` so the offending
// field/parameter is named in context (R8.3).
const PARAMETER_LINT_CODES = new Set<string>([
  "undeclared-parameter-reference",
  "duplicate-parameter-name",
  "referenced-parameter-without-value",
  "invalid-placeholder-token",
  "empty-enum-options",
  "default-not-in-enum-options",
  "default-length-out-of-bounds",
]);

// First parameter-related lint error (if any) formatted into a concise message.
// Each error already carries a locator-rich `message`; this just selects the
// parameter-relevant one so it renders on the editor rather than nowhere.
function parameterSaveError(
  errors: WorkflowGraphValidationError[],
): string | null {
  const match = errors.find((error) => PARAMETER_LINT_CODES.has(error.code));
  return match ? match.message : null;
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

// Hairline-ruled group header (Brief / Agents / Quality gates / …).
function GroupHeader({
  label,
  count,
}: {
  label: string;
  count?: number;
}): React.JSX.Element {
  return (
    <div className="mb-[10px] flex items-center gap-sm">
      <SectionLabel>{label}</SectionLabel>
      {count !== undefined ? (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {count}
        </span>
      ) : null}
      <span aria-hidden="true" className="h-px flex-1 bg-border-dim" />
    </div>
  );
}

// Read view for a Markdown brief field. The whole box is a click target that
// opens the focus sheet; keyboard users get the same via Enter/Space.
function MarkdownReadView({
  value,
  placeholder,
  ariaLabel,
  invalid,
  onOpen,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  invalid?: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      className={cn(WB_READ_VIEW, invalid && "border-red")}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      {value.trim() ? (
        <CompactMarkdown content={value} />
      ) : (
        <span className="text-text-tertiary">{placeholder}</span>
      )}
    </div>
  );
}

// Numbered-list entries in the acceptance criteria, for the "N criteria" hint.
function countCriteria(text: string): number {
  return (text.match(/^\s*\d+\./gm) ?? []).length;
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
  const threshold = policy.consecutiveFailureThreshold;
  return threshold === undefined
    ? "threshold default"
    : `halt after ${threshold} fails`;
}

function summarizeCollaboration(config: WorkflowCollaborationConfig): string {
  return config.enabled ? "on" : "off";
}

function summarizePlanRepair(policy: GraphWorkflowPlanRepairPolicy): string {
  if (!policy.enabled) return "off";
  const agent = policy.agent
    ? `${policy.agent.model} agent`
    : "default agent";
  return `on · ${policy.maxAttemptsPerContext}/context · ${agent}`;
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
  askUserQuestions: {
    value: GraphWorkflowAskUserQuestionsConfig;
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
  planRepair: {
    value: GraphWorkflowPlanRepairPolicy;
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
      | "askUserQuestions"
      | "iterationPolicy"
      | "circuitBreaker"
      | "mutability"
      | "planRepair",
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
    askUserQuestions: resolvePlain("askUserQuestions"),
    iterationPolicy: resolvePlain("iterationPolicy"),
    circuitBreaker: resolvePlain("circuitBreaker"),
    mutability: resolvePlain("mutability"),
    planRepair: resolvePlain("planRepair"),
    collaboration: resolveContextCollaboration(
      context.collaboration,
      workflowConfig.collaboration,
      globalDefaults.collaboration,
    ),
  };
}

// Context-level deviations from the cascade (overrides + the disabled
// validator marker), shown as the resolved-setup strip's override count.
function contextOverrideCount(cascade: ResolvedContextCascade): number {
  const sources: InspectorConfigBlockSource[] = [
    cascade.implementer.source,
    cascade.contextValidator.source,
    cascade.scriptValidator.source,
    cascade.humanApprovalGate.source,
    cascade.askUserQuestions.source,
    cascade.iterationPolicy.source,
    cascade.circuitBreaker.source,
    cascade.mutability.source,
    cascade.planRepair.source,
    cascade.collaboration.source,
  ];
  return sources.filter(
    (source) => source === "context-override" || source === "disabled",
  ).length;
}

// At-a-glance summary of the selected context's effective configuration:
// implementer + enabled gates as compact chips, plus the override count.
function ResolvedSetupStrip({
  cascade,
}: {
  cascade: ResolvedContextCascade;
}): React.JSX.Element {
  const implementer = cascade.implementer.value;
  const validator = cascade.contextValidator;
  const overrides = contextOverrideCount(cascade);

  return (
    <div
      className="flex flex-shrink-0 flex-wrap items-center gap-[6px] border-b border-solid border-border-dim bg-bg-base px-lg py-[10px]"
      data-section="resolved-setup"
    >
      <BackendChip backend={implementer.backend}>
        {implementerChipLabel(implementer)}
      </BackendChip>
      {validator.source !== "disabled" && validator.value.enabled ? (
        <BackendChip
          backend={validator.value.type === "codex" ? "codex" : "claude"}
        >
          Validator · {validatorChipLabel(validator.value)}
        </BackendChip>
      ) : null}
      {cascade.scriptValidator.value.enabled ? (
        <GateChip tone="neutral" icon={<ScriptGlyphIcon size={13} />}>
          Script
        </GateChip>
      ) : null}
      {cascade.humanApprovalGate.value.enabled ? (
        <GateChip tone="amber" icon={<ApprovalGlyphIcon size={13} />}>
          Approval
        </GateChip>
      ) : null}
      {cascade.askUserQuestions.value.enabled ? (
        <GateChip tone="amber" icon={<QuestionGlyphIcon size={13} />}>
          Questions
        </GateChip>
      ) : null}
      <span className="ml-auto font-mono text-[0.7rem] whitespace-nowrap text-text-tertiary">
        {overrides} {overrides === 1 ? "override" : "overrides"}
      </span>
    </div>
  );
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
  askUserQuestions: {
    value: GraphWorkflowAskUserQuestionsConfig;
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
  planRepair: {
    value: GraphWorkflowPlanRepairPolicy;
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
    askUserQuestions: resolve("askUserQuestions"),
    iterationPolicy: resolve("iterationPolicy"),
    circuitBreaker: resolve("circuitBreaker"),
    mutability: resolve("mutability"),
    planRepair: resolve("planRepair"),
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
  voiceProjectName,
}: WorkflowInspectorPanelProps): React.JSX.Element {
  const defaults = globalDefaults ?? SEEDED_WORKFLOW_DEFAULTS;
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
  const multilineActions = useMultilinePrimaryActionRegistry();
  const activeTab = controlledActiveTab ?? internalActiveTab;
  const handleSave = useCallback(
    (force = false) => {
      if ((!dirty && !force) || saving) return;
      void onSave();
    },
    [dirty, onSave, saving],
  );

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

  const workflowConfig = draftDefinition.workflowConfig ?? {};

  // The Context panel needs a non-null selectedContext; the tab is disabled
  // until one is picked, but coerce a stale "context" value back to "workflow"
  // so no tabpanel resolves to an absent context.
  const tabValue: InspectorTab =
    activeTab === "context" && !selectedContext ? "workflow" : activeTab;

  const stripCascade =
    tabValue === "context" && selectedContext
      ? computeContextCascade(selectedContext, workflowConfig, defaults)
      : null;

  return (
    <MultilinePrimaryActionScope registry={multilineActions}>
      <aside className={WB_INSPECTOR_CLASS}>
        <TabsRoot
          value={tabValue}
          onValueChange={(value) => setActiveTab(value as InspectorTab)}
          layoutClassName="[display:contents]"
        >
          <header className="flex min-h-[44px] items-center gap-sm border-b border-solid border-border-dim px-md py-[12px]">
            <TabsList
              aria-label="Inspector scope"
              layoutClassName="shrink-0 min-w-0 overflow-hidden"
            >
              <TabsTrigger value="workflow" layoutClassName="shrink-0">
                Workflow
              </TabsTrigger>
              <TabsTrigger
                value="context"
                disabled={!contextTabEnabled}
                title={
                  contextTabEnabled
                    ? undefined
                    : "Select a context in the graph"
                }
                layoutClassName="min-w-0 overflow-hidden text-ellipsis"
              >
                Context
              </TabsTrigger>
            </TabsList>
            <div className="min-w-0 flex-1 overflow-hidden text-[0.78rem] font-semibold text-ellipsis whitespace-nowrap text-text-primary">
              {tabValue === "context" && selectedContext
                ? selectedContext.title
                : null}
            </div>
            <button
              className={cn(
                WB_BTN_BASE,
                WB_BTN_SM,
                "flex-shrink-0",
                dirty ? WB_BTN_PRIMARY : WB_BTN_DEFAULT,
              )}
              disabled={saving || (!dirty && !multilineActions.voiceBusy)}
              onClick={() => multilineActions.primaryAction(handleSave)}
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

          {stripCascade ? <ResolvedSetupStrip cascade={stripCascade} /> : null}

          <div className="wb-inspector-body flex-1 overflow-y-auto p-lg">
            <TabsContent value="workflow">
              <WorkflowTabBody
                workflowConfig={workflowConfig}
                globalDefaults={defaults}
                parameters={draftDefinition.parameters}
                parameterSaveError={parameterSaveError(validationErrors)}
                onParametersChange={(next) => {
                  updateDefinition({ ...draftDefinition, parameters: next });
                }}
                onPrimaryAction={handleSave}
                voiceProjectName={voiceProjectName}
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
            </TabsContent>
            {selectedContext ? (
              <TabsContent value="context">
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
                      disableContextValidator(
                        draftDefinition,
                        selectedContext.id,
                      ),
                    );
                  }}
                  onEnableValidator={() => {
                    updateDefinition(
                      enableContextValidator(
                        draftDefinition,
                        selectedContext.id,
                      ),
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
                    updateDefinition(
                      updateTask(draftDefinition, taskId, updates),
                    );
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
                    setSelectedTaskId(
                      selectedTaskId === taskId ? null : taskId,
                    );
                  }}
                  onDelete={() => onDelete(selectedContext.id)}
                  onPrimaryAction={handleSave}
                  voiceProjectName={voiceProjectName}
                />
              </TabsContent>
            ) : null}
          </div>
        </TabsRoot>
      </aside>
    </MultilinePrimaryActionScope>
  );
}

function WorkflowTabBody({
  workflowConfig,
  globalDefaults,
  parameters,
  parameterSaveError,
  onParametersChange,
  onPrimaryAction,
  voiceProjectName,
  onSetOverride,
  onClearOverride,
}: {
  workflowConfig: WorkflowConfigOverride;
  globalDefaults: WorkflowDefaults;
  parameters: ParameterDeclaration[];
  parameterSaveError: string | null;
  onParametersChange: (next: ParameterDeclaration[]) => void;
  onPrimaryAction: (force?: boolean) => void;
  voiceProjectName?: string | null;
  onSetOverride: <K extends keyof WorkflowConfigOverride>(
    block: K,
    value: NonNullable<WorkflowConfigOverride[K]>,
  ) => void;
  onClearOverride: (block: keyof WorkflowConfigOverride) => void;
}): React.JSX.Element {
  const cascade = computeWorkflowCascade(workflowConfig, globalDefaults);
  const isWorkflowOverride = (source: "global" | "context-override") =>
    source === "context-override";

  const validatorValue = cascade.contextValidator.value;

  return (
    <div className="flex flex-col" data-scope="workflow">
      <section className="mb-xl" data-section="parameters">
        <GroupHeader label="Launch parameters" />
        <ParameterDeclarationEditor
          parameters={parameters}
          onChange={onParametersChange}
          saveError={parameterSaveError}
          onPrimaryAction={onPrimaryAction}
          voiceProjectName={voiceProjectName}
        />
      </section>

      <section className="mb-xl" data-section="agents">
        <GroupHeader label="Agents" />
        <div className="flex flex-col gap-sm">
          <InspectorConfigBlock
            label="Implementer"
            chip={
              <BackendChip backend={cascade.implementer.value.backend}>
                {implementerChipLabel(cascade.implementer.value)}
              </BackendChip>
            }
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
            headerSwitch={{
              checked: cascade.collaboration.value.enabled,
              onCheckedChange: (enabled) =>
                onSetOverride("collaboration", {
                  ...deepClone(cascade.collaboration.value),
                  enabled,
                }),
              ariaLabel: "Workflow collaboration enabled",
            }}
            onOverride={() =>
              onSetOverride(
                "collaboration",
                deepClone(cascade.collaboration.value),
              )
            }
            onReset={() => onClearOverride("collaboration")}
          >
            <CollaborationEditor
              value={cascade.collaboration.value}
              onChange={(next) => onSetOverride("collaboration", next)}
              readOnly={!isWorkflowOverride(cascade.collaboration.source)}
            />
          </InspectorConfigBlock>
        </div>
      </section>

      <section className="mb-xl" data-section="quality-gates">
        <GroupHeader label="Quality gates" />
        <div className="flex flex-col gap-sm">
          <InspectorConfigBlock
            label="Context validator"
            chip={
              validatorValue.enabled ? (
                <BackendChip
                  backend={validatorValue.type === "codex" ? "codex" : "claude"}
                >
                  {validatorChipLabel(validatorValue)}
                </BackendChip>
              ) : undefined
            }
            summary={validatorValue.enabled ? undefined : "off"}
            source={cascade.contextValidator.source}
            description="Reviews each context's diff against its acceptance criteria after each iteration."
            headerSwitch={{
              checked: validatorValue.enabled,
              onCheckedChange: (enabled) =>
                onSetOverride("contextValidator", {
                  ...deepClone(validatorValue),
                  enabled,
                }),
              ariaLabel: "Workflow context validator enabled",
            }}
            onOverride={() =>
              onSetOverride("contextValidator", deepClone(validatorValue))
            }
            onReset={() => onClearOverride("contextValidator")}
          >
            <ContextValidatorEditor
              value={validatorValue}
              onChange={(next) => onSetOverride("contextValidator", next)}
              readOnly={!isWorkflowOverride(cascade.contextValidator.source)}
            />
          </InspectorConfigBlock>

          <ScriptValidatorBlock
            scopeLabel="Workflow script validator"
            cascade={cascade.scriptValidator}
            onChange={(value) =>
              onSetOverride("scriptValidator", deepClone(value))
            }
            onReset={() => onClearOverride("scriptValidator")}
          />

          <HumanApprovalGateBlock
            scopeLabel="Workflow human approval gate"
            hint="After all validators pass, each context parks for your review before merge. Applies to every context without its own override."
            cascade={cascade.humanApprovalGate}
            onChange={(value) =>
              onSetOverride("humanApprovalGate", deepClone(value))
            }
            onReset={() => onClearOverride("humanApprovalGate")}
          />

          <AskUserQuestionsBlock
            scopeLabel="Workflow ask user questions"
            hint="Let this workflow's implementer and validator agents ask you questions at consequential decision points. Applies to every context without its own override."
            cascade={cascade.askUserQuestions}
            onChange={(value) =>
              onSetOverride("askUserQuestions", deepClone(value))
            }
            onReset={() => onClearOverride("askUserQuestions")}
          />
        </div>
      </section>

      <section data-section="execution-policy">
        <GroupHeader label="Execution policy" />
        <div className="flex flex-col gap-sm">
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
            label="Plan repair"
            summary={summarizePlanRepair(cascade.planRepair.value)}
            source={cascade.planRepair.source}
            onOverride={() =>
              onSetOverride("planRepair", deepClone(cascade.planRepair.value))
            }
            onReset={() => onClearOverride("planRepair")}
          >
            <PlanRepairEditor
              value={cascade.planRepair.value}
              onChange={(next) => onSetOverride("planRepair", next)}
              readOnly={!isWorkflowOverride(cascade.planRepair.source)}
            />
          </InspectorConfigBlock>

          <AgentTaskAddBlock
            ariaLabel="Allow agent task add"
            cascade={cascade.mutability}
            onChange={(value) => onSetOverride("mutability", deepClone(value))}
            onReset={() => onClearOverride("mutability")}
          />
        </div>
      </section>
    </div>
  );
}

type ContextBlock =
  | "implementer"
  | "contextValidator"
  | "scriptValidator"
  | "humanApprovalGate"
  | "askUserQuestions"
  | "iterationPolicy"
  | "circuitBreaker"
  | "mutability"
  | "planRepair"
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
  onPrimaryAction,
  voiceProjectName,
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
  onPrimaryAction: (force?: boolean) => void;
  voiceProjectName?: string | null;
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
  const [sheetField, setSheetField] = useState<
    "description" | "acceptanceCriteria" | null
  >(null);

  const criteriaCount = countCriteria(context.acceptanceCriteria);

  return (
    <div className="flex flex-col" data-scope="context">
      <section className="mb-xl" data-section="header">
        <GroupHeader label="Brief" />
        <div className="flex flex-col gap-md">
          <div>
            <label className={WB_FIELD_LABEL} htmlFor="context-title">
              Title <RequiredMark />
            </label>
            <input
              id="context-title"
              type="text"
              className={WB_TITLE_INPUT}
              value={context.title}
              onChange={(event) =>
                onUpdateContext({ title: event.target.value })
              }
            />
          </div>
          <div>
            <div className="mb-xs flex items-center justify-between">
              <span className={cn(WB_FIELD_LABEL, "mb-0")}>Description</span>
              <button
                type="button"
                className={WB_FIELD_ACTION}
                onClick={() => setSheetField("description")}
              >
                <EditGlyphIcon /> Edit
              </button>
            </div>
            <MarkdownReadView
              value={context.description ?? ""}
              placeholder="Add a description"
              ariaLabel="Edit description"
              onOpen={() => setSheetField("description")}
            />
          </div>
          <div>
            <div className="mb-xs flex items-center justify-between">
              <span className={cn(WB_FIELD_LABEL, "mb-0")}>
                Acceptance criteria <RequiredMark />
              </span>
              <button
                type="button"
                className={WB_FIELD_ACTION}
                onClick={() => setSheetField("acceptanceCriteria")}
              >
                <ExpandGlyphIcon /> Edit in focus view
              </button>
            </div>
            <MarkdownReadView
              value={context.acceptanceCriteria}
              placeholder="Add acceptance criteria"
              ariaLabel="Edit acceptance criteria"
              invalid={acError !== undefined}
              onOpen={() => setSheetField("acceptanceCriteria")}
            />
            <FieldError error={acError} />
            <div className="mt-xs flex justify-between gap-sm font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
              <span>
                Passed to the implementer — and the validator, when enabled.
              </span>
              {criteriaCount > 0 ? (
                <span className="whitespace-nowrap">
                  {criteriaCount} criteria
                </span>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="mb-xl" data-section="agents">
        <GroupHeader label="Agents" />
        <div className="flex flex-col gap-sm">
          <InspectorConfigBlock
            label="Implementer"
            chip={
              <BackendChip backend={cascade.implementer.value.backend}>
                {implementerChipLabel(cascade.implementer.value)}
              </BackendChip>
            }
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
            headerSwitch={{
              checked: cascade.collaboration.value.enabled,
              onCheckedChange: (enabled) =>
                onSetContextOverride("collaboration", {
                  ...deepClone(cascade.collaboration.value),
                  enabled,
                }),
              ariaLabel: "Context collaboration enabled",
            }}
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
        </div>
      </section>

      <section className="mb-xl" data-section="quality-gates">
        <GroupHeader label="Quality gates" />
        <div className="flex flex-col gap-sm">
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

          <AskUserQuestionsBlock
            scopeLabel="Context ask user questions"
            hint="Let this context's implementer and validator agents ask you questions at consequential decision points. The context parks until you answer."
            cascade={cascade.askUserQuestions}
            onChange={(value) =>
              onSetContextOverride("askUserQuestions", deepClone(value))
            }
            onReset={() => onClearContextOverride("askUserQuestions")}
          />
        </div>
      </section>

      <section className="mb-xl" data-section="execution-policy">
        <GroupHeader label="Execution policy" />
        <div className="flex flex-col gap-sm">
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
            label="Plan repair"
            summary={summarizePlanRepair(cascade.planRepair.value)}
            source={cascade.planRepair.source}
            onOverride={() =>
              onSetContextOverride(
                "planRepair",
                deepClone(cascade.planRepair.value),
              )
            }
            onReset={() => onClearContextOverride("planRepair")}
          >
            <PlanRepairEditor
              value={cascade.planRepair.value}
              onChange={(next) => onSetContextOverride("planRepair", next)}
              readOnly={cascade.planRepair.source !== "context-override"}
            />
          </InspectorConfigBlock>

          <AgentTaskAddBlock
            ariaLabel="Allow agent task add"
            cascade={cascade.mutability}
            onChange={(value) =>
              onSetContextOverride("mutability", deepClone(value))
            }
            onReset={() => onClearContextOverride("mutability")}
          />
        </div>
      </section>

      <InspectorFocusSheet
        open={sheetField !== null}
        onOpenChange={(open) => {
          if (!open) setSheetField(null);
        }}
        fieldLabel={
          sheetField === "acceptanceCriteria"
            ? "Acceptance criteria"
            : "Description"
        }
        contextTitle={context.title || "(untitled)"}
        value={
          sheetField === "acceptanceCriteria"
            ? context.acceptanceCriteria
            : (context.description ?? "")
        }
        onChange={(next) => {
          if (sheetField === "acceptanceCriteria") {
            onUpdateContext({ acceptanceCriteria: next });
          } else if (sheetField === "description") {
            onUpdateContext({ description: next });
          }
        }}
        textareaId={
          sheetField === "acceptanceCriteria"
            ? "context-acceptance-criteria"
            : "context-description"
        }
        onPrimaryAction={onPrimaryAction}
        voiceProjectName={voiceProjectName}
      />

      <section className="mb-xl" data-section="tasks">
        <GroupHeader label="Tasks" count={tasks.length} />
        <div>
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
                    "mb-[4px] rounded-md border border-solid bg-bg-base",
                    expanded ? "border-border-default" : "border-border-subtle",
                  )}
                  key={task.id}
                >
                  <div
                    className={cn(
                      "flex cursor-pointer items-center gap-[10px] rounded-md px-[14px] py-[10px] transition-[background] duration-150 hover:bg-bg-hover",
                      expanded && "rounded-b-none bg-bg-raised",
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
                    <span className="w-[16px] flex-shrink-0 text-center font-mono text-[0.7rem] font-semibold text-text-tertiary">
                      {task.order}
                    </span>
                    <span className="flex-1 overflow-hidden text-[0.8rem] text-ellipsis whitespace-nowrap text-text-primary">
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
                        <MultilineInput
                          className={cn(
                            WB_TASK_INPUT,
                            "mb-[2px] min-h-[56px] resize-y",
                            instrError && WB_FIELD_INVALID,
                          )}
                          id={`task-instructions-${task.id}`}
                          onValueChange={(instructions) =>
                            onUpdateTask(task.id, { instructions })
                          }
                          onPrimaryAction={(instructions) => {
                            onUpdateTask(task.id, { instructions });
                            onPrimaryAction(true);
                          }}
                          voiceProjectName={voiceProjectName}
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
            className="mt-[2px] w-full cursor-pointer rounded-md border border-dashed border-border-default bg-transparent p-[9px] font-[inherit] text-[0.72rem] text-text-tertiary transition-all duration-150 hover:border-cyan-dim hover:bg-[var(--cc-cyan-a04)] hover:text-cyan"
            onClick={onAddTask}
            type="button"
          >
            + Add Task
          </button>
        </div>
      </section>

      <section data-section="delete-context">
        <div className="border-t border-solid border-border-dim pt-md pb-xs">
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

const VALIDATOR_DESCRIPTION =
  "Reviews the diff against this context's acceptance criteria after each iteration.";

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
      chip={
        validator.enabled ? (
          <BackendChip
            backend={validator.type === "codex" ? "codex" : "claude"}
          >
            {validatorChipLabel(validator)}
          </BackendChip>
        ) : undefined
      }
      summary={validator.enabled ? undefined : "off"}
      source={cascade.source}
      description={VALIDATOR_DESCRIPTION}
      headerSwitch={{
        checked: validator.enabled,
        onCheckedChange: (enabled) =>
          onChange({ ...deepClone(validator), enabled }),
        ariaLabel: "Context validator enabled",
      }}
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

const GATE_CODE_CLASS =
  "rounded-[3px] bg-bg-raised px-[5px] py-[1px] font-mono text-[0.7rem] text-cyan";

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
      icon={
        <span className="inline-flex text-text-tertiary">
          <ScriptGlyphIcon />
        </span>
      }
      collapsible={false}
      source={cascade.source}
      description={
        <>
          Runs the project&apos;s{" "}
          <code className={GATE_CODE_CLASS}>preMergeCommand</code> before agent
          validation.
        </>
      }
      headerSwitch={{
        checked: cascade.value.enabled,
        onCheckedChange: (enabled) => onChange({ enabled }),
        ariaLabel: scopeLabel,
      }}
      onReset={cascade.source === "context-override" ? onReset : undefined}
    />
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
      icon={
        <span className="inline-flex text-amber">
          <ApprovalGlyphIcon />
        </span>
      }
      chip={
        enabled ? <GateChip tone="amber">Parks for review</GateChip> : undefined
      }
      collapsible={false}
      tone={enabled ? "amber" : "default"}
      source={cascade.source}
      description={hint}
      headerSwitch={{
        checked: enabled,
        onCheckedChange: (next) => onChange({ enabled: next }),
        ariaLabel: scopeLabel,
      }}
      onReset={cascade.source === "context-override" ? onReset : undefined}
    />
  );
}

function AskUserQuestionsBlock({
  scopeLabel,
  hint,
  cascade,
  onChange,
  onReset,
}: {
  scopeLabel: string;
  hint: string;
  cascade:
    | ResolvedContextCascade["askUserQuestions"]
    | WorkflowCascade["askUserQuestions"];
  onChange: (value: GraphWorkflowAskUserQuestionsConfig) => void;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <InspectorConfigBlock
      label="Ask user questions"
      icon={
        <span className="inline-flex text-amber">
          <QuestionGlyphIcon />
        </span>
      }
      collapsible={false}
      source={cascade.source}
      description={hint}
      headerSwitch={{
        checked: cascade.value.enabled,
        onCheckedChange: (enabled) => onChange({ enabled }),
        ariaLabel: scopeLabel,
      }}
      onReset={cascade.source === "context-override" ? onReset : undefined}
    />
  );
}

function AgentTaskAddBlock({
  ariaLabel,
  cascade,
  onChange,
  onReset,
}: {
  ariaLabel: string;
  cascade: ResolvedContextCascade["mutability"] | WorkflowCascade["mutability"];
  onChange: (value: GraphWorkflowMutabilityPolicy) => void;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <InspectorConfigBlock
      label="Agent task add"
      collapsible={false}
      source={cascade.source}
      description="Let agents add tasks during execution."
      headerSwitch={{
        checked: cascade.value.allowAgentTaskAdd,
        onCheckedChange: (allowAgentTaskAdd) => onChange({ allowAgentTaskAdd }),
        ariaLabel,
      }}
      onReset={cascade.source === "context-override" ? onReset : undefined}
    />
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
