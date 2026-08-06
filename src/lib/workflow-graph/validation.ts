import {
  getEffortLevelsForBackend,
  getFsWriteRestrictionForBackend,
} from "@/lib/agent-backends/catalog";
import type { FsWriteRestrictionSupport } from "@/lib/agent-backends/descriptor";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  isContextOutputCommittedToLane,
  isUpstreamVisibleToDownstream,
} from "./lane-readiness";
import { validateContextOutputSchemas } from "./output-schema-validation";
import {
  lintParameterReferences,
  validateParameterDeclarations,
} from "./parameter-validation";
import { validatePrerequisites } from "./prerequisite-validation";

type ValidatableDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

export type { WorkflowGraphValidationError } from "@/lib/workflow-graph/definition-schemas";

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

/**
 * Structural graph validation plus the per-context output-schema declaration
 * check. The declaration check lives HERE, not alongside in
 * `validateAuthoredDefinition`, because `outputSchema` is the one authored field
 * that exists identically on both an authored context and a resolved one: this
 * is the single function every definition accept path already calls (create /
 * replace / validate via `validateAuthoredDefinition`, saved-tier edits via
 * `applyDefinitionEdits`, live-tier edits via the execution frontier, and the
 * seed-time re-validation of the substituted definition), so wiring it here is
 * what makes the fail-closed refusal impossible for a path to miss. Unlike the
 * placeholder lint, it is safe on substituted data: an output schema is an
 * object, never a `{{...}}` substitution target, so the check is idempotent
 * across the authored → concrete transition.
 */
export function validateWorkflowDefinition(
  definition: ValidatableDefinition,
  deps: BackendCapabilityDeps = {},
): WorkflowGraphValidationResult {
  const errors: WorkflowGraphValidationError[] = [
    ...validateContextOutputSchemas(definition.executionContexts),
    ...validateCohortWriteRestriction(definition.executionContexts, deps),
    ...validateWorkflowTierCohortWriteRestriction(definition, deps),
  ];
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
 * structural validator, NEVER folded inside it, so the seed-time re-validation
 * (a substituted concrete definition) can call `validateWorkflowDefinition`
 * alone without re-applying the grammar lint — a bound launcher value may
 * legitimately contain a literal `{{...}}` (R5.1, R5.5). The rule is
 * substitution-sensitivity, not "structural only": the output-schema declaration
 * check DOES live inside `validateWorkflowDefinition`, because an output schema
 * is never a substitution target and the field exists on the resolved shape too,
 * so the live tier must get the same refusal.
 *
 * Prerequisite shape checks (`validatePrerequisites`) compose here ALONGSIDE the
 * parameter checks — neither owns the other — so both author paths and both
 * tiers reject an invalid prerequisite at the same choke point (gwt R4.4, R4.6).
 */
export function validateAuthoredDefinition(
  definition: WorkflowSemanticDefinition,
  deps: BackendCapabilityDeps = {},
): WorkflowGraphValidationResult {
  const errors: WorkflowGraphValidationError[] = [
    ...validatePrerequisites(definition.prerequisites),
    ...validateParameterDeclarations(definition.parameters),
    ...lintParameterReferences(definition),
    ...validateWorkflowDefinition(definition, deps).errors,
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
      // Owner-discriminated reservation (Design 3.1): a context a scheduler has
      // reserved (and is provisioning worktrees for out of the lock) is not
      // eligible for a concurrent same-epoch scheduler to re-classify and
      // double-provision. The owning pass clears the stamp at finalize.
      if (state.reservedByBatchId != null) return false;

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
  deps: BackendCapabilityDeps = {},
): WorkflowGraphValidationResult {
  const errors: WorkflowGraphValidationError[] = [
    ...validateCohortWriteRestriction(resolved.executionContexts, deps),
  ];

  for (const [contextIndex, context] of resolved.executionContexts.entries()) {
    const { agent } = context.implementer;
    const supported = getEffortLevelsForBackend(agent.backend, agent.model);
    if (!supported.includes(agent.reasoningEffort)) {
      errors.push({
        code: "implementer-effort-unsupported",
        message: `Context "${context.id}" implementer assignment "${context.implementer.id}" uses reasoning effort "${agent.reasoningEffort}", which is not supported by ${agent.backend} model "${agent.model}"`,
        contextId: context.id,
        field: `executionContexts.${contextIndex}.implementer.agent.reasoningEffort`,
      });
    }

    errors.push(...validateResolvedCohortEffort(context, contextIndex));
  }

  return resultFromErrors(errors);
}

/**
 * Backend facts a definition check needs but a definition does not carry.
 * Injected because the write-restriction lookup is a per-backend capability
 * declaration: a test can only prove the refusal by naming a backend that
 * cannot enforce, and every registered one can.
 */
export interface BackendCapabilityDeps {
  fsWriteRestrictionFor?(backend: AgentBackendId): FsWriteRestrictionSupport;
}

/** The cohort shape every tier — global-seeded, workflow, context — exposes. */
interface WriteRestrictionCheckableCohort {
  enabled: boolean;
  assignments: readonly { id: string; agent: { backend: AgentBackendId } }[];
}

/** The cohort shape both the authored and the resolved context expose. */
interface WriteRestrictionCheckableContext {
  id: string;
  contextValidator?: WriteRestrictionCheckableCohort;
}

/**
 * Refuse every cohort member whose backend cannot mechanically confine the
 * lane's writes (R7.2).
 *
 * The refusal is at definition accept-time rather than at dispatch because a
 * validator that reached dispatch on an unenforceable backend has only two
 * outcomes — run unsandboxed, or fail the round — and both are worse than never
 * admitting the definition. It is attached to the STRUCTURAL validator (which
 * every accept path calls) and to the resolved check (which sees cascade-supplied
 * cohorts the authored document never named), because a backend id is an enum
 * member, never a substitution target, so the check is identical on both sides
 * of the authored → concrete transition.
 *
 * Implementer assignments are deliberately untouched: they are write-capable by
 * design, so the envelope has nothing to say about them. A disabled cohort is
 * skipped for the same reason the effort check skips it — dormant configuration,
 * not a run — and enabling one re-enters this check through the live-edit path.
 */
function validateCohortWriteRestriction(
  contexts: readonly WriteRestrictionCheckableContext[],
  deps: BackendCapabilityDeps,
): WorkflowGraphValidationError[] {
  return contexts.flatMap((context, contextIndex) =>
    checkCohortWriteRestriction(context.contextValidator, deps, {
      contextId: context.id,
      fieldPath: `executionContexts.${contextIndex}.contextValidator`,
      useSite: `Context "${context.id}"`,
    }),
  );
}

/**
 * The workflow-tier cohort is a use site in its own right (R7.2).
 *
 * Assignments replace as whole units across the cascade, so a context that
 * declares no cohort of its own runs THIS one verbatim — an unsandboxable
 * assignment here is not dormant configuration, it is every such context's
 * lanes. Checking only `executionContexts` would admit the definition and leave
 * the refusal to launch-time resolution, which is exactly the deferral the
 * definition-validate gate exists to prevent.
 *
 * The global tier has no definition to validate: it enters through the cascade
 * and is caught by `validateResolvedWorkflow` before a run is seeded.
 */
function validateWorkflowTierCohortWriteRestriction(
  definition: ValidatableDefinition,
  deps: BackendCapabilityDeps,
): WorkflowGraphValidationError[] {
  if (!("workflowConfig" in definition)) return [];
  return checkCohortWriteRestriction(
    definition.workflowConfig.contextValidator,
    deps,
    {
      fieldPath: "workflowConfig.contextValidator",
      useSite: "Workflow-level",
    },
  );
}

function checkCohortWriteRestriction(
  cohort: WriteRestrictionCheckableCohort | undefined,
  deps: BackendCapabilityDeps,
  site: { contextId?: string; fieldPath: string; useSite: string },
): WorkflowGraphValidationError[] {
  if (!cohort?.enabled) return [];
  const fsWriteRestrictionFor =
    deps.fsWriteRestrictionFor ?? getFsWriteRestrictionForBackend;

  const errors: WorkflowGraphValidationError[] = [];
  for (const [index, assignment] of cohort.assignments.entries()) {
    const { backend } = assignment.agent;
    if (fsWriteRestrictionFor(backend) === "enforced") continue;
    errors.push({
      code: "validator-write-restriction-unsupported",
      message: `${site.useSite} validator assignment "${assignment.id}" runs on ${backend}, which cannot enforce a filesystem write restriction; validators must be mechanically read-only, so this backend cannot hold a validator assignment`,
      ...(site.contextId === undefined ? {} : { contextId: site.contextId }),
      field: `${site.fieldPath}.assignments.${index}.agent.backend`,
    });
  }
  return errors;
}

/**
 * Check every validator assignment's reasoning effort against its own model —
 * the validator half of the frontier's resolved-config check (doc 06). Each
 * assignment carries a concrete per-backend runtime, so the check is per
 * assignment and the error addresses the offending entry by index rather than
 * blaming the context as a whole.
 *
 * A disabled cohort is skipped: its assignments are dormant configuration, not
 * a run that could fail.
 */
function validateResolvedCohortEffort(
  context: ResolvedWorkflowSemanticDefinition["executionContexts"][number],
  contextIndex: number,
): WorkflowGraphValidationError[] {
  const cohort = context.contextValidator;
  if (!cohort.enabled) return [];

  const errors: WorkflowGraphValidationError[] = [];
  for (const [index, assignment] of cohort.assignments.entries()) {
    const { backend, model, reasoningEffort } = assignment.agent;
    const supported = getEffortLevelsForBackend(backend, model);
    if (!supported.includes(reasoningEffort)) {
      errors.push({
        code: "validator-effort-unsupported",
        message: `Context "${context.id}" validator assignment "${assignment.id}" uses reasoning effort "${reasoningEffort}", which is not supported by ${backend} model "${model}"`,
        contextId: context.id,
        field: `executionContexts.${contextIndex}.contextValidator.assignments.${index}.agent.reasoningEffort`,
      });
    }
  }
  return errors;
}
