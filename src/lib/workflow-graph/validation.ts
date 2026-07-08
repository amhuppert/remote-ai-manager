import { getEffortLevelsForBackend } from "@/lib/agent-backends/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  ResolvedWorkflowSemanticDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflows/schemas";
import {
  isContextOutputCommittedToLane,
  isUpstreamVisibleToDownstream,
} from "./lane-readiness";
import {
  lintParameterReferences,
  validateParameterDeclarations,
} from "./parameter-validation";
import { validatePrerequisites } from "./prerequisite-validation";

type ValidatableDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

export type { WorkflowGraphValidationError } from "@/lib/workflows/schemas";

export interface WorkflowGraphValidationResult {
  ok: boolean;
  errors: WorkflowGraphValidationError[];
}

export class GraphWorkflowValidationError extends Error {
  readonly errors: WorkflowGraphValidationError[];

  constructor(
    errors: WorkflowGraphValidationError[],
    message = "Workflow validation failed",
  ) {
    super(message);
    this.name = "GraphWorkflowValidationError";
    this.errors = errors;
  }
}

function resultFromErrors(
  errors: WorkflowGraphValidationError[],
): WorkflowGraphValidationResult {
  return {
    ok: errors.length === 0,
    errors,
  };
}

function createContextIdSet(definition: ValidatableDefinition): Set<string> {
  return new Set(definition.executionContexts.map((context) => context.id));
}

export function validateWorkflowDefinition(
  definition: ValidatableDefinition,
): WorkflowGraphValidationResult {
  const errors: WorkflowGraphValidationError[] = [];
  const seenContextIds = new Set<string>();
  const seenTaskIds = new Set<string>();
  const contextIds = createContextIdSet(definition);
  const ordersByContext = new Map<string, Set<number>>();

  for (const context of definition.executionContexts) {
    if (seenContextIds.has(context.id)) {
      errors.push({
        code: "duplicate-context-id",
        message: `Execution context "${context.id}" is duplicated`,
        contextId: context.id,
      });
      continue;
    }
    seenContextIds.add(context.id);

    if (!context.title.trim()) {
      errors.push({
        code: "empty-context-title",
        message: `Context "${context.id}" has an empty title`,
        contextId: context.id,
      });
    }

    if (!context.acceptanceCriteria.trim()) {
      errors.push({
        code: "empty-context-acceptance-criteria",
        message: `Context "${context.id}" has empty acceptance criteria`,
        contextId: context.id,
      });
    }
  }

  for (const task of definition.tasks) {
    if (seenTaskIds.has(task.id)) {
      errors.push({
        code: "duplicate-task-id",
        message: `Task "${task.id}" is duplicated`,
        taskId: task.id,
        contextId: task.contextId,
      });
    } else {
      seenTaskIds.add(task.id);
    }

    if (!contextIds.has(task.contextId)) {
      errors.push({
        code: "unknown-task-context",
        message: `Task "${task.id}" references missing context "${task.contextId}"`,
        taskId: task.id,
        contextId: task.contextId,
      });
    }

    if (!task.title.trim()) {
      errors.push({
        code: "empty-task-title",
        message: `Task "${task.id}" has an empty title`,
        taskId: task.id,
        contextId: task.contextId,
      });
    }

    if (!task.instructions.trim()) {
      errors.push({
        code: "empty-task-instructions",
        message: `Task "${task.id}" has empty instructions`,
        taskId: task.id,
        contextId: task.contextId,
      });
    }

    const seenOrders = ordersByContext.get(task.contextId) ?? new Set<number>();
    if (seenOrders.has(task.order)) {
      errors.push({
        code: "duplicate-task-order",
        message: `Context "${task.contextId}" reuses task order ${task.order}`,
        taskId: task.id,
        contextId: task.contextId,
      });
    }
    seenOrders.add(task.order);
    ordersByContext.set(task.contextId, seenOrders);
  }

  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const context of definition.executionContexts) {
    adjacency.set(context.id, []);
    indegree.set(context.id, 0);
  }

  for (const edge of definition.edges) {
    if (!contextIds.has(edge.sourceContextId)) {
      errors.push({
        code: "unknown-edge-source",
        message: `Edge "${edge.id}" references missing source "${edge.sourceContextId}"`,
        edgeId: edge.id,
        contextId: edge.sourceContextId,
      });
      continue;
    }

    if (!contextIds.has(edge.targetContextId)) {
      errors.push({
        code: "unknown-edge-target",
        message: `Edge "${edge.id}" references missing target "${edge.targetContextId}"`,
        edgeId: edge.id,
        contextId: edge.targetContextId,
      });
      continue;
    }

    adjacency.get(edge.sourceContextId)!.push(edge.targetContextId);
    indegree.set(
      edge.targetContextId,
      (indegree.get(edge.targetContextId) ?? 0) + 1,
    );
  }

  const queue = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([contextId]) => contextId);
  let visited = 0;

  while (queue.length > 0) {
    const contextId = queue.shift()!;
    visited += 1;
    for (const nextContextId of adjacency.get(contextId) ?? []) {
      const nextCount = (indegree.get(nextContextId) ?? 0) - 1;
      indegree.set(nextContextId, nextCount);
      if (nextCount === 0) {
        queue.push(nextContextId);
      }
    }
  }

  if (visited !== definition.executionContexts.length) {
    errors.push({
      code: "cycle-detected",
      message: "Execution-context dependency graph must be acyclic",
    });
  }

  return resultFromErrors(errors);
}

/**
 * Composite accept-time (authoring) validator. Runs, in order, the parameter
 * shape checks, the placeholder-grammar + reference lint, and the structural
 * graph validation, COLLECTING every error from all three (no short-circuit).
 *
 * The grammar lint (`lintParameterReferences`) is attached here ALONGSIDE the
 * structural validator, NEVER folded inside it. `validateWorkflowDefinition`
 * stays purely structural so the seed-time re-validation (a substituted concrete
 * definition) can call it alone without re-applying the grammar lint — a bound
 * launcher value may legitimately contain a literal `{{...}}` (R5.1, R5.5).
 *
 * Prerequisite shape checks (`validatePrerequisites`) compose here ALONGSIDE the
 * parameter checks — neither owns the other — so both author paths and both
 * tiers reject an invalid prerequisite at the same choke point (gwt R4.4, R4.6).
 */
export function validateAuthoredDefinition(
  definition: WorkflowSemanticDefinition,
): WorkflowGraphValidationResult {
  const errors: WorkflowGraphValidationError[] = [
    ...validatePrerequisites(definition.prerequisites),
    ...validateParameterDeclarations(definition.parameters),
    ...lintParameterReferences(definition),
    ...validateWorkflowDefinition(definition).errors,
  ];

  return resultFromErrors(errors);
}

export function getEntryContextIds(
  definition: ValidatableDefinition,
): string[] {
  const targets = new Set(definition.edges.map((edge) => edge.targetContextId));
  return definition.executionContexts
    .map((context) => context.id)
    .filter((contextId) => !targets.has(contextId));
}

export function getTerminalContextIds(
  definition: ValidatableDefinition,
): string[] {
  const sources = new Set(definition.edges.map((edge) => edge.sourceContextId));
  return definition.executionContexts
    .map((context) => context.id)
    .filter((contextId) => !sources.has(contextId));
}

/**
 * A context is "landed" — its work is visible to a session-bound downstream.
 * Equivalent to "upstream output is visible to a downstream that has no lane
 * assignment" under the lane-aware model: legacy session-isolation contexts
 * publish straight to the session worktree, and legacy per-context worktree
 * contexts publish via the fan-in squash merge (`mergeStatus === "merged-success"`).
 * Prefer {@link isContextOutputCommittedToLane} or
 * {@link isUpstreamVisibleToDownstream} for lane-aware callers.
 */
export function isContextLanded(
  state: GraphWorkflowExecutionContextState,
): boolean {
  if (state.status !== "completed") return false;
  if (state.laneId !== null) return false;
  if (state.isolation === "session") return true;
  return state.mergeStatus === "merged-success";
}

export function getEligibleContextIds(
  definition: ValidatableDefinition,
  execution: GraphWorkflowExecution,
): string[] {
  const prerequisites = new Map<string, string[]>();
  for (const context of definition.executionContexts) {
    prerequisites.set(context.id, []);
  }
  for (const edge of definition.edges) {
    prerequisites.get(edge.targetContextId)?.push(edge.sourceContextId);
  }

  return definition.executionContexts
    .map((context) => context.id)
    .filter((contextId) => {
      const state = execution.contextStates[contextId];
      if (!state) return false;
      if (state.status !== "pending" && state.status !== "ready") return false;

      return (prerequisites.get(contextId) ?? []).every((upstreamId) => {
        const upstream = execution.contextStates[upstreamId];
        if (!upstream) return false;
        if (!isContextOutputCommittedToLane(upstream, execution)) return false;
        if (state.laneId === null) return true;
        return isUpstreamVisibleToDownstream(upstreamId, contextId, execution);
      });
    });
}

export function validateResolvedWorkflow(
  resolved: ResolvedWorkflowSemanticDefinition,
): WorkflowGraphValidationResult {
  const errors: WorkflowGraphValidationError[] = [];

  for (const context of resolved.executionContexts) {
    const { implementer } = context;
    const supported = getEffortLevelsForBackend(
      implementer.backend,
      implementer.model,
    );
    if (!supported.includes(implementer.reasoningEffort)) {
      errors.push({
        code: "implementer-effort-unsupported",
        message: `Context "${context.id}" implementer uses reasoning effort "${implementer.reasoningEffort}", which is not supported by ${implementer.backend} model "${implementer.model}"`,
        contextId: context.id,
      });
    }

    const validatorError = validateResolvedValidatorEffort(context);
    if (validatorError) errors.push(validatorError);
  }

  return resultFromErrors(errors);
}

/**
 * Check that a resolved context validator's reasoning effort is supported by its
 * model — the validator half of the frontier's resolved-config check (doc 06).
 * A `claude`-type validator carries a full agent config (whose backend may itself
 * be Codex); a `codex`-type validator selects effort only when set (an absent
 * effort inherits the backend default, so there is nothing to reject).
 */
function validateResolvedValidatorEffort(
  context: ResolvedWorkflowSemanticDefinition["executionContexts"][number],
): WorkflowGraphValidationError | null {
  const validator = context.contextValidator;
  if (!validator) return null;

  const unsupported = (
    backend: "claude" | "codex",
    model: string,
    effort: string,
  ): WorkflowGraphValidationError => ({
    code: "validator-effort-unsupported",
    message: `Context "${context.id}" validator uses reasoning effort "${effort}", which is not supported by ${backend} model "${model}"`,
    contextId: context.id,
  });

  if (validator.type === "claude") {
    const { backend, model, reasoningEffort } = validator.agent;
    const supported = getEffortLevelsForBackend(backend, model);
    if (!supported.includes(reasoningEffort)) {
      return unsupported(backend, model, reasoningEffort);
    }
    return null;
  }

  const { model, reasoningEffort } = validator.codex;
  if (reasoningEffort === undefined) return null;
  const supported = getEffortLevelsForBackend("codex", model);
  if (!supported.includes(reasoningEffort)) {
    return unsupported("codex", model ?? "gpt-5.4", reasoningEffort);
  }
  return null;
}
