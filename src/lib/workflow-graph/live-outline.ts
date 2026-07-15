import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
} from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowContextStatus,
  GraphWorkflowResolvedContext,
  GraphWorkflowStatus,
  GraphWorkflowTaskStatus,
} from "@/lib/workflow-graph/definition-schemas";
import {
  classifyContextLifecycle,
  classifyExecutionEditability,
  type ContextLifecycle,
  type ExecutionEditability,
} from "./lifecycle-classifier";

/**
 * The server-side live-outline projection (doc 06, "Read API — live outline").
 * Deliberately server-side (D10): editability is derived from the SAME lifecycle
 * classifier the edit guard uses, so the CLI, the UI, and the guard cannot drift.
 * The projection folds `workingDefinition` (resolved config) + `contextStates` /
 * `taskStates` + the classifier verdicts into a compact JSON the CLI renders as
 * text. Prose is SIZED, never inlined, in the default outline; the section
 * selectors (`context` / `task` / `config` / `full`) return the full prose the
 * caller asked for — the same token discipline as doc 05.
 *
 * Pure and table-testable: no I/O, no state-store access.
 */

/** The three editability tiers a context row can carry (doc 06 outline column). */
export type LiveOutlineEditability = "frozen" | "editable" | "pause-to-edit";

export interface LiveOutlineHeader {
  executionId: string;
  liveRevision: number;
  status: GraphWorkflowStatus;
  seedDefinitionId: string;
  seedDefinitionRevision: number;
  /**
   * Whether the execution accepts live edits at all. A terminal/non-resumable
   * execution surfaces its read-only-ness HERE (doc 06: "not-editable … shown in
   * the header line instead"), so the per-context `editability` tier stays one of
   * the three lifecycle-derived values and the header is the authoritative gate.
   */
  editable: boolean;
  notEditableReason?: "completed" | "aborted" | "halt-not-resumable";
}

export interface LiveOutlineAgentSummary {
  backend: GraphWorkflowAgentConfig["backend"];
  model: string;
  reasoningEffort: string;
}

export interface LiveOutlineValidatorSummary {
  type: GraphWorkflowAgentValidatorConfig["type"];
  model: string | null;
  reasoningEffort: string | null;
}

export interface LiveOutlineCollaborationSummary {
  secondAgent: LiveOutlineAgentSummary;
  negotiationRounds: number;
  autonomousResolutionThreshold: string;
}

export interface LiveOutlineContextConfig {
  contextId: string;
  implementer: LiveOutlineAgentSummary;
  /** `null` when the context validator is disabled ("validator off"). */
  validator: LiveOutlineValidatorSummary | null;
  scriptValidator: boolean;
  humanApprovalGate: boolean;
  askUserQuestions: boolean;
  /** `null` when no resolved collaboration snapshot exists (legacy executions). */
  collaboration: LiveOutlineCollaborationSummary | null;
}

/**
 * A context's FULL resolved config — the concrete runtime values a `live edit`
 * addresses (doc 06: selector responses return full config, not the compact
 * outline summary). Every block is the exact resolved shape from
 * `workingDefinition`, so the inspector/agent can inspect and edit concrete
 * values (implementer, validator, script/approval/questions gates, iteration
 * policy, circuit breaker, mutability, collaboration). Kept in lockstep with
 * `graphWorkflowResolvedContextSchema` via `Pick` so a new resolved-config field
 * surfaces here without drift.
 */
export type LiveOutlineResolvedConfig = Pick<
  GraphWorkflowResolvedContext,
  | "implementer"
  | "contextValidator"
  | "scriptValidator"
  | "humanApprovalGate"
  | "askUserQuestions"
  | "iterationPolicy"
  | "circuitBreaker"
  | "mutability"
> & {
  contextId: string;
  /** `null` when no resolved collaboration snapshot exists (legacy executions). */
  collaboration: ResolvedCollaborationConfig | null;
};

export interface LiveOutlineContext {
  id: string;
  title: string;
  status: GraphWorkflowContextStatus;
  editability: LiveOutlineEditability;
  /** Upstream context ids (edges whose target is this context), in edge order. */
  deps: string[];
  completedTaskCount: number;
  totalTaskCount: number;
  iterationCount: number;
  maxIterations: number;
}

export interface LiveOutlineTask {
  contextId: string;
  order: number;
  id: string;
  status: GraphWorkflowTaskStatus;
  title: string;
  instructionChars: number;
}

export interface LiveOutlineTaskFull {
  contextId: string;
  order: number;
  id: string;
  status: GraphWorkflowTaskStatus;
  title: string;
  instructions: string;
  metadata?: Record<string, string>;
}

export interface LiveOutlineContextSection {
  id: string;
  title: string;
  description: string | null;
  acceptanceCriteria: string;
  status: GraphWorkflowContextStatus;
  editability: LiveOutlineEditability;
  deps: string[];
  completedTaskCount: number;
  totalTaskCount: number;
  iterationCount: number;
  maxIterations: number;
  config: LiveOutlineResolvedConfig;
  tasks: LiveOutlineTaskFull[];
}

export interface LiveOutline {
  header: LiveOutlineHeader;
  contexts: LiveOutlineContext[];
  tasks: LiveOutlineTask[];
  config: LiveOutlineContextConfig[];
}

export type LiveOutlineSelector =
  | { kind: "outline" }
  | { kind: "full" }
  | { kind: "context"; contextId: string }
  | { kind: "task"; taskId: string }
  | { kind: "config"; contextId: string };

export type LiveOutlineResult =
  | { ok: true; section: "outline"; outline: LiveOutline }
  | {
      ok: true;
      section: "full";
      header: LiveOutlineHeader;
      contexts: LiveOutlineContextSection[];
    }
  | { ok: true; section: "context"; context: LiveOutlineContextSection }
  | { ok: true; section: "task"; task: LiveOutlineTaskFull }
  | { ok: true; section: "config"; config: LiveOutlineResolvedConfig }
  | { ok: false; error: string };

function buildHeader(execution: GraphWorkflowExecution): LiveOutlineHeader {
  const editability = classifyExecutionEditability(execution);
  const editable = editability.kind === "editable";
  return {
    executionId: execution.id,
    liveRevision: execution.liveRevision,
    status: execution.status,
    seedDefinitionId: execution.seedDefinitionId,
    seedDefinitionRevision: execution.seedDefinitionRevision,
    editable,
    ...(editable ? {} : { notEditableReason: editability.reason }),
  };
}

/**
 * Resolve the classifier's lifecycle verdict into a display tier against the
 * execution-level editability (doc 06 outline column):
 *   - `frozen` lifecycle → `frozen`
 *   - `unstarted` lifecycle → `editable`
 *   - `started` lifecycle → `editable` when the execution is quiescent (paused or
 *     resumably-halted), otherwise `pause-to-edit`.
 * A not-editable execution is surfaced via the header's `editable:false`; a
 * `started` row on such an execution reads `pause-to-edit` (it would need a pause
 * the terminal execution can't grant), with the header as the authoritative gate.
 */
function resolveEditability(
  lifecycle: ContextLifecycle,
  execution: ExecutionEditability,
): LiveOutlineEditability {
  if (lifecycle === "frozen") return "frozen";
  if (lifecycle === "unstarted") return "editable";
  if (execution.kind === "editable" && execution.quiescent) return "editable";
  return "pause-to-edit";
}

function depsFor(
  execution: GraphWorkflowExecution,
  contextId: string,
): string[] {
  return execution.workingDefinition.edges
    .filter((edge) => edge.targetContextId === contextId)
    .map((edge) => edge.sourceContextId);
}

function summarizeAgent(
  agent: GraphWorkflowAgentConfig,
): LiveOutlineAgentSummary {
  return {
    backend: agent.backend,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
  };
}

function summarizeValidator(
  validator: GraphWorkflowAgentValidatorConfig | null,
): LiveOutlineValidatorSummary | null {
  if (!validator || !validator.enabled) return null;
  if (validator.type === "claude") {
    return {
      type: "claude",
      model: validator.agent.model,
      reasoningEffort: validator.agent.reasoningEffort,
    };
  }
  return {
    type: "codex",
    model: validator.codex.model ?? null,
    reasoningEffort: validator.codex.reasoningEffort ?? null,
  };
}

function summarizeCollaboration(
  collaboration: ResolvedCollaborationConfig | undefined,
): LiveOutlineCollaborationSummary | null {
  if (!collaboration) return null;
  return {
    secondAgent: summarizeAgent(collaboration.secondAgent.value),
    negotiationRounds: collaboration.negotiationRounds.value,
    autonomousResolutionThreshold:
      collaboration.autonomousResolutionThreshold.value,
  };
}

function summarizeConfig(
  context: GraphWorkflowResolvedContext,
): LiveOutlineContextConfig {
  return {
    contextId: context.id,
    implementer: summarizeAgent(context.implementer),
    validator: summarizeValidator(context.contextValidator),
    scriptValidator: context.scriptValidator.enabled,
    humanApprovalGate: context.humanApprovalGate.enabled,
    askUserQuestions: context.askUserQuestions.enabled,
    collaboration: summarizeCollaboration(context.collaboration),
  };
}

/**
 * A context's FULL resolved config — the concrete config blocks straight from
 * `workingDefinition` (doc 06: selector responses return full config). Unlike
 * {@link summarizeConfig} (the compact one-line outline summary), this is what
 * an agent/inspector reads before a targeted `live edit`.
 */
function resolveFullConfig(
  context: GraphWorkflowResolvedContext,
): LiveOutlineResolvedConfig {
  return {
    contextId: context.id,
    implementer: context.implementer,
    contextValidator: context.contextValidator,
    scriptValidator: context.scriptValidator,
    humanApprovalGate: context.humanApprovalGate,
    askUserQuestions: context.askUserQuestions,
    iterationPolicy: context.iterationPolicy,
    circuitBreaker: context.circuitBreaker,
    mutability: context.mutability,
    collaboration: context.collaboration ?? null,
  };
}

function contextRow(
  execution: GraphWorkflowExecution,
  context: GraphWorkflowResolvedContext,
  executionEditability: ExecutionEditability,
): LiveOutlineContext {
  const state = execution.contextStates[context.id];
  const lifecycle = classifyContextLifecycle(execution, context.id);
  return {
    id: context.id,
    title: context.title,
    status: state?.status ?? "pending",
    editability: resolveEditability(lifecycle, executionEditability),
    deps: depsFor(execution, context.id),
    completedTaskCount: state?.completedTaskCount ?? 0,
    totalTaskCount: state?.totalTaskCount ?? 0,
    iterationCount: state?.iterationCount ?? 0,
    maxIterations: context.iterationPolicy.maxIterations,
  };
}

/** Tasks in (context definition order, then task order) — a stable render order. */
function orderedTasks(execution: GraphWorkflowExecution) {
  const contextOrder = new Map<string, number>();
  execution.workingDefinition.executionContexts.forEach((context, index) => {
    contextOrder.set(context.id, index);
  });
  return [...execution.workingDefinition.tasks].sort((a, b) => {
    const byContext =
      (contextOrder.get(a.contextId) ?? Number.MAX_SAFE_INTEGER) -
      (contextOrder.get(b.contextId) ?? Number.MAX_SAFE_INTEGER);
    return byContext !== 0 ? byContext : a.order - b.order;
  });
}

function taskStatus(
  execution: GraphWorkflowExecution,
  taskId: string,
): GraphWorkflowTaskStatus {
  return execution.taskStates[taskId]?.status ?? "pending";
}

function sizedTaskRow(
  execution: GraphWorkflowExecution,
  task: GraphWorkflowExecution["workingDefinition"]["tasks"][number],
): LiveOutlineTask {
  return {
    contextId: task.contextId,
    order: task.order,
    id: task.id,
    status: taskStatus(execution, task.id),
    title: task.title,
    instructionChars: task.instructions.length,
  };
}

function fullTaskRow(
  execution: GraphWorkflowExecution,
  task: GraphWorkflowExecution["workingDefinition"]["tasks"][number],
): LiveOutlineTaskFull {
  return {
    contextId: task.contextId,
    order: task.order,
    id: task.id,
    status: taskStatus(execution, task.id),
    title: task.title,
    instructions: task.instructions,
    ...(task.metadata ? { metadata: task.metadata } : {}),
  };
}

function contextSection(
  execution: GraphWorkflowExecution,
  context: GraphWorkflowResolvedContext,
  executionEditability: ExecutionEditability,
): LiveOutlineContextSection {
  const row = contextRow(execution, context, executionEditability);
  const tasks = orderedTasks(execution)
    .filter((task) => task.contextId === context.id)
    .map((task) => fullTaskRow(execution, task));
  return {
    id: context.id,
    title: context.title,
    description: context.description ?? null,
    acceptanceCriteria: context.acceptanceCriteria,
    status: row.status,
    editability: row.editability,
    deps: row.deps,
    completedTaskCount: row.completedTaskCount,
    totalTaskCount: row.totalTaskCount,
    iterationCount: row.iterationCount,
    maxIterations: row.maxIterations,
    config: resolveFullConfig(context),
    tasks,
  };
}

export function projectLiveOutline(
  execution: GraphWorkflowExecution,
  selector: LiveOutlineSelector,
): LiveOutlineResult {
  const header = buildHeader(execution);
  const executionEditability = classifyExecutionEditability(execution);
  const contexts = execution.workingDefinition.executionContexts;

  if (selector.kind === "context") {
    const context = contexts.find((c) => c.id === selector.contextId);
    if (!context) {
      return { ok: false, error: `unknown context "${selector.contextId}"` };
    }
    return {
      ok: true,
      section: "context",
      context: contextSection(execution, context, executionEditability),
    };
  }

  if (selector.kind === "task") {
    const task = execution.workingDefinition.tasks.find(
      (t) => t.id === selector.taskId,
    );
    if (!task) {
      return { ok: false, error: `unknown task "${selector.taskId}"` };
    }
    return { ok: true, section: "task", task: fullTaskRow(execution, task) };
  }

  if (selector.kind === "config") {
    const context = contexts.find((c) => c.id === selector.contextId);
    if (!context) {
      return { ok: false, error: `unknown context "${selector.contextId}"` };
    }
    return { ok: true, section: "config", config: resolveFullConfig(context) };
  }

  if (selector.kind === "full") {
    return {
      ok: true,
      section: "full",
      header,
      contexts: contexts.map((context) =>
        contextSection(execution, context, executionEditability),
      ),
    };
  }

  return {
    ok: true,
    section: "outline",
    outline: {
      header,
      contexts: contexts.map((context) =>
        contextRow(execution, context, executionEditability),
      ),
      tasks: orderedTasks(execution).map((task) =>
        sizedTaskRow(execution, task),
      ),
      config: contexts.map((context) => summarizeConfig(context)),
    },
  };
}
