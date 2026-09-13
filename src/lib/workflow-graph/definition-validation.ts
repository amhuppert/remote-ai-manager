import {
  getFsWriteRestrictionForBackend,
  getConfiguredBackendModelCatalog,
} from "@/lib/agent-backends/catalog";
import { validateModelSelection } from "@/lib/agent-backends/model-selection";
import type { ExecutionCatalogEntry } from "@/lib/agent-backends/execution-admission";
import { validateWorkflowExecutionAdmission } from "./execution-admission";
import type { FsWriteRestrictionSupport } from "@/lib/agent-backends/descriptor";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import {
  sourceScopeContextIds,
  type WorkflowCharter,
} from "@/lib/workflows/charter-schemas";
import { acceptanceCriteriaText } from "./criteria/criterion-records";
import { validateEdgeGuards } from "./edge-guard-validation";
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
import {
  validateLaneDependencyAcyclicity,
  validatePlacements,
} from "./placement-validation";
import { validatePrerequisites } from "./prerequisite-validation";
import {
  collectResolvedWorkflowModelSelectionSites,
  type WorkflowModelSelectionRole,
} from "./model-selection-admission";

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

export function validateCharterInvariantScopes(
  charter: WorkflowCharter,
  contextIds: Iterable<string>,
): WorkflowGraphValidationError[] {
  const authoredContextIds = new Set(contextIds);
  const errors: WorkflowGraphValidationError[] = [];

  (charter.invariants ?? []).forEach((invariant, invariantIndex) => {
    invariant.appliesTo?.contextIds.forEach((contextId, contextIdIndex) => {
      if (authoredContextIds.has(contextId)) return;
      errors.push({
        code: "unknown-invariant-scope-context",
        message: `Invariant "${invariant.id}" scopes to unknown authored context "${contextId}"`,
        contextId,
        field: `charter.invariants.${invariantIndex}.appliesTo.contextIds.${contextIdIndex}`,
      });
    });
  });

  return errors;
}

/**
 * The source-scope twin of {@link validateCharterInvariantScopes}: a charter
 * source whose structured `appliesTo` names a context id the definition does
 * not declare is refused at accept time. A legacy prose `appliesTo` (persisted
 * pre-structured definitions) carries no context ids and is skipped — it is
 * rendered as global, never resolved against the graph. Duplicate ids within
 * one scope are already refused by the shared scope schema.
 */
export function validateCharterSourceScopes(
  charter: WorkflowCharter,
  contextIds: Iterable<string>,
): WorkflowGraphValidationError[] {
  const authoredContextIds = new Set(contextIds);
  const errors: WorkflowGraphValidationError[] = [];

  charter.sourcesOfTruth.forEach((source, sourceIndex) => {
    const scopedContextIds = sourceScopeContextIds(source);
    if (scopedContextIds === null) return;
    scopedContextIds.forEach((contextId, contextIdIndex) => {
      if (authoredContextIds.has(contextId)) return;
      errors.push({
        code: "unknown-source-scope-context",
        message: `Charter source "${source.id}" scopes to unknown authored context "${contextId}"`,
        contextId,
        field: `charter.sourcesOfTruth.${sourceIndex}.appliesTo.contextIds.${contextIdIndex}`,
      });
    });
  });

  return errors;
}

/**
 * The authored-shape gate for charter sources: stored definitions tolerate the
 * pre-structured shapes (the parse surfaces are deliberately tolerant so
 * persisted records — including delivery-plan documents that embed a launch —
 * keep loading verbatim), but a plan submitted for validate/create/replace
 * must not author them. The retired `accessPolicy` is refused because external
 * material is materialized into the worktree at plan time instead of
 * permission-gated per agent; prose `appliesTo` is refused because only a
 * structured scope can be resolved against the graph.
 */
export function validateCharterSourceAuthoredShapes(
  charter: WorkflowCharter,
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];

  charter.sourcesOfTruth.forEach((source, sourceIndex) => {
    if (source.accessPolicy !== undefined) {
      errors.push({
        code: "retired-source-access-policy",
        message: `Charter source "${source.id}" carries the retired accessPolicy field; external material is materialized into the worktree at plan time instead of permission-gated per agent`,
        field: `charter.sourcesOfTruth.${sourceIndex}.accessPolicy`,
      });
    }
    if (typeof source.appliesTo === "string") {
      errors.push({
        code: "legacy-source-applies-to",
        message: `Charter source "${source.id}" uses legacy prose appliesTo; author a structured scope ({ contextIds: [...] }) or omit the field for a global source`,
        field: `charter.sourcesOfTruth.${sourceIndex}.appliesTo`,
      });
    }
  });

  return errors;
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
    ...validateWorkflowExecutionAdmission(definition, deps.executionEntryFor),
    ...validateContextOutputSchemas(definition.executionContexts),
    ...validateLaneDependencyAcyclicity(definition),
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
    if (
      context.scriptValidator?.purpose === "infrastructure" &&
      context.placement?.mode !== "full"
    ) {
      errors.push({
        code: "infrastructure-check-requires-full-placement",
        contextId: context.id,
        field: "scriptValidator.purpose",
        message: `Infrastructure readiness context "${context.id}" requires full placement so its commands run before downstream admission`,
      });
    }
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

    if (!acceptanceCriteriaText(context.acceptanceCriteria).trim()) {
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
    ...validateCharterInvariantScopes(
      definition.charter,
      definition.executionContexts.map((context) => context.id),
    ),
    ...validateCharterSourceScopes(
      definition.charter,
      definition.executionContexts.map((context) => context.id),
    ),
    ...validateCharterSourceAuthoredShapes(definition.charter),
    ...validateWorkflowDefinition(definition, deps).errors,
  ];

  return resultFromErrors(errors);
}

export function validateResolvedWorkflow(
  resolved: ResolvedWorkflowSemanticDefinition,
  deps: BackendCapabilityDeps = {},
): WorkflowGraphValidationResult {
  const errors: WorkflowGraphValidationError[] = [
    ...validateWorkflowExecutionAdmission(resolved, deps.executionEntryFor),
    ...validateCohortWriteRestriction(resolved.executionContexts, deps),
  ];

  for (const site of collectResolvedWorkflowModelSelectionSites(resolved)) {
    const validation = validateModelSelection(
      getConfiguredBackendModelCatalog(
        site.backend,
        deps.configuredModelSelectionFor?.(site.backend),
      ),
      site.modelSelection,
    );
    if (validation.valid) continue;
    errors.push({
      code: resolvedSelectionErrorCode(site.role),
      message: `${resolvedSelectionUseSite(site)} has an invalid ${site.backend} model selection: ${validation.issues.map(({ message }) => message).join(" ")}`,
      ...(site.contextId === undefined ? {} : { contextId: site.contextId }),
      field: site.path,
    });
  }

  return resultFromErrors(errors);
}

function resolvedSelectionErrorCode(role: WorkflowModelSelectionRole): string {
  switch (role) {
    case "implementer":
      return "implementer-model-selection-invalid";
    case "validator":
      return "validator-model-selection-invalid";
    case "plan-repair":
      return "plan-repair-model-selection-invalid";
    case "collaboration":
      return "collaboration-model-selection-invalid";
  }
}

function resolvedSelectionUseSite(site: {
  role: WorkflowModelSelectionRole;
  contextId?: string;
  assignmentId?: string;
}): string {
  const context =
    site.contextId === undefined ? "Workflow" : `Context "${site.contextId}"`;
  if (site.assignmentId !== undefined) {
    return `${context} ${site.role} assignment "${site.assignmentId}"`;
  }
  return `${context} ${site.role} agent`;
}

/**
 * Backend facts a definition check needs but a definition does not carry.
 * Injected because the write-restriction lookup is a per-backend capability
 * declaration: a test can only prove the refusal by naming a backend that
 * cannot enforce, and every registered one can.
 */
export interface BackendCapabilityDeps {
  executionEntryFor?(backend: AgentBackendId): ExecutionCatalogEntry;
  fsWriteRestrictionFor?(backend: AgentBackendId): FsWriteRestrictionSupport;
  configuredModelSelectionFor?(
    backend: AgentBackendId,
  ): BackendModelSelection | undefined;
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
 * skipped because it is dormant configuration, not a run; model-selection
 * admission still validates it so enabling the cohort cannot expose a latent
 * invalid selection.
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
    if (fsWriteRestrictionFor(backend) !== "unsupported") continue;
    errors.push({
      code: "validator-write-restriction-unsupported",
      message: `${site.useSite} validator assignment "${assignment.id}" runs on ${backend}, which cannot apply a filesystem write policy for this validator assignment`,
      ...(site.contextId === undefined ? {} : { contextId: site.contextId }),
      field: `${site.fieldPath}.assignments.${index}.agent.backend`,
    });
  }
  return errors;
}
