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
import { validateEdgeGuards } from "./edge-guard-validation";
import {
  isContextOutputCommittedToLane,
  isRouteSourceLanded,
} from "./lane-readiness";
import {
  collectLoopBoundaryContextIds,
  validateLoopGroups,
} from "./loop-resolver";
import { validateContextOutputSchemas } from "./output-schema-validation";
import { collectEnvelopedScriptCoverageIssues } from "./command-selector-validation";
import {
  lintParameterReferences,
  validateParameterDeclarations,
} from "./parameter-validation";
import { validatePlacements } from "./placement-validation";
import { validatePrerequisites } from "./prerequisite-validation";
import { activeDependencySourceIds, routeVerdict } from "./route-projection";
import { projectExecutionRoutes } from "./execution-routes";

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

function validateExplicitLaneBarrierCoverage(
  definition: ValidatableDefinition,
): WorkflowGraphValidationError[] {
  const authored = "workflowConfig" in definition;
  const barrierSelector = authored
    ? definition.workflowConfig.laneMergeValidation?.commands
    : definition.laneMergeValidation.commands;
  if (barrierSelector?.mode !== "only") return [];

  const workflowCommands = authored
    ? definition.workflowConfig.scriptValidator?.commands
    : undefined;
  return definition.executionContexts.flatMap((context, index) => {
    const contextCommands = context.scriptValidator?.commands;
    const commands = contextCommands ?? workflowCommands;
    if (commands === undefined) return [];
    return collectEnvelopedScriptCoverageIssues({
      context,
      commands,
      commandField:
        contextCommands !== undefined
          ? `executionContexts.${index}.scriptValidator.commands`
          : "workflowConfig.scriptValidator.commands",
      barrierCommands: barrierSelector.commands,
    });
  });
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
    ...validateExplicitLaneBarrierCoverage(definition),
    ...validateCohortWriteRestriction(definition.executionContexts, deps),
    ...validateWorkflowTierCohortWriteRestriction(definition, deps),
    ...validateEdgeGuards(definition.executionContexts, definition.edges),
    ...validateLoopGroups(definition),
  ];
  const seenContextIds = new Set<string>();
  const seenTaskIds = new Set<string>();
  const contextIds = createContextIdSet(definition);
  // A resolved loop group's entry and exit live in its body template rather
  // than in `executionContexts`, yet external edges still address them: the
  // logical exit stays immutable in the topology while the route projection
  // resolves which pass instance satisfies each edge (D1). They are edge
  // endpoints and graph nodes, but never task owners — a body context's tasks
  // live in the template with it.
  const loopBoundaryIds = collectLoopBoundaryContextIds(definition);
  const edgeEndpointIds = new Set([...contextIds, ...loopBoundaryIds]);
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
  for (const contextId of edgeEndpointIds) {
    adjacency.set(contextId, []);
    indegree.set(contextId, 0);
  }

  // Edge identity is first-class from D4 on: guards make parallel edges between
  // the same pair meaningful and every id-addressed edit resolves an edge by id,
  // so a duplicate would silently make one of them unreachable. Definitions
  // stored before this rule are repaired at their inflate boundary
  // (`normalizeRawDefinitionEdgeIds`), never refused here.
  const seenEdgeIds = new Set<string>();
  definition.edges.forEach((edge, index) => {
    if (seenEdgeIds.has(edge.id)) {
      errors.push({
        code: "duplicate-edge-id",
        message: `Edge id "${edge.id}" is used more than once`,
        edgeId: edge.id,
        field: `edges[${index}].id`,
      });
      return;
    }
    seenEdgeIds.add(edge.id);
  });

  for (const edge of definition.edges) {
    if (!edgeEndpointIds.has(edge.sourceContextId)) {
      errors.push({
        code: "unknown-edge-source",
        message: `Edge "${edge.id}" references missing source "${edge.sourceContextId}"`,
        edgeId: edge.id,
        contextId: edge.sourceContextId,
      });
      continue;
    }

    if (!edgeEndpointIds.has(edge.targetContextId)) {
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

  if (visited !== edgeEndpointIds.size) {
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
 *
 * Placement checks (`validatePlacements`) compose here rather than inside
 * `validateWorkflowDefinition` even though the resolved shape mirrors the field.
 * The authored tier is where an authored placement can be WRONG — a reserved
 * lane name, a path under `.git`, an owning grade with no paths — and this is
 * the composite every author path reaches (validate, create, replace, and the
 * saved-edit applier). The live tier re-asks the same checks at the live-edit
 * frontier instead, against the post-batch working definition, where it can also
 * see which lane siblings are actually running.
 */
export function validateAuthoredDefinition(
  definition: WorkflowSemanticDefinition,
  deps: BackendCapabilityDeps = {},
): WorkflowGraphValidationResult {
  const errors: WorkflowGraphValidationError[] = [
    ...validatePrerequisites(definition.prerequisites),
    ...validateParameterDeclarations(definition.parameters),
    ...lintParameterReferences(definition),
    ...validatePlacements(definition),
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
 * `isUpstreamVisibleToLane` for lane-aware callers.
 */
export function isContextLanded(
  state: GraphWorkflowExecutionContextState,
): boolean {
  if (state.status !== "completed") return false;
  if (state.laneId !== null) return false;
  if (state.isolation === "session") return true;
  return state.mergeStatus === "merged-success";
}

/**
 * The contexts the scheduler may start right now.
 *
 * Two independent gates, composed (D4 R2.5). The ROUTE gate is the projection's
 * verdict: every incoming edge satisfied, where a guard decides a conditional
 * edge and a skipped source's unconditional edge drops out of the conjunction.
 * The LAND gate is unchanged and still necessary — a satisfied route says the
 * branch was taken, not that the source's work is committed and visible from
 * the downstream's lane — so a source whose fan-in merge is pending or failed
 * blocks its dependents here rather than releasing them.
 *
 * Prerequisites come from `activeDependencySourceIds`, i.e. the EFFECTIVE
 * sources of the ACTIVE incoming edges (decision D1). Reading
 * `edge.sourceContextId` directly would wait on branches the routing already
 * declined and, once loops land, on a declared exit that never runs.
 *
 * The LAND gate stops at "has it landed". WHERE it landed relative to this
 * context's lane is `classifyContextSchedulability`'s call, and deliberately
 * not repeated here: an upstream on a lane the target has not merged yet is
 * joinable, not blocked, and the classifier's `wait-for-join` verdict is what
 * plans that merge. Filtering the context out of eligibility would leave nobody
 * to plan it (R3.2).
 */
export function getEligibleContextIds(
  definition: ValidatableDefinition,
  execution: GraphWorkflowExecution,
): string[] {
  const projection = projectExecutionRoutes(execution, definition);

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

      if (routeVerdict(projection, contextId).kind !== "eligible") return false;

      return activeDependencySourceIds(projection, contextId).every(
        (upstreamId) => isRouteSourceLanded(execution, upstreamId),
      );
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
