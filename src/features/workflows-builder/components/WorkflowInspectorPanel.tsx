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
  addAcceptanceCriterion,
  addTaskToContext,
  clearContextBlockOverride,
  clearWorkflowConfigOverride,
  moveAcceptanceCriterion,
  moveTaskWithinContext,
  removeAcceptanceCriterion,
  removeTask,
  setContextBlockOverride,
  setContextOutputSchema,
  setWorkflowConfigOverride,
  updateAcceptanceCriterionStatement,
  updateExecutionContext,
  updateTask,
} from "@/lib/workflow-graph/builder-draft";
import {
  acceptanceCriteriaText,
  criterionRecordsOf,
  type CriterionRecord,
} from "@/lib/workflow-graph/criteria/criterion-records";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";
import { useValidationCommandOptions } from "@/lib/validation/queries";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { WorkflowCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  AgentAssignment,
  ValidatorCohort,
  GraphWorkflowAskUserQuestionsConfig,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowCommandSelector,
  GraphWorkflowHumanApprovalGateConfig,
  GraphWorkflowIterationPolicy,
  GraphWorkflowLaneMergeValidationConfig,
  GraphWorkflowLaneMergeValidationOverride,
  GraphWorkflowMutabilityPolicy,
  GraphWorkflowPlanRepairPolicy,
  GraphWorkflowScriptValidatorConfig,
} from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowConfigOverride,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  resolveContextCollaboration,
  resolveWorkflowCollaboration,
} from "./collaboration-cascade";
import {
  resolveContextAgentValidation,
  resolveWorkflowAgentValidation,
  resolveWorkflowLaneMergeValidation,
  type AgentValidationRoleSource,
  type ContextAgentValidationCascade,
  type ResolvedAgentValidationRole,
  type WorkflowAgentValidationCascade,
} from "./validation-cascade";
import InspectorConfigBlock, {
  type InspectorConfigBlockSource,
} from "./InspectorConfigBlock";
import ParameterDeclarationEditor from "./ParameterDeclarationEditor";
import { Checkbox } from "@/components/ui/Checkbox";
import { SectionLabel } from "@/components/ui/SectionHeader";
import { StatusChip } from "@/components/ui/StatusChip";
import type { ParameterDeclaration } from "@/lib/workflow-graph/definition-schemas";
import {
  sourceScopeContextIds,
  type CharterInvariant,
  type PersistedSourceOfTruth,
} from "@/lib/workflows/charter-schemas";
import {
  AgentValidationEditor,
  CircuitBreakerEditor,
  CollaborationEditor,
  CommandNameListEditor,
  ImplementerEditor,
  IterationPolicyEditor,
  LaneMergeValidationEditor,
  PlanRepairEditor,
  type AgentValidationRole,
} from "@/components/workflow-config/FieldEditors";
import { PlacementEditor } from "@/components/workflow-config/PlacementEditor";
import {
  CohortEditor,
  toggleCohortEnabled,
  type CohortCascadeProvenance,
} from "@/components/workflow-config/CohortEditor";
import InspectorFocusSheet from "./InspectorFocusSheet";
import {
  ApprovalGlyphIcon,
  BackendChip,
  EditGlyphIcon,
  GateChip,
  QuestionGlyphIcon,
  SchemaGlyphIcon,
  ScriptGlyphIcon,
  implementerChipLabel,
  validatorChipLabel,
} from "@/components/workflow-config/InspectorChips";
import {
  OutputSchemaField,
  lintOutputSchemaText,
} from "@/components/workflow-config/OutputSchemaField";
import { UpstreamInputsList } from "@/components/workflow-config/UpstreamInputsList";
import {
  resolveDefinitionUpstreamInputs,
  type GraphWorkflowUpstreamInput,
} from "@/lib/workflow-graph/context-outputs";

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
  /** Builder scope: the project whose registry feeds the command
   * multi-selects, or null for the global builder (union of all projects). */
  projectName?: string | null;
  /**
   * Scopes the agent-profile listing the assignment pickers offer: builtin +
   * global + this project's own profiles.
   */
  libraryProjectName?: string | null;
  /**
   * Reports whether the context tab holds output-schema text the draft
   * definition cannot represent. The panel gates its OWN Save on this, but the
   * toolbar drives the same `onSave` through a different button, so the verdict
   * has to reach the common save owner too — otherwise that button persists the
   * last valid schema while the author is still looking at red text.
   */
  onOutputSchemaBlockedChange?: (blocked: boolean) => void;
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

// Record-list view of a context's acceptance criteria (#69 change 4 stage 1),
// derived through the shared criteria helpers only. Emptiness is judged the
// way validation judges it (the rendered text is blank), so the builder's
// empty-prose seed ("" — nothing authored yet) yields no rows instead of one
// phantom record; anything authored normalizes through the canonical wrap
// (legacy prose → one `ac-1` record).
function draftCriterionRecords(
  criteria: string | readonly CriterionRecord[],
): CriterionRecord[] {
  if (!acceptanceCriteriaText(criteria).trim()) return [];
  return criterionRecordsOf(criteria);
}

/**
 * Toggle one declared context in a charter source's applicability scope (#69
 * change 3). Re-authoring the scope re-authors the SOURCE: legacy prose
 * `appliesTo` is replaced by the structured shape and the retired
 * `accessPolicy` field is dropped — the authored schema refuses both — while
 * every untouched source keeps its stored bytes (no read-renormalization).
 * An emptied scope removes `appliesTo` outright: absence IS global, and
 * `contextIds: []` would be refused at accept time.
 */
function toggleSourceScopeContext(
  definition: WorkflowSemanticDefinition,
  sourceId: string,
  contextId: string,
  included: boolean,
): WorkflowSemanticDefinition {
  const declaredIds = definition.executionContexts.map((context) => context.id);
  return {
    ...definition,
    charter: {
      ...definition.charter,
      sourcesOfTruth: definition.charter.sourcesOfTruth.map((source) => {
        if (source.id !== sourceId) return source;
        const selected = new Set(sourceScopeContextIds(source) ?? []);
        if (included) {
          selected.add(contextId);
        } else {
          selected.delete(contextId);
        }
        // Declaration order keeps the authored list deterministic regardless
        // of click order; ids no longer in the graph drop out with the edit.
        const contextIds = declaredIds.filter((id) => selected.has(id));
        const {
          appliesTo: _replaced,
          accessPolicy: _retired,
          ...authored
        } = source;
        return contextIds.length === 0
          ? authored
          : { ...authored, appliesTo: { contextIds } };
      }),
    },
  };
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
  const agent = policy.agent ? `${policy.agent.model} agent` : "default agent";
  return `on · ${policy.maxAttemptsPerContext}/context · ${agent}`;
}

function summarizeSelector(selector: GraphWorkflowCommandSelector): string {
  if (selector.mode === "all") {
    return selector.except.length === 0
      ? "all"
      : `all -${selector.except.length}`;
  }
  return selector.commands.length === 0
    ? "none"
    : `only ${selector.commands.length}`;
}

function summarizeLaneMergeValidation(
  config: GraphWorkflowLaneMergeValidationConfig,
): string {
  const commands =
    config.commands.mode === "project"
      ? "project default"
      : config.commands.commands.length === 0
        ? "disabled"
        : `${config.commands.commands.length} command${config.commands.commands.length === 1 ? "" : "s"}`;
  return `${config.strategy} · ${commands}`;
}

// Per-role provenance labels; "context-override" reads as Context to match the
// three cascade tiers an author reasons about (global / workflow / context).
const ROLE_SOURCE_LABEL: Record<AgentValidationRoleSource, string> = {
  global: "Global",
  workflow: "Workflow",
  "context-override": "Context",
};

type ResolvedContextCascade = {
  implementer: {
    value: AgentAssignment;
    source: InspectorConfigBlockSource;
  };
  // No `disabled` source: with a cohort, "off" is the value's own `enabled`
  // flag, not a tier. That is what lets a disabled cohort keep its assignments
  // and still report which tier supplied them.
  contextValidator: {
    value: ValidatorCohort;
    source: Exclude<InspectorConfigBlockSource, "disabled">;
  };
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
  agentValidation: ContextAgentValidationCascade;
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
  if (context.contextValidator !== undefined) {
    validator = {
      value: context.contextValidator,
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
    agentValidation: resolveContextAgentValidation(
      context.agentValidation,
      workflowConfig.agentValidation,
      globalDefaults.agentValidation,
    ),
  };
}

// Context-level deviations from the cascade (overrides + the disabled
// validator marker), shown as the resolved-setup strip's override count.
//
// `outputSchema` is deliberately absent and must stay absent: it is per-context
// identity with no workflow- or global-tier value to deviate FROM, so counting
// it would report an override against nothing.
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
    cascade.agentValidation.blockSource,
  ];
  return sources.filter(
    (source) => source === "context-override" || source === "disabled",
  ).length;
}

// At-a-glance summary of the selected context's effective configuration:
// implementer + enabled gates as compact chips, plus the override count.
// `hasOutputSchema` is passed separately rather than read off the cascade
// BECAUSE it is not a cascade field — see `contextOverrideCount`.
function ResolvedSetupStrip({
  cascade,
  hasOutputSchema,
}: {
  cascade: ResolvedContextCascade;
  hasOutputSchema: boolean;
}): React.JSX.Element {
  const implementer = cascade.implementer.value;
  const validator = cascade.contextValidator;
  const overrides = contextOverrideCount(cascade);

  return (
    <div
      className="flex flex-shrink-0 flex-wrap items-center gap-[6px] border-b border-solid border-border-dim bg-bg-base px-lg py-[10px]"
      data-section="resolved-setup"
    >
      <BackendChip backend={implementer.agent.backend}>
        {implementerChipLabel(implementer.agent)}
      </BackendChip>
      {validator.value.enabled
        ? validator.value.assignments.map((assignment) => (
            <BackendChip key={assignment.id} backend={assignment.agent.backend}>
              Validator · {validatorChipLabel(assignment)}
            </BackendChip>
          ))
        : null}
      {(cascade.scriptValidator.value.commands ?? []).length > 0 ? (
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
      {hasOutputSchema ? (
        <GateChip tone="neutral" icon={<SchemaGlyphIcon size={13} />}>
          Schema
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
    value: AgentAssignment;
    source: "global" | "context-override";
  };
  contextValidator: {
    value: ValidatorCohort;
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
  agentValidation: WorkflowAgentValidationCascade;
  laneMergeValidation: {
    value: GraphWorkflowLaneMergeValidationConfig;
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
    agentValidation: resolveWorkflowAgentValidation(
      workflowConfig.agentValidation,
      globalDefaults.agentValidation,
    ),
    laneMergeValidation: resolveWorkflowLaneMergeValidation(
      workflowConfig.laneMergeValidation,
      globalDefaults.laneMergeValidation,
    ),
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The cohort editor's provenance line for a resolved cascade entry.
 *
 * The block header already carries the source badge; this restates it INSIDE
 * the editor because a cohort is the one block whose body is a list the author
 * can reorder and extend — the affordances have to say, next to themselves,
 * which tier they are editing.
 */
function cohortCascadeProvenance(
  source: Exclude<InspectorConfigBlockSource, "disabled">,
  tierLabel: string,
  enabled: boolean,
): CohortCascadeProvenance {
  const origin =
    source === "global"
      ? "global defaults"
      : source === "workflow"
        ? "this workflow"
        : tierLabel;
  // "Disabled" is the cohort's own flag rather than a tier, which is exactly
  // what lets a switched-off cohort still report which tier its dormant
  // assignments came from.
  if (!enabled) return { state: "disabled", origin };
  return {
    state: source === "context-override" ? "use" : "inherit",
    origin,
  };
}

export default function WorkflowInspectorPanel({
  onSave,
  onDelete,
  saving,
  globalDefaults,
  activeTab: controlledActiveTab,
  onTabChange,
  voiceProjectName,
  projectName,
  libraryProjectName,
  onOutputSchemaBlockedChange,
}: WorkflowInspectorPanelProps): React.JSX.Element {
  const defaults = globalDefaults ?? SEEDED_WORKFLOW_DEFAULTS;
  const commandOptions = useValidationCommandOptions(projectName ?? null);
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
  // A half-typed or out-of-subset schema cannot be represented in the draft
  // definition, so the editor holds it as text and reports its verdict here.
  // The engine refuses such a definition outright, so Save is blocked on it.
  //
  // That same text is ALSO unsaved work the store's `dirty` flag structurally
  // cannot see — nothing committed it — so it drives the Save/Saved label too.
  const [schemaTextValid, setSchemaTextValid] = useState(true);
  const handleSchemaTextValidChange = useCallback(
    (valid: boolean) => {
      setSchemaTextValid(valid);
      onOutputSchemaBlockedChange?.(!valid);
    },
    [onOutputSchemaBlockedChange],
  );
  const multilineActions = useMultilinePrimaryActionRegistry();
  const activeTab = controlledActiveTab ?? internalActiveTab;
  // Unsaved work is the store's dirtiness OR text no commit could accept.
  const draftDirty = dirty || !schemaTextValid;
  const handleSave = useCallback(
    (force = false) => {
      if ((!dirty && !force) || saving || !schemaTextValid) return;
      void onSave();
    },
    [dirty, onSave, saving, schemaTextValid],
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
                draftDirty ? WB_BTN_PRIMARY : WB_BTN_DEFAULT,
              )}
              disabled={
                saving ||
                !schemaTextValid ||
                (!dirty && !multilineActions.voiceBusy)
              }
              onClick={() => multilineActions.primaryAction(handleSave)}
              title={
                !schemaTextValid
                  ? "The output schema is not accepted by the engine"
                  : validationErrors.length > 0
                    ? `${validationErrors.length} validation issue${validationErrors.length === 1 ? "" : "s"} present`
                    : undefined
              }
              type="button"
            >
              {saving ? "Saving..." : draftDirty ? "Save" : "Saved"}
            </button>
          </header>

          {stripCascade ? (
            <ResolvedSetupStrip
              cascade={stripCascade}
              hasOutputSchema={selectedContext?.outputSchema !== undefined}
            />
          ) : null}

          <div className="wb-inspector-body flex-1 overflow-y-auto p-lg">
            <TabsContent value="workflow">
              <WorkflowTabBody
                workflowConfig={workflowConfig}
                globalDefaults={defaults}
                parameters={draftDefinition.parameters}
                charterInvariants={draftDefinition.charter.invariants ?? []}
                charterSources={draftDefinition.charter.sourcesOfTruth}
                declaredContextIds={draftDefinition.executionContexts.map(
                  (context) => context.id,
                )}
                onToggleSourceScope={(sourceId, contextId, included) => {
                  updateDefinition(
                    toggleSourceScopeContext(
                      draftDefinition,
                      sourceId,
                      contextId,
                      included,
                    ),
                  );
                }}
                parameterSaveError={parameterSaveError(validationErrors)}
                onParametersChange={(next) => {
                  updateDefinition({ ...draftDefinition, parameters: next });
                }}
                onPrimaryAction={handleSave}
                voiceProjectName={voiceProjectName}
                commandOptions={commandOptions}
                libraryProjectName={libraryProjectName}
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
                  // Reseed every per-context editor draft (the focus sheet's
                  // field, the schema editor's raw text) when the selection
                  // moves — one context's half-typed schema must never appear
                  // under another's title.
                  key={selectedContext.id}
                  context={selectedContext}
                  tasks={selectedContextTasks}
                  upstreamInputs={resolveDefinitionUpstreamInputs(
                    draftDefinition,
                    selectedContext.id,
                  )}
                  validationErrors={validationErrors}
                  workflowConfig={workflowConfig}
                  globalDefaults={defaults}
                  selectedTaskId={selectedTaskId}
                  onSchemaTextValidChange={handleSchemaTextValidChange}
                  onSetOutputSchema={(schema) => {
                    updateDefinition(
                      setContextOutputSchema(
                        draftDefinition,
                        selectedContext.id,
                        schema,
                      ),
                    );
                  }}
                  onUpdateContext={(updates) => {
                    updateDefinition(
                      updateExecutionContext(
                        draftDefinition,
                        selectedContext.id,
                        updates,
                      ),
                    );
                  }}
                  onAddCriterion={() => {
                    updateDefinition(
                      addAcceptanceCriterion(
                        draftDefinition,
                        selectedContext.id,
                      ).definition,
                    );
                  }}
                  onUpdateCriterionStatement={(criterionId, statement) => {
                    updateDefinition(
                      updateAcceptanceCriterionStatement(
                        draftDefinition,
                        selectedContext.id,
                        criterionId,
                        statement,
                      ),
                    );
                  }}
                  onRemoveCriterion={(criterionId) => {
                    updateDefinition(
                      removeAcceptanceCriterion(
                        draftDefinition,
                        selectedContext.id,
                        criterionId,
                      ),
                    );
                  }}
                  onMoveCriterion={(criterionId, direction) => {
                    updateDefinition(
                      moveAcceptanceCriterion(
                        draftDefinition,
                        selectedContext.id,
                        criterionId,
                        direction,
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
                  commandOptions={commandOptions}
                  libraryProjectName={libraryProjectName}
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
  charterInvariants,
  charterSources,
  declaredContextIds,
  onToggleSourceScope,
  parameterSaveError,
  onParametersChange,
  onPrimaryAction,
  voiceProjectName,
  commandOptions,
  libraryProjectName,
  onSetOverride,
  onClearOverride,
}: {
  workflowConfig: WorkflowConfigOverride;
  globalDefaults: WorkflowDefaults;
  parameters: ParameterDeclaration[];
  charterInvariants: CharterInvariant[];
  charterSources: PersistedSourceOfTruth[];
  declaredContextIds: string[];
  onToggleSourceScope: (
    sourceId: string,
    contextId: string,
    included: boolean,
  ) => void;
  parameterSaveError: string | null;
  onParametersChange: (next: ParameterDeclaration[]) => void;
  onPrimaryAction: (force?: boolean) => void;
  voiceProjectName?: string | null;
  commandOptions?: readonly ValidationCommandSummary[];
  libraryProjectName?: string | null;
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
      {charterInvariants.length > 0 ? (
        <section className="mb-xl" data-section="charter-invariants">
          <GroupHeader
            label="Charter invariants"
            count={charterInvariants.length}
          />
          <div className="flex flex-col gap-sm">
            {charterInvariants.map((invariant) => (
              <div
                className="rounded-sm border border-solid border-border-dim bg-bg-base px-md py-sm"
                key={invariant.id}
              >
                <div className="font-mono text-[0.72rem] text-text-primary">
                  {invariant.id}
                </div>
                <div className="mt-[3px] text-[0.76rem] leading-[1.45] text-text-secondary">
                  {invariant.statement}
                </div>
                <div className="mt-[6px] font-mono text-[0.68rem] text-text-tertiary">
                  {invariant.appliesTo
                    ? `Context scope: ${invariant.appliesTo.contextIds.join(", ")}`
                    : "Global"}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {charterSources.length > 0 ? (
        <section className="mb-xl" data-section="charter-sources">
          <GroupHeader label="Charter sources" count={charterSources.length} />
          <div className="flex flex-col gap-sm">
            {charterSources.map((source) => {
              const scopeIds = sourceScopeContextIds(source);
              return (
                <div
                  className="rounded-sm border border-solid border-border-dim bg-bg-base px-md py-sm"
                  data-testid="charter-source-row"
                  key={source.id}
                >
                  <div className="flex items-baseline gap-sm">
                    <span className="font-mono text-[0.72rem] text-text-primary">
                      {source.id}
                    </span>
                    <span className="font-mono text-[0.68rem] text-text-tertiary">
                      rank {source.rank} · {source.type}
                    </span>
                  </div>
                  <div className="mt-[3px] text-[0.76rem] leading-[1.45] text-text-secondary">
                    {source.label}
                  </div>
                  <div className="mt-[2px] font-mono text-[0.68rem] break-all text-text-tertiary">
                    {source.locator}
                  </div>
                  {/* Legacy prose appliesTo carries no ids the engine can
                      filter on — the shared helper reads it as global, the
                      exact pre-structured rendering behavior. */}
                  <div
                    className="mt-[6px] flex flex-wrap items-center gap-[4px]"
                    data-testid="source-scope"
                  >
                    {scopeIds === null ? (
                      <StatusChip tone="neutral">Global</StatusChip>
                    ) : (
                      scopeIds.map((contextId) => (
                        <StatusChip key={contextId} tone="cyan">
                          {contextId}
                        </StatusChip>
                      ))
                    )}
                  </div>
                  {declaredContextIds.length > 0 ? (
                    <div className="mt-[8px] flex flex-wrap gap-md">
                      {declaredContextIds.map((contextId) => (
                        <label
                          className="flex cursor-pointer items-center gap-xs text-[0.72rem] text-text-secondary"
                          key={contextId}
                        >
                          <Checkbox
                            aria-label={`Scope ${source.id} to ${contextId}`}
                            checked={scopeIds?.includes(contextId) ?? false}
                            onCheckedChange={(checked) =>
                              onToggleSourceScope(
                                source.id,
                                contextId,
                                checked === true,
                              )
                            }
                          />
                          {contextId}
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="mt-xs font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
            Each context&apos;s prompt renders only the sources scoped to it;
            an unscoped source is global.
          </div>
        </section>
      ) : null}

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
              <BackendChip backend={cascade.implementer.value.agent.backend}>
                {implementerChipLabel(cascade.implementer.value.agent)}
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
              libraryProjectName={libraryProjectName}
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
                <CohortChips cohort={validatorValue} />
              ) : undefined
            }
            summary={validatorValue.enabled ? undefined : "off"}
            source={cascade.contextValidator.source}
            description="Reviews each context's diff against its acceptance criteria after each iteration."
            headerSwitch={{
              checked: validatorValue.enabled,
              onCheckedChange: (enabled) =>
                onSetOverride(
                  "contextValidator",
                  toggleCohortEnabled(validatorValue, enabled),
                ),
              ariaLabel: "Workflow context validator enabled",
            }}
            onOverride={() =>
              onSetOverride("contextValidator", deepClone(validatorValue))
            }
            onReset={() => onClearOverride("contextValidator")}
          >
            <CohortEditor
              value={validatorValue}
              onChange={(next) => onSetOverride("contextValidator", next)}
              cascade={cohortCascadeProvenance(
                cascade.contextValidator.source,
                "this workflow",
                validatorValue.enabled,
              )}
              libraryProjectName={libraryProjectName}
              readOnly={!isWorkflowOverride(cascade.contextValidator.source)}
            />
          </InspectorConfigBlock>

          <ScriptValidatorBlock
            cascade={cascade.scriptValidator}
            options={commandOptions}
            onChange={(value) =>
              onSetOverride("scriptValidator", deepClone(value))
            }
            onReset={() => onClearOverride("scriptValidator")}
          />

          <AgentValidationBlock
            implementer={cascade.agentValidation.implementer}
            contextValidator={cascade.agentValidation.contextValidator}
            blockSource={cascade.agentValidation.blockSource}
            options={commandOptions}
            onChangeRole={(role, selector) =>
              onSetOverride("agentValidation", {
                ...(workflowConfig.agentValidation ?? {}),
                [role]: selector,
              })
            }
            onReset={() => onClearOverride("agentValidation")}
          />

          <LaneMergeValidationBlock
            cascade={cascade.laneMergeValidation}
            currentOverride={workflowConfig.laneMergeValidation}
            options={commandOptions}
            onSetOverride={(value) =>
              onSetOverride("laneMergeValidation", value)
            }
            onReset={() => onClearOverride("laneMergeValidation")}
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
  | "collaboration"
  | "agentValidation";

function serializeOutputSchema(
  schema: Record<string, unknown> | undefined,
): string {
  return schema === undefined ? "" : JSON.stringify(schema, null, 2);
}

/**
 * Holds the schema editor's RAW TEXT for the builder tier.
 *
 * The draft definition can only carry a parsed document, so a half-typed or
 * out-of-subset schema has nowhere to live there — it stays here, and the panel
 * blocks Save on it rather than letting the author push a definition the engine
 * would refuse. Only a fully-enforceable document (or a clear) reaches the
 * draft.
 */
function BuilderOutputSchemaField({
  outputSchema,
  onSetOutputSchema,
  onValidChange,
}: {
  outputSchema: Record<string, unknown> | undefined;
  onSetOutputSchema: (schema: Record<string, unknown> | null) => void;
  onValidChange: (valid: boolean) => void;
}): React.JSX.Element {
  const persisted = serializeOutputSchema(outputSchema);
  const [text, setText] = useState(persisted);
  // The serialization this editor last produced. The reseed compares the
  // incoming `persisted` against THIS rather than against `text`, so an
  // external change (a draft reload, an undo) reseeds the editor while the
  // editor's own commit — which re-stringifies canonically — never reformats
  // the author's text mid-keystroke.
  const [committed, setCommitted] = useState(persisted);
  if (persisted !== committed) {
    setCommitted(persisted);
    setText(persisted);
  }

  const valid = lintOutputSchemaText(text).issues.length === 0;
  useEffect(() => {
    onValidChange(valid);
    // The Save gate lives on the panel; a context tab that unmounts (tab flip
    // or selection change) discards its unparseable text, so it must not leave
    // the gate stuck on a verdict about text nobody can see any more.
    return () => onValidChange(true);
  }, [valid, onValidChange]);

  return (
    <OutputSchemaField
      value={text}
      onChange={(next) => {
        setText(next);
        const lint = lintOutputSchemaText(next);
        if (lint.schema !== null) {
          setCommitted(serializeOutputSchema(lint.schema));
          onSetOutputSchema(lint.schema);
        } else if (lint.stage === "empty") {
          setCommitted("");
          onSetOutputSchema(null);
        }
      }}
    />
  );
}

function ContextTabBody({
  context,
  tasks,
  upstreamInputs,
  validationErrors,
  workflowConfig,
  globalDefaults,
  selectedTaskId,
  onUpdateContext,
  onAddCriterion,
  onUpdateCriterionStatement,
  onRemoveCriterion,
  onMoveCriterion,
  onSetOutputSchema,
  onSchemaTextValidChange,
  onSetContextOverride,
  onClearContextOverride,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onMoveTask,
  onSelectTask,
  onDelete,
  onPrimaryAction,
  voiceProjectName,
  commandOptions,
  libraryProjectName,
}: {
  context: GraphWorkflowExecutionContextDefinition;
  tasks: GraphWorkflowTaskDefinition[];
  /** Resolver-provided; the panel never walks the edge list itself. */
  upstreamInputs: GraphWorkflowUpstreamInput[];
  validationErrors: WorkflowGraphValidationError[];
  workflowConfig: WorkflowConfigOverride;
  globalDefaults: WorkflowDefaults;
  selectedTaskId: string | null;
  onUpdateContext: (
    updates: Partial<GraphWorkflowExecutionContextDefinition>,
  ) => void;
  onAddCriterion: () => void;
  onUpdateCriterionStatement: (criterionId: string, statement: string) => void;
  onRemoveCriterion: (criterionId: string) => void;
  onMoveCriterion: (criterionId: string, direction: "up" | "down") => void;
  /** `null` deletes the declaration; a document replaces it wholesale. */
  onSetOutputSchema: (schema: Record<string, unknown> | null) => void;
  onSchemaTextValidChange: (valid: boolean) => void;
  onSetContextOverride: <K extends ContextBlock>(
    block: K,
    value: NonNullable<GraphWorkflowExecutionContextDefinition[K]>,
  ) => void;
  onClearContextOverride: (block: ContextBlock) => void;
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
  commandOptions?: readonly ValidationCommandSummary[];
  libraryProjectName?: string | null;
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
  // The focus sheet now hosts only the description — criteria are structured
  // records with their own list editor, not long-form Markdown.
  const [descriptionSheetOpen, setDescriptionSheetOpen] = useState(false);

  const criterionRecords = draftCriterionRecords(context.acceptanceCriteria);

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
                onClick={() => setDescriptionSheetOpen(true)}
              >
                <EditGlyphIcon /> Edit
              </button>
            </div>
            <MarkdownReadView
              value={context.description ?? ""}
              placeholder="Add a description"
              ariaLabel="Edit description"
              onOpen={() => setDescriptionSheetOpen(true)}
            />
          </div>
          <div>
            <div className="mb-xs flex items-center justify-between">
              <span className={cn(WB_FIELD_LABEL, "mb-0")}>
                Acceptance criteria <RequiredMark />
              </span>
            </div>
            <AcceptanceCriteriaRecordsEditor
              records={criterionRecords}
              invalid={acError !== undefined}
              onAdd={onAddCriterion}
              onUpdateStatement={onUpdateCriterionStatement}
              onRemove={onRemoveCriterion}
              onMove={onMoveCriterion}
              onPrimaryAction={onPrimaryAction}
              voiceProjectName={voiceProjectName}
            />
            <FieldError error={acError} />
            <div className="mt-xs flex justify-between gap-sm font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
              <span>
                Passed to the implementer — and the validator, when enabled.
                Validator verdicts cite criterion ids.
              </span>
              {criterionRecords.length > 0 ? (
                <span className="whitespace-nowrap">
                  {criterionRecords.length}{" "}
                  {criterionRecords.length === 1 ? "criterion" : "criteria"}
                </span>
              ) : null}
            </div>
          </div>
          <BuilderOutputSchemaField
            outputSchema={context.outputSchema}
            onSetOutputSchema={onSetOutputSchema}
            onValidChange={onSchemaTextValidChange}
          />
          <UpstreamInputsList inputs={upstreamInputs} />
        </div>
      </section>

      <section className="mb-xl" data-section="placement">
        <GroupHeader label="Placement" />
        <PlacementEditor
          value={context.placement}
          onChange={(placement) => onUpdateContext({ placement })}
        />
        {/* Matched by code prefix rather than by name: the accept-time gate
            reports six distinct placement refusals (lane grammar, reserved
            names, the read-only output contract, ownership overlap), and this
            block is where every one of them belongs. */}
        <FieldError
          error={validationErrors.find(
            (error) =>
              error.contextId === context.id &&
              error.code.startsWith("placement-"),
          )}
        />
      </section>

      <section className="mb-xl" data-section="agents">
        <GroupHeader label="Agents" />
        <div className="flex flex-col gap-sm">
          <InspectorConfigBlock
            label="Implementer"
            chip={
              <BackendChip backend={cascade.implementer.value.agent.backend}>
                {implementerChipLabel(cascade.implementer.value.agent)}
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
              libraryProjectName={libraryProjectName}
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
            libraryProjectName={libraryProjectName}
            onOverride={(value) =>
              onSetContextOverride("contextValidator", deepClone(value))
            }
            onChange={(value) =>
              onSetContextOverride("contextValidator", value)
            }
            onReset={() => onClearContextOverride("contextValidator")}
          />

          <ScriptValidatorBlock
            cascade={cascade.scriptValidator}
            options={commandOptions}
            onChange={(value) =>
              onSetContextOverride("scriptValidator", deepClone(value))
            }
            onReset={() => onClearContextOverride("scriptValidator")}
          />

          <AgentValidationBlock
            implementer={cascade.agentValidation.implementer}
            contextValidator={cascade.agentValidation.contextValidator}
            blockSource={cascade.agentValidation.blockSource}
            options={commandOptions}
            onChangeRole={(role, selector) =>
              onSetContextOverride("agentValidation", {
                ...(context.agentValidation ?? {}),
                [role]: selector,
              })
            }
            onReset={() => onClearContextOverride("agentValidation")}
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
        open={descriptionSheetOpen}
        onOpenChange={(open) => {
          if (!open) setDescriptionSheetOpen(false);
        }}
        fieldLabel="Description"
        contextTitle={context.title || "(untitled)"}
        value={context.description ?? ""}
        onChange={(next) => onUpdateContext({ description: next })}
        textareaId="context-description"
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

/**
 * Ordered record-list editor for a context's acceptance criteria (#69 change 4
 * stage 1). Ids are generated by the draft mutators and rendered read-only —
 * the author edits statements and order, never identity — so verdict citations
 * stay stable across statement edits.
 */
function AcceptanceCriteriaRecordsEditor({
  records,
  invalid,
  onAdd,
  onUpdateStatement,
  onRemove,
  onMove,
  onPrimaryAction,
  voiceProjectName,
}: {
  records: CriterionRecord[];
  invalid: boolean;
  onAdd: () => void;
  onUpdateStatement: (criterionId: string, statement: string) => void;
  onRemove: (criterionId: string) => void;
  onMove: (criterionId: string, direction: "up" | "down") => void;
  onPrimaryAction: (force?: boolean) => void;
  voiceProjectName?: string | null;
}): React.JSX.Element {
  return (
    <div data-testid="acceptance-criteria-editor">
      {records.map((record, index) => (
        <div
          className={cn(
            "mb-[4px] rounded-md border border-solid bg-bg-base px-[10px] py-[8px]",
            invalid ? "border-red" : "border-border-subtle",
          )}
          data-testid="criterion-row"
          data-criterion-id={record.id}
          key={record.id}
        >
          <div className="mb-[6px] flex items-center gap-[8px]">
            <span className="font-mono text-[0.7rem] font-semibold text-text-tertiary">
              {index + 1}.
            </span>
            <span className="font-mono text-[0.72rem] text-text-secondary">
              {record.id}
            </span>
            <div className="ml-auto flex items-center gap-[4px]">
              <button
                aria-label={`Move ${record.id} up`}
                className={cn(WB_BTN_BASE, WB_BTN_XS, WB_BTN_DEFAULT)}
                disabled={index === 0}
                onClick={() => onMove(record.id, "up")}
                type="button"
              >
                ↑
              </button>
              <button
                aria-label={`Move ${record.id} down`}
                className={cn(WB_BTN_BASE, WB_BTN_XS, WB_BTN_DEFAULT)}
                disabled={index === records.length - 1}
                onClick={() => onMove(record.id, "down")}
                type="button"
              >
                ↓
              </button>
              <button
                aria-label={`Remove ${record.id}`}
                className={cn(WB_BTN_BASE, WB_BTN_XS, WB_BTN_DANGER)}
                onClick={() => onRemove(record.id)}
                type="button"
              >
                ✕
              </button>
            </div>
          </div>
          <MultilineInput
            aria-label={`Statement for ${record.id}`}
            className={cn(WB_TASK_INPUT, "min-h-[40px] resize-y")}
            onValueChange={(statement) =>
              onUpdateStatement(record.id, statement)
            }
            onPrimaryAction={(statement) => {
              onUpdateStatement(record.id, statement);
              onPrimaryAction(true);
            }}
            voiceProjectName={voiceProjectName}
            value={record.statement}
          />
        </div>
      ))}
      <button
        className="mt-[2px] w-full cursor-pointer rounded-md border border-dashed border-border-default bg-transparent p-[9px] font-[inherit] text-[0.72rem] text-text-tertiary transition-all duration-150 hover:border-cyan-dim hover:bg-[var(--cc-cyan-a04)] hover:text-cyan"
        onClick={onAdd}
        type="button"
      >
        + Add criterion
      </button>
    </div>
  );
}

const VALIDATOR_DESCRIPTION =
  "Reviews the diff against this context's acceptance criteria after each iteration.";

function ContextValidatorBlock({
  cascade,
  libraryProjectName,
  onOverride,
  onChange,
  onReset,
}: {
  cascade: ResolvedContextCascade["contextValidator"];
  libraryProjectName?: string | null;
  onOverride: (value: ValidatorCohort) => void;
  onChange: (value: ValidatorCohort) => void;
  onReset: () => void;
}): React.JSX.Element {
  const cohort = cascade.value;

  return (
    <InspectorConfigBlock
      label="Context validator"
      chip={cohort.enabled ? <CohortChips cohort={cohort} /> : undefined}
      summary={cohort.enabled ? undefined : "off"}
      source={cascade.source}
      description={VALIDATOR_DESCRIPTION}
      headerSwitch={{
        checked: cohort.enabled,
        onCheckedChange: (enabled) =>
          onChange(toggleCohortEnabled(cohort, enabled)),
        ariaLabel: "Context validator enabled",
      }}
      onOverride={() => onOverride(cohort)}
      onReset={cascade.source === "context-override" ? onReset : undefined}
    >
      <CohortEditor
        value={cohort}
        onChange={onChange}
        cascade={cohortCascadeProvenance(
          cascade.source,
          "this context",
          cohort.enabled,
        )}
        libraryProjectName={libraryProjectName}
        readOnly={cascade.source !== "context-override"}
      />
    </InspectorConfigBlock>
  );
}

/** One identity chip per cohort assignment, in configured order. */
function CohortChips({
  cohort,
}: {
  cohort: ValidatorCohort;
}): React.JSX.Element {
  return (
    <>
      {cohort.assignments.map((assignment) => (
        <BackendChip key={assignment.id} backend={assignment.agent.backend}>
          {validatorChipLabel(assignment)}
        </BackendChip>
      ))}
    </>
  );
}

function ScriptValidatorBlock({
  cascade,
  options,
  onChange,
  onReset,
}: {
  cascade:
    | ResolvedContextCascade["scriptValidator"]
    | WorkflowCascade["scriptValidator"];
  options?: readonly ValidationCommandSummary[];
  onChange: (value: GraphWorkflowScriptValidatorConfig) => void;
  onReset: () => void;
}): React.JSX.Element {
  const value = cascade.value;
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
      allowInheritedEditing
      description={
        <>
          Runs the selected validation commands before agent validation. An
          empty selection disables the gate.
        </>
      }
      onReset={cascade.source === "context-override" ? onReset : undefined}
    >
      <div className="flex flex-col gap-xs">
        <span className={cn(WB_FIELD_LABEL, "mb-0")}>Commands</span>
        <CommandNameListEditor
          value={value.commands ?? []}
          addLabel="Add script validator command"
          options={options}
          // The key survives an emptied list: `commands: []` is explicitly-off
          // and must round-trip, never collapse to legacy-on.
          onChange={(commands) => onChange({ ...deepClone(value), commands })}
        />
      </div>
    </InspectorConfigBlock>
  );
}

function AgentValidationBlock({
  implementer,
  contextValidator,
  blockSource,
  options,
  onChangeRole,
  onReset,
}: {
  implementer:
    | ResolvedAgentValidationRole
    | WorkflowAgentValidationCascade["implementer"];
  contextValidator:
    | ResolvedAgentValidationRole
    | WorkflowAgentValidationCascade["contextValidator"];
  blockSource: InspectorConfigBlockSource;
  options?: readonly ValidationCommandSummary[];
  onChangeRole: (
    role: AgentValidationRole,
    selector: GraphWorkflowCommandSelector,
  ) => void;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <InspectorConfigBlock
      label="Agent validation"
      summary={`impl ${summarizeSelector(implementer.value)} · validator ${summarizeSelector(contextValidator.value)}`}
      source={blockSource}
      allowInheritedEditing
      description="Validation-registry commands each agent role may run — independent of the script gate's selection. Editing a role overrides only that role; the other keeps inheriting."
      onReset={blockSource === "context-override" ? onReset : undefined}
    >
      <AgentValidationEditor
        value={{
          implementer: implementer.value,
          contextValidator: contextValidator.value,
        }}
        onChangeRole={onChangeRole}
        options={options}
        roleSourceLabels={{
          implementer: ROLE_SOURCE_LABEL[implementer.source],
          contextValidator: ROLE_SOURCE_LABEL[contextValidator.source],
        }}
      />
    </InspectorConfigBlock>
  );
}

// Workflow tier ONLY: the lane-merge gate guards the shared fan-in target, so
// it has no per-context counterpart (validation-concurrency §6).
function LaneMergeValidationBlock({
  cascade,
  currentOverride,
  options,
  onSetOverride,
  onReset,
}: {
  cascade: WorkflowCascade["laneMergeValidation"];
  currentOverride: GraphWorkflowLaneMergeValidationOverride | undefined;
  options?: readonly ValidationCommandSummary[];
  onSetOverride: (value: GraphWorkflowLaneMergeValidationOverride) => void;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <InspectorConfigBlock
      label="Lane-merge validation"
      summary={summarizeLaneMergeValidation(cascade.value)}
      source={cascade.source}
      allowInheritedEditing
      description="Validates parallel-lane merges at the shared fan-in. Workflow scope only — execution contexts cannot override it."
      onReset={cascade.source === "context-override" ? onReset : undefined}
    >
      <LaneMergeValidationEditor
        value={cascade.value}
        options={options}
        onChangeStrategy={(strategy) =>
          onSetOverride({ ...(currentOverride ?? {}), strategy })
        }
        onChangeCommands={(commands) =>
          onSetOverride({ ...(currentOverride ?? {}), commands })
        }
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
        onCheckedChange: (allowAgentTaskAdd) =>
          onChange({ ...cascade.value, allowAgentTaskAdd }),
        ariaLabel,
      }}
      onReset={cascade.source === "context-override" ? onReset : undefined}
    />
  );
}
