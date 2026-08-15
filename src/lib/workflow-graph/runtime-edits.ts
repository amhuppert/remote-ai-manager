import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertNever } from "@/lib/shared/assert-never";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { SeededValidatorCohort, ValidatorCohort } from "./config-schemas";
import {
  createExecutionIndex,
  type ExecutionIndex,
} from "@/lib/workflow-graph/execution-index";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
  GraphWorkflowTaskState,
  LoopControlAmendment,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowContextEdge,
  GraphWorkflowResolvedContext,
  GraphWorkflowResolvedLoopGroup,
  GraphWorkflowTaskDefinition,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  LoopTemplateContentOperation,
  WorkflowLiveEditOperation,
  WorkflowLiveEditRequest,
} from "@/lib/workflows/edit-schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import {
  GraphWorkflowValidationError,
  validateResolvedWorkflow,
  validateWorkflowDefinition,
} from "./validation";
import { validatePlacements } from "./placement-validation";
import { collectLiveSessionReadOnlyViolations } from "./live-session-read-only";
import {
  classifyContextLifecycle,
  classifyContextLifecycleFromPin,
  classifyExecutionEditability,
  pinContextInitialState,
  type ContextInitialStatePin,
  type ContextLifecycle,
} from "./lifecycle-classifier";
import {
  STRUCTURAL_REVISION_KEYS,
  type StructuralRevisionKey,
} from "./structural-revision";
import {
  buildInitialContextState,
  buildInitialTaskState,
} from "./execution-state";
import { ensureLoopState } from "./loop-budgets";
import {
  LOOP_PASS_ENTRY_EDGE_SUFFIX,
  loopInstanceId,
  validateExpansionInitiator,
  validateExpansionPayloadLoopDeclarations,
  type LoopActivationReader,
} from "./loop-resolver";
import { executionLaneIdFor } from "./lane-identity";
import {
  laneClosure,
  laneClosureFromPin,
  pinLaneClosure,
  LANE_CLOSED_CODE,
  type LaneClosurePin,
} from "./lane-lifecycle";
import { mintEdgeId } from "./edge-identity";
import { resolvedContextConfig } from "./generated-child-config";
import { findCriteriaWithoutMustRunCoverage } from "./criterion-coverage";
import { bumpRouteControlRevisions } from "./route-control-revision";
import type { DefinitionEditTaskPosition } from "@/lib/workflows/edit-schemas";
import {
  findLockedRegionTouch,
  regionLockedInstruction,
  regionLockedMessage,
  type DefinitionPath,
} from "./locked-regions";
import { applyCharterContentEdit } from "./definition-edits";
import {
  collectValidationCommandIssuesForResolvedContext,
  collectLaneMergeValidationCommandIssues,
  ENVELOPED_SCRIPT_VALIDATION_NOT_COVERED_CODE,
} from "./command-selector-validation";
import {
  VALIDATION_COST_EXCEEDS_LIMIT_CODE,
  type ValidationCommandPreflight,
} from "@/lib/validation/preflight";
import { expandCommandSelector } from "./resolve-config";
import { computeCharterHash } from "./charter/render";
import {
  workflowCharterSchema,
  type CharterAmendment,
} from "@/lib/workflows/charter-schemas";
import { CHARTER_CONTENT_EDIT_FIELDS } from "@/lib/workflows/edit-schemas";
import type { GraphExecutionContract } from "./execution-contract-port";
import type { PlaceableAssignment } from "./live-edit-preparation";

export interface AgentAddedTask {
  slug?: string;
  title: string;
  instructions: string;
}

/**
 * The result of a lane-agent task add. `applyAgentTaskAdd` runs inside a
 * `mutateActive` reducer (the write-queue critical section), so it is PURE — it
 * returns the observability payload as inert DATA instead of logging
 * (`no-slow-work-in-critical-section`). The caller emits `task.added_by_agent`
 * AFTER the mutation commits.
 */
export interface AgentTaskAddResult {
  execution: GraphWorkflowExecution;
  added: {
    executionId: string;
    contextId: string;
    taskId: string;
    title: string;
    instructionsLength: number;
  };
}

export class GraphWorkflowRuntimeEditValidationError extends GraphWorkflowValidationError {
  constructor(errors: WorkflowGraphValidationError[]) {
    super(errors, "Runtime edit validation failed");
    this.name = "GraphWorkflowRuntimeEditValidationError";
  }
}

export interface GraphWorkflowRuntimeEditServiceDeps {
  createTaskId(): string;
  now(): string;
}

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

function getContextTaskOrder(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .reduce((maxOrder, task) => Math.max(maxOrder, task.order), 0);
}

function getContextDefinition(
  execution: GraphWorkflowExecution,
  contextId: string,
) {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(`Execution context "${contextId}" was not found`);
  }

  return context;
}

function getContextTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
  index: ExecutionIndex = createExecutionIndex(execution.workingDefinition),
): GraphWorkflowTaskDefinition[] {
  return index.tasksByContext.get(contextId) ?? [];
}

function setContextTaskOrder(
  execution: GraphWorkflowExecution,
  contextId: string,
  orderedTaskIds: string[],
): void {
  const taskById = new Map(
    execution.workingDefinition.tasks.map((task) => [task.id, task]),
  );

  orderedTaskIds.forEach((taskId, index) => {
    const task = taskById.get(taskId);
    if (!task) {
      return;
    }

    task.order = index + 1;
    const taskState = execution.taskStates[taskId];
    if (taskState) {
      taskState.order = index + 1;
      taskState.contextId = contextId;
    }
  });
}

function syncContextState(
  execution: GraphWorkflowExecution,
  contextId: string,
): void {
  const contextState = execution.contextStates[contextId];
  if (!contextState) {
    return;
  }

  contextState.totalTaskCount = execution.workingDefinition.tasks.filter(
    (task) => task.contextId === contextId,
  ).length;
  contextState.completedTaskCount = countCompletedTasks(execution, contextId);
}

const defaultDeps: GraphWorkflowRuntimeEditServiceDeps = {
  createTaskId() {
    return `task-${randomUUID()}`;
  },
  now() {
    return new Date().toISOString();
  },
};

function countCompletedTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return execution.workingDefinition.tasks.filter((task) => {
    if (task.contextId !== contextId) {
      return false;
    }

    return execution.taskStates[task.id]?.status === "completed";
  }).length;
}

export function createGraphWorkflowRuntimeEditService(
  deps: Partial<GraphWorkflowRuntimeEditServiceDeps> = {},
) {
  const resolvedDeps = { ...defaultDeps, ...deps };

  function applyAgentTaskAdd(
    execution: GraphWorkflowExecution,
    contextId: string,
    task: AgentAddedTask,
  ): AgentTaskAddResult {
    if (execution.status !== "running") {
      throw new Error(
        "Agent task creation is allowed only while execution is running",
      );
    }

    if (!execution.activeContextIds.includes(contextId)) {
      throw new Error(
        `Agents can add tasks only to the currently executing context "${execution.activeContextIds[0] ?? null}"`,
      );
    }

    const context = getContextDefinition(execution, contextId);
    if (!context.mutability.allowAgentTaskAdd) {
      throw new Error(
        `Execution context "${contextId}" does not allow agent task creation`,
      );
    }

    const contextState = execution.contextStates[contextId];
    if (!contextState) {
      throw new Error(
        `Execution context "${contextId}" does not exist in runtime state`,
      );
    }

    if (contextState.status !== "running") {
      throw new Error(
        `Agent task creation is allowed only while context "${contextId}" is running`,
      );
    }

    // The lane-agent entry point is one `add-task` over the shared live-edit
    // core (doc 06 — one core, multiple entry points). The entry-point policy
    // above is enforced here; the core owns task placement and runtime-map
    // sync. `laneAgentContextId` lets the add bypass the
    // started-context quiescence gate (this context is running, active, and
    // `allowAgentTaskAdd` — all just checked) and stamps the task `source: agent`.
    // Pre-minting the id keeps parity with the prior slug-or-mint behavior and
    // gives us the id for logging; the core never mints for this path.
    const taskId = task.slug ?? resolvedDeps.createTaskId();
    const result = applyLiveExecutionEdits(
      execution,
      {
        operations: [
          {
            type: "add-task",
            id: taskId,
            contextId,
            title: task.title,
            instructions: task.instructions,
          },
        ],
      },
      laneAgentLiveEditDeps(resolvedDeps),
      { laneAgentContextId: contextId },
    );
    if (!result.ok) {
      throw new GraphWorkflowRuntimeEditValidationError(result.issues);
    }

    // Exactly one `liveRevision` increment per accepted mutation (doc 06, D4):
    // this lane-agent path owns its bump (the core never touches it; the
    // CLI/UI route owns its own bump on that path).
    const nextExecution: GraphWorkflowExecution = {
      ...result.execution,
      liveRevision: result.execution.liveRevision + 1,
    };

    // Pure: return the observability payload as DATA. The caller emits
    // `task.added_by_agent` (global + execution logs) AFTER the mutation
    // commits, so no logging I/O runs inside the write-queue critical section.
    return {
      execution: nextExecution,
      added: {
        executionId: execution.id,
        contextId,
        taskId,
        title: task.title,
        instructionsLength: task.instructions.length,
      },
    };
  }

  return {
    applyAgentTaskAdd,
  };
}

// ============================================================
// Live execution editing (docs/design/cc-cli/06)
// ============================================================
// One pure core, three entry points. `applyLiveExecutionEdits` mutates a running
// execution's resolved `workingDefinition` + runtime maps, gated by the lifecycle
// classifier (per-op preconditions) and the execution-frontier invariant (the
// post-batch safety net). The route bumps `liveRevision`; the core never does.

/**
 * The resolved (concrete) per-context config blocks — the shape a resolved
 * context carries minus its identity/prose. `add-context` seeds a new context's
 * config from either `configFromContextId`'s resolved context or these resolved
 * global defaults; explicit op fields override the base.
 */
export type ResolvedContextConfig = Pick<
  GraphWorkflowResolvedContext,
  | "implementer"
  | "contextValidator"
  | "scriptValidator"
  | "scriptValidatorSource"
  | "humanApprovalGate"
  | "askUserQuestions"
  | "mutability"
  | "circuitBreaker"
  | "iterationPolicy"
  | "planRepair"
> & {
  collaboration: NonNullable<GraphWorkflowResolvedContext["collaboration"]>;
  agentValidation: NonNullable<GraphWorkflowResolvedContext["agentValidation"]>;
};

/**
 * Injected capabilities for the pure core — method syntax for bivariant checking
 * (engineering-principles Deps rule). `createTaskId` mints slugs for id-less task
 * adds; `resolvedGlobalDefaults` supplies the `add-context` config base.
 */
export interface LiveEditDeps {
  createTaskId(): string;
  resolvedGlobalDefaults(): ResolvedContextConfig;
  /**
   * The target project's command-cost snapshot and global capacity. Validation
   * selections written by a live edit are checked here for unknown names and
   * oversized costs. Only consulted for validation-selection batches.
   */
  validationCommandPreflight(): ValidationCommandPreflight;
  /**
   * The snapshot for an assignment a live edit INTRODUCES.
   *
   * A live edit is a new authoring act, so an assignment arriving in an op has
   * never been resolved — unlike a dormant assignment being enabled, whose
   * bytes were seeded at start and are reused untouched. Sync by construction
   * like every other dep here: the async boundary resolves the library once per
   * request and hands the pure core a lookup. Throws on a reference the library
   * cannot resolve, which fails the edit rather than storing an assignment with
   * no bytes behind it.
   */
  snapshotFor(assignment: PlaceableAssignment): AgentProfileSnapshot;
  /** ISO timestamp source for `amend-charter` amendment-log entries. */
  now(): string;
  executionContract?: GraphExecutionContract;
}

export type LiveEditRejectionCode =
  | "frozen"
  | "requires_pause"
  | "region_locked"
  | "spec_grouping_frozen"
  | typeof VALIDATION_COST_EXCEEDS_LIMIT_CODE
  | "invalid_edit";

export type ApplyLiveExecutionEditsResult =
  | {
      ok: true;
      execution: GraphWorkflowExecution;
      affectedContextIds: string[];
    }
  | {
      ok: false;
      code: LiveEditRejectionCode;
      issues: WorkflowGraphValidationError[];
      instruction?: string;
    };

/**
 * Options carried alongside the request. `laneAgentContextId` marks the trusted
 * lane-agent `add_task` entry point (doc 06): an add-task targeting that context
 * bypasses the started-context quiescence gate — the wrapper has already verified
 * the context is running, active, and `mutability.allowAgentTaskAdd`. Absent for
 * the operator (CLI/UI) entry points, which honor the full quiescence policy.
 */
/** The ops the audited amendment may carry — additive, and nothing else. */
const ADDITIVE_AMENDMENT_OP_TYPES: ReadonlySet<
  WorkflowLiveEditOperation["type"]
> = new Set(["add-context", "add-task", "add-edge"]);

export interface LiveEditOptions {
  laneAgentContextId?: string;
  /**
   * The audited amendment entry point (`cctl workflow live amend`), which
   * carries add-context/add-task/add-edge and nothing else. Structural additions
   * may extend the future graph while the run is active. Task additions still
   * honor the target context's own mutability gate, and the frozen-past and
   * frontier checks remain unchanged.
   */
  additiveAmendment?: boolean;
  /** Launch-snapshotted DPA config used instead of mutable global defaults. */
  amendmentContextSeed?: ResolvedContextConfig;
  /**
   * The narrow running-time structural exception (D4 R6.5). Structural edits
   * are pause-only for operators, and stay that way: exactly two SERVER-DERIVED
   * paths may APPEND to a running graph — lane-agent expansion and engine loop
   * unrolling. Absent for every client-reachable entry point (the CLI/UI
   * runtime-edits route, the plan-repair supervisor), which keeps the full
   * quiescence policy.
   *
   * The exemption covers only the two additive ops (`add-context`, `add-edge`);
   * `remove-context`, `remove-edge` and `update-edge` remain quiescence-gated
   * for every caller, because reshaping or deleting existing structure under a
   * live scheduler is not what either exception needs.
   */
  structuralSource?: "lane-agent-expansion" | "loop-unrolling";
  /**
   * Server-derived authority for `materialize-loop-pass` (D4 R9). Set ONLY by
   * the scheduler's loop-settlement transaction, which has already decided the
   * pass against the banked exit capture under the ledger's slot reservation.
   * No client-facing entry point passes it, so the op is unreachable from HTTP,
   * the CLI and the plan-repair supervisor even though it shares their union.
   */
  engineLoopSettlement?: boolean;
}

/**
 * Build the pure core's deps for the lane-agent `add_task` entry point. That
 * path only ever emits a single `add-task` op, which never seeds context config
 * or enables a script validator, so the config-seeding deps are unreachable and
 * throw if ever called (fail-safe: a future op routed through this wrapper that
 * needs them is a bug, not a silent mis-seed).
 */
function laneAgentLiveEditDeps(
  deps: GraphWorkflowRuntimeEditServiceDeps,
): LiveEditDeps {
  return {
    createTaskId: deps.createTaskId,
    resolvedGlobalDefaults() {
      throw new Error(
        "lane-agent add_task does not seed context config from global defaults",
      );
    },
    validationCommandPreflight() {
      throw new Error(
        "lane-agent add_task does not edit validation command selections",
      );
    },
    snapshotFor() {
      throw new Error(
        "lane-agent add_task does not introduce an agent assignment",
      );
    },
    now() {
      throw new Error("lane-agent add_task does not amend the charter");
    },
  };
}

interface LiveEditRejection {
  code: LiveEditRejectionCode;
  issues: WorkflowGraphValidationError[];
}

interface LiveEditOpContext {
  quiescent: boolean;
  additiveAmendment: boolean;
  amendmentContextSeed: ResolvedContextConfig | undefined;
  deps: LiveEditDeps;
  affectedContextIds: Set<string>;
  validationTouchedContextIds: Set<string>;
  /**
   * Set by `update-lane-merge-validation` so the frontier check preflights
   * the (workflow-scope, context-free) lane-merge selection — the per-context
   * `validationTouchedContextIds` scoping cannot see it.
   */
  laneMergeTouched: boolean;
  /**
   * Set by any op that establishes or rewrites a placement, so the frontier
   * re-runs the placement grammar and lane-disjointness checks. A boolean rather
   * than a context set because the pairwise refusal names the LOWER-indexed
   * member of the colliding pair, which need not be the context the batch
   * touched — filtering by touched id would drop exactly the collisions this
   * exists to catch. Gating on it at all keeps an unrelated edit from tripping
   * over a legacy execution's pre-placement state.
   */
  placementTouched: boolean;
  /**
   * Contexts this batch itself created. A task added into one of them is the
   * initiating agent's own work (provenance `agent`), and the append-only
   * structural exception is scoped by it.
   */
  batchCreatedContextIds: Set<string>;
  laneAgentContextId: string | undefined;
  structuralSource: LiveEditOptions["structuralSource"];
  engineLoopSettlement: boolean;
  /**
   * Audit attribution from the request (doc 06 D15), recorded on amendment-log
   * entries. Absent only on the lane-agent `add_task` wrapper path, which never
   * emits an `amend-charter` op.
   */
  source: LiveEditSource | undefined;
}

// The internal source union is WIDER than the HTTP schema's: `plan-repair` is
// server-derived by the D1 repair supervisor (docs/design/cc-cli/08), never
// accepted from a client — same trust model as the lane-agent wrapper.
export type LiveEditSource = CharterAmendment["source"];

function presentLiveFieldPaths(
  prefix: DefinitionPath,
  value: Record<string, unknown>,
  fields: readonly string[],
): DefinitionPath[] {
  return fields
    .filter((field) => value[field] !== undefined)
    .map((field) => [...prefix, field]);
}

function liveContextTaskOrderPaths(
  execution: GraphWorkflowExecution,
  contextId: string,
): DefinitionPath[] {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .map((task) => ["tasks", task.id, "order"]);
}

function liveEditTouchedPaths(
  execution: GraphWorkflowExecution,
  operation: WorkflowLiveEditOperation,
): DefinitionPath[] {
  const value = operation as unknown as Record<string, unknown>;

  switch (operation.type) {
    case "amend-charter":
      return presentLiveFieldPaths(["charter"], value, [
        ...CHARTER_CONTENT_EDIT_FIELDS,
      ]);
    case "update-context":
      return presentLiveFieldPaths(
        ["executionContexts", operation.contextId],
        value,
        [
          "title",
          "description",
          "acceptanceCriteria",
          "outputSchema",
          "routing",
          "placement",
          "implementer",
          "contextValidator",
          "scriptValidator",
          "humanApprovalGate",
          "askUserQuestions",
          "iterationPolicy",
          "circuitBreaker",
          "mutability",
          "planRepair",
          "collaboration",
          "agentValidation",
        ],
      );
    case "add-context":
      return [["executionContexts", operation.id]];
    case "remove-context": {
      const paths: DefinitionPath[] = [
        ["executionContexts", operation.contextId],
      ];
      for (const task of execution.workingDefinition.tasks) {
        if (task.contextId === operation.contextId) {
          paths.push(["tasks", task.id]);
        }
      }
      for (const edge of execution.workingDefinition.edges) {
        if (
          edge.sourceContextId === operation.contextId ||
          edge.targetContextId === operation.contextId
        ) {
          paths.push(["edges", edge.id]);
        }
      }
      return paths;
    }
    case "add-task":
      return [
        ["tasks", operation.id ?? "new"],
        ...liveContextTaskOrderPaths(execution, operation.contextId),
      ];
    case "update-task":
      return presentLiveFieldPaths(["tasks", operation.taskId], value, [
        "title",
        "instructions",
        "metadata",
      ]);
    case "remove-task": {
      const task = execution.workingDefinition.tasks.find(
        (entry) => entry.id === operation.taskId,
      );
      return [
        ["tasks", operation.taskId],
        ...(task ? liveContextTaskOrderPaths(execution, task.contextId) : []),
      ];
    }
    case "move-task": {
      const task = execution.workingDefinition.tasks.find(
        (entry) => entry.id === operation.taskId,
      );
      return [
        ["tasks", operation.taskId, "contextId"],
        ["tasks", operation.taskId, "order"],
        ...(task ? liveContextTaskOrderPaths(execution, task.contextId) : []),
        ...liveContextTaskOrderPaths(execution, operation.targetContextId),
      ];
    }
    case "reorder-tasks":
      return liveContextTaskOrderPaths(execution, operation.contextId);
    case "add-edge":
      return [
        [
          "edges",
          operation.id ??
            mintLiveEdgeId(
              execution.workingDefinition.edges,
              operation.sourceContextId,
              operation.targetContextId,
            ),
        ],
      ];
    case "update-edge":
      return [["edges", operation.edgeId, "when"]];
    case "remove-edge": {
      const matches = matchLiveEdges(
        execution.workingDefinition.edges,
        operation,
      );
      return matches.length > 0
        ? matches.map((edge): DefinitionPath => ["edges", edge.id])
        : [["edges", "unknown"]];
    }
    case "update-lane-merge-validation":
      return [["laneMergeValidation"]];
    // The loop-control ops address the GROUP, not a scheduled node. Naming the
    // group's own paths keeps them lockable the same way every other edit is.
    case "raise-loop-max-passes":
      return [["loopGroups", operation.loopGroupId, "maxPasses"]];
    case "amend-loop-predicate":
      return [["loopGroups", operation.loopGroupId, "until"]];
    case "edit-loop-template":
      return [["loopGroups", operation.loopGroupId, "template"]];
    case "materialize-loop-pass":
      // Every node the op writes is BRAND NEW, in the reserved pass-instance
      // namespace no author may inhabit, so no locked region can cover one.
      // Naming them anyway keeps the touch report honest for future locks.
      return (
        execution.workingDefinition.loopGroups
          ?.find((group) => group.id === operation.loopGroupId)
          ?.template.contexts.map(
            (context): DefinitionPath => [
              "executionContexts",
              loopInstanceId(operation.loopGroupId, operation.pass, context.id),
            ],
          ) ?? []
      );
  }
}

type LiveContextConfigOp =
  | Extract<WorkflowLiveEditOperation, { type: "update-context" }>
  | Extract<WorkflowLiveEditOperation, { type: "add-context" }>;

/** The request shape both the direct and the staged entry points accept. */
export type LiveEditCoreRequest = Pick<
  WorkflowLiveEditRequest,
  "operations"
> & {
  source?: LiveEditSource;
};

/** The one rejection shape every live-edit entry point reports. */
interface LiveEditBatchRejection {
  ok: false;
  code: LiveEditRejectionCode;
  issues: WorkflowGraphValidationError[];
  instruction?: string;
}

type LiveEditOpsResult =
  | {
      ok: true;
      next: GraphWorkflowExecution;
      opContext: LiveEditOpContext;
    }
  | LiveEditBatchRejection;

type ValidatedLiveEditBatch =
  | {
      ok: true;
      execution: GraphWorkflowExecution;
      opContext: LiveEditOpContext;
    }
  | LiveEditBatchRejection;

/**
 * The op-application half of the live-edit core, shared by the direct apply and
 * the staged finalize. Clones the input, runs the per-op gates (locked regions,
 * execution contract, per-op editability) and the ops themselves in order, then
 * re-syncs the derived runtime projections — route-control revisions and the
 * lane plan. Everything here is either O(payload) or a projection over the
 * definition; the O(total-state) work (the frontier invariant and the whole-
 * execution re-parse) lives in the caller, which is what lets `finalize` skip it
 * under the write-queue lock.
 */
function runLiveEditOps(
  execution: GraphWorkflowExecution,
  request: LiveEditCoreRequest,
  deps: LiveEditDeps,
  options: LiveEditOptions,
): LiveEditOpsResult {
  const editability = classifyExecutionEditability(execution);
  // Fail-safe: the amendment bypass is only sound because the operand schema
  // admits nothing but additions. A non-additive op arriving under the flag
  // would be a wiring bug, so refuse rather than widen the bypass silently.
  const additiveAmendment =
    options.additiveAmendment === true &&
    request.operations.every((operation) =>
      ADDITIVE_AMENDMENT_OP_TYPES.has(operation.type),
    );
  const quiescent = editability.kind === "editable" && editability.quiescent;

  // R11.1 — loop composition beats every other verdict on an agent-initiated
  // request: a payload that declares loops, or an expansion from inside a
  // running loop body, is refused for WHAT it asks rather than for when it
  // asked, so pausing the execution must not turn it into an accepted edit.
  const expansionRefusal = checkExpansionLoopRestrictions(
    execution,
    request,
    options.laneAgentContextId,
  );
  if (expansionRefusal) {
    return {
      ok: false,
      code: expansionRefusal.code,
      issues: expansionRefusal.issues,
    };
  }

  const next = cloneExecution(execution);
  const affectedContextIds = new Set<string>();
  const validationTouchedContextIds = new Set<string>();

  const opContext: LiveEditOpContext = {
    quiescent,
    additiveAmendment,
    amendmentContextSeed: options.amendmentContextSeed,
    deps,
    affectedContextIds,
    validationTouchedContextIds,
    laneMergeTouched: false,
    placementTouched: false,
    batchCreatedContextIds: new Set<string>(),
    laneAgentContextId: options.laneAgentContextId,
    structuralSource: options.structuralSource,
    engineLoopSettlement: options.engineLoopSettlement === true,
    source: request.source,
  };

  for (let index = 0; index < request.operations.length; index += 1) {
    const operation = request.operations[index]!;
    const locked = additiveAmendment
      ? null
      : findLockedRegionTouch(
          next.workingDefinition,
          liveEditTouchedPaths(next, operation),
        );
    if (locked) {
      return {
        ok: false,
        code: "region_locked",
        issues: [
          liveEditIssue("region_locked", regionLockedMessage(locked), index, {
            field: locked.lockedPath,
          }),
        ],
        instruction: `${regionLockedInstruction(locked)} This refusal applies to active execution "${next.id}".`,
      };
    }
    const contractDecision = deps.executionContract?.validateLiveEdit(
      next,
      operation,
    );
    if (contractDecision !== undefined && !contractDecision.ok) {
      return {
        ok: false,
        code:
          contractDecision.code === "spec_grouping_frozen"
            ? "spec_grouping_frozen"
            : "invalid_edit",
        issues: contractDecision.issues.map((issue) => ({
          ...issue,
          operationIndex: issue.operationIndex ?? index,
        })),
        instruction: contractDecision.instruction,
      };
    }
    const rejection = applyLiveEditOperation(next, operation, index, opContext);
    if (rejection) {
      return { ok: false, code: rejection.code, issues: rejection.issues };
    }
  }

  // The route-control revision of every source whose outgoing conditional edges
  // or routing policy changed, derived from the before/after definitions rather
  // than from per-op bookkeeping. Placing it HERE — on the shared mutation core,
  // after the ops and before the frontier — is what makes the closed bump set of
  // decision D2 hold for every writer that rides this seam, present and future.
  next.routeControlRevisions = bumpRouteControlRevisions(
    execution.routeControlRevisions,
    execution.workingDefinition,
    next.workingDefinition,
  );

  return { ok: true, next, opContext };
}

/**
 * The full core: ops, then the execution-frontier invariant (the post-batch
 * safety net), then the whole-execution re-parse. The direct apply and the
 * staged prepare are the same validation by construction because both are this
 * function; only what they do with the accepted result differs.
 */
function validateLiveEditBatch(
  execution: GraphWorkflowExecution,
  request: LiveEditCoreRequest,
  deps: LiveEditDeps,
  options: LiveEditOptions,
): ValidatedLiveEditBatch {
  const applied = runLiveEditOps(execution, request, deps, options);
  if (!applied.ok) return applied;

  const { next, opContext } = applied;
  const frontier = checkLiveEditFrontier(execution, next, opContext);
  if (frontier) {
    return { ok: false, code: frontier.code, issues: frontier.issues };
  }

  const parsed = graphWorkflowExecutionSchema.safeParse(next);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_edit",
      issues: parsed.error.issues.map(zodIssueToValidationError),
    };
  }

  return { ok: true, execution: parsed.data, opContext };
}

/**
 * Apply an ordered, atomic batch of live edits to a launched execution. Pure —
 * clones the input, applies ops sequentially (so a later op sees an earlier
 * one's result), and rejects the whole batch on the first failing op. On success
 * the runtime maps are re-synced and the whole execution is
 * re-parsed. `liveRevision` is NOT touched here (the route/wrapper owns exactly
 * one increment per accepted mutation).
 */
export function applyLiveExecutionEdits(
  execution: GraphWorkflowExecution,
  request: LiveEditCoreRequest,
  deps: LiveEditDeps,
  options: LiveEditOptions = {},
): ApplyLiveExecutionEditsResult {
  const validated = validateLiveEditBatch(execution, request, deps, options);
  if (!validated.ok) return validated;

  return {
    ok: true,
    execution: validated.execution,
    affectedContextIds: Array.from(validated.opContext.affectedContextIds),
  };
}

// ============================================================
// The prepare/finalize mutation staging seam (D4, decision D5)
// ============================================================
// A caller that cannot do its validation inside the write queue — expansion and
// loop settlement both have to reason about the whole graph — stages its
// mutation in two halves. `prepareLiveExecutionEdits` runs the full core (ops +
// frontier invariant + whole-execution parse) against a snapshot read OUTSIDE
// the lock, then reduces the accepted result to a DELTA: the exact per-key,
// per-field effect the ops had, plus the preconditions that effect was validated
// under. `finalizePreparedEdits` runs inside the reducer and does only O(delta)
// work — check the preconditions, merge the delta onto whatever committed since.
// It never clones, never walks the definition, and never re-validates; anything
// that would need a full traversal signals `reprepare` instead, which the caller
// answers by re-preparing outside the lock.
//
// The fence is the repository-owned `executionStateRevision`, which advances on
// every committed mutation. `liveRevision` cannot serve: a scheduler tick moves
// no live-edit field, so a whole-state splice guarded by `liveRevision` alone
// would silently roll that tick back.

/**
 * Top-level execution keys a live-edit batch is allowed to change. The delta
 * builder diffs EVERY key and routes each changed one through this table, so a
 * future op that starts writing somewhere else cannot be silently mis-merged: an
 * unlisted key lands in `unmergeableKeys` and forces a reprepare.
 *
 * `contextStates` and `taskStates` are the two open maps the scheduler also
 * writes, so they merge entry-by-entry and field-by-field. The rest install
 * WHOLESALE — an overwrite, valid only onto the value the batch was validated
 * against — which is exactly what `structuralRevision` fences.
 */
const WHOLESALE_LIVE_EDIT_KEYS = STRUCTURAL_REVISION_KEYS;

type WholesaleLiveEditKey = StructuralRevisionKey;

const MERGED_STATE_MAP_KEYS = ["contextStates", "taskStates"] as const;

/**
 * The field-scoped effect on one open state map. `changed` records only the
 * fields the ops actually rewrote, together with the base values they were
 * computed from, so merging preserves everything an interleaved commit wrote to
 * the same entry and a genuine write-write collision is detectable.
 */
interface StateMapDelta<T> {
  readonly added: Readonly<Record<string, T>>;
  readonly removed: readonly string[];
  readonly changed: Readonly<
    Record<string, { set: Partial<T>; base: Partial<T> }>
  >;
}

/**
 * The ops' effect, reduced at prepare to something installable in O(delta).
 * Everything here is derived by diffing the validated result against the
 * snapshot, never by trusting per-op bookkeeping.
 */
interface PreparedInstallDelta {
  readonly wholesale: Readonly<
    Partial<Pick<GraphWorkflowExecution, WholesaleLiveEditKey>>
  >;
  readonly contextStates: StateMapDelta<GraphWorkflowExecutionContextState>;
  readonly taskStates: StateMapDelta<GraphWorkflowTaskState>;
  /** Changed keys this seam has no merge rule for — always forces a reprepare. */
  readonly unmergeableKeys: readonly string[];
}

/**
 * The prepare-time evidence the batch's validation rests on, scoped to the
 * delta's own footprint. Checking these at finalize is equivalent to re-running
 * the frozen-past and runtime-map invariants, because every context and task
 * OUTSIDE the footprint is byte-identical between `current` and the installed
 * result and so passes those invariants trivially.
 */
interface PreparedFrontierWitness {
  /**
   * The fence for every wholesale key at once (R6's "definition fingerprint").
   * The repository DERIVES it by comparison on each commit, so an unchanged
   * value proves the graph, lane plan, charter and route revisions are all
   * byte-identical to the ones the batch validated against — including when the
   * writer that moved them never heard of this seam.
   */
  readonly structuralRevision: number;
  /**
   * The live-edit concurrency token. Subsumed by `structuralRevision` for
   * erasure purposes and kept because R6 names it: it distinguishes "another
   * live edit landed" from "the scheduler moved the graph", which is worth
   * having in a reprepare loop's diagnostics.
   */
  readonly liveRevision: number;
  /** The execution-level gate the per-op quiescence checks ran under. */
  readonly editability: string;
  /**
   * Lifecycle of every context the delta's footprint covers, each banked with
   * the definition-derived pin needed to re-classify it without a scan.
   */
  readonly contextLifecycles: Readonly<
    Record<
      string,
      { lifecycle: ContextLifecycle; pin: ContextInitialStatePin | null }
    >
  >;
  /** Lock state of every task the delta's definition footprint covers. */
  readonly taskLocks: Readonly<Record<string, boolean>>;
  /**
   * Every lane the delta makes a context ARRIVE on, pinned so closure can be
   * re-derived inside the lock (R10, decision D11).
   *
   * `structuralRevision` cannot stand in for this one. A lane closes when a join
   * intent names it as a source, and planning a join writes `joins` and the
   * downstream context's `joinId` — never `workingDefinition` — so the fence
   * that covers every other prepare-time decision does not move. Without this,
   * a member validated against an open lane installs onto a lane whose content
   * was already promised to a merge it will miss.
   */
  readonly laneArrivals: readonly PreparedLaneArrival[];
}

/** One context's arrival onto a lane, with the evidence to re-check its closure. */
interface PreparedLaneArrival {
  readonly contextId: string;
  readonly pin: LaneClosurePin;
}

/**
 * Why a prepared batch cannot be installed as-is and must be re-prepared
 * outside the lock. A reprepare is not a rejection: the batch may well be
 * accepted on the next attempt against fresher state.
 */
export type PreparedEditsRepreparReason =
  /**
   * A wholesale key moved. One kind for all five: telling them apart would mean
   * comparing the structures, which is the cost `structuralRevision` exists to
   * avoid — and the answer is the same either way, reprepare.
   */
  | { kind: "structural_changed" }
  | { kind: "editability_changed" }
  | { kind: "context_lifecycle_changed"; contextId: string }
  | { kind: "task_lock_changed"; taskId: string }
  | { kind: "lane_closed"; laneId: string; contextId: string }
  | { kind: "concurrent_write"; field: string }
  | { kind: "unmergeable_change"; field: string };

/**
 * The staging token. Deeply frozen — the state it carries was validated at
 * prepare and the unchanged-fence path installs it verbatim, so it must not be
 * possible to edit a cycle (or anything else the Kahn check would have refused)
 * into it after validation. In-memory only: prepare and finalize sit on either
 * side of one write-queue entry, in the same process.
 */
export interface PreparedLiveEdits {
  readonly executionId: string;
  /** The repository fence read with the snapshot prepare validated. */
  readonly baseStateRevision: number;
  /** The validated whole state, installed verbatim when the fence held. */
  readonly execution: GraphWorkflowExecution;
  readonly affectedContextIds: readonly string[];
  readonly delta: PreparedInstallDelta;
  readonly witness: PreparedFrontierWitness;
}

export type PrepareLiveExecutionEditsResult =
  | { ok: true; prepared: PreparedLiveEdits }
  | {
      ok: false;
      code: LiveEditRejectionCode;
      issues: WorkflowGraphValidationError[];
      instruction?: string;
    };

export type FinalizePreparedEditsRefusalCode =
  | "execution_mismatch"
  | "pending_halt";

export type FinalizePreparedEditsResult =
  | {
      ok: true;
      /** `spliced` = fence unchanged; `merged` = delta applied forward. */
      install: "spliced" | "merged";
      execution: GraphWorkflowExecution;
      affectedContextIds: readonly string[];
    }
  | { ok: false; outcome: "reprepare"; reason: PreparedEditsRepreparReason }
  | {
      ok: false;
      outcome: "refused";
      code: FinalizePreparedEditsRefusalCode;
      issues: WorkflowGraphValidationError[];
    };

/**
 * Freeze a validated value and everything reachable from it. Runs at prepare,
 * outside the lock, and is what makes "the installed state is the validated
 * state" a property of the type rather than a promise: a caller that tries to
 * edit the prepared execution throws (ES modules are strict mode) instead of
 * smuggling an unvalidated graph past the fence.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return value;
}

/** The keys of `next` whose value differs from `base`, by deep comparison. */
function changedFields<T extends object>(base: T, next: T): (keyof T)[] {
  const keys = new Set<keyof T>([
    ...(Object.keys(base) as (keyof T)[]),
    ...(Object.keys(next) as (keyof T)[]),
  ]);
  return Array.from(keys).filter(
    (key) => !isDeepStrictEqual(base[key], next[key]),
  );
}

function buildStateMapDelta<T extends object>(
  base: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>,
): StateMapDelta<T> {
  const added: Record<string, T> = {};
  const removed: string[] = [];
  const changed: Record<string, { set: Partial<T>; base: Partial<T> }> = {};

  for (const [id, entry] of Object.entries(next)) {
    const before = base[id];
    if (before === undefined) {
      added[id] = entry;
      continue;
    }
    const fields = changedFields(before, entry);
    if (fields.length === 0) continue;
    const set: Partial<T> = {};
    const from: Partial<T> = {};
    for (const field of fields) {
      set[field] = entry[field];
      from[field] = before[field];
    }
    changed[id] = { set, base: from };
  }
  for (const id of Object.keys(base)) {
    if (!(id in next)) removed.push(id);
  }

  return { added, removed, changed };
}

/**
 * Reduce the validated result to its installable delta. A full diff, run at
 * prepare where a full pass costs nothing, so finalize never has to take one.
 */
function buildInstallDelta(
  base: GraphWorkflowExecution,
  next: GraphWorkflowExecution,
): PreparedInstallDelta {
  const wholesale: Partial<Pick<GraphWorkflowExecution, WholesaleLiveEditKey>> =
    {};
  const unmergeableKeys: string[] = [];

  for (const key of changedFields(base, next)) {
    if ((MERGED_STATE_MAP_KEYS as readonly string[]).includes(key)) continue;
    const wholesaleKey = WHOLESALE_LIVE_EDIT_KEYS.find(
      (candidate) => candidate === key,
    );
    if (wholesaleKey === undefined) {
      unmergeableKeys.push(String(key));
      continue;
    }
    Object.assign(wholesale, { [wholesaleKey]: next[wholesaleKey] });
  }

  return {
    wholesale,
    contextStates: buildStateMapDelta(base.contextStates, next.contextStates),
    taskStates: buildStateMapDelta(base.taskStates, next.taskStates),
    unmergeableKeys,
  };
}

/**
 * The contexts and tasks whose runtime state the batch's validation depended on
 * — every one whose DEFINITION entry the batch changed (its prose, config, or
 * task set), every one whose incoming edges it changed, and every one whose
 * runtime-state entry it touched. This is exactly the set `checkFrozenPastUnchanged`
 * would have flagged, so pinning their lifecycles at prepare and re-checking
 * them at finalize is equivalent to re-running the invariant — without the walk.
 */
function collectDeltaFootprint(
  base: GraphWorkflowExecution,
  next: GraphWorkflowExecution,
  delta: PreparedInstallDelta,
): { contextIds: Set<string>; taskIds: Set<string> } {
  const contextIds = new Set<string>([
    ...Object.keys(delta.contextStates.added),
    ...delta.contextStates.removed,
    ...Object.keys(delta.contextStates.changed),
  ]);
  const taskIds = new Set<string>([
    ...Object.keys(delta.taskStates.added),
    ...delta.taskStates.removed,
    ...Object.keys(delta.taskStates.changed),
  ]);

  const nextContexts = new Map(
    next.workingDefinition.executionContexts.map((entry) => [entry.id, entry]),
  );
  for (const context of base.workingDefinition.executionContexts) {
    if (!isDeepStrictEqual(context, nextContexts.get(context.id))) {
      contextIds.add(context.id);
    }
    nextContexts.delete(context.id);
  }
  for (const id of nextContexts.keys()) contextIds.add(id);

  const nextTasks = new Map(
    next.workingDefinition.tasks.map((task) => [task.id, task]),
  );
  for (const task of base.workingDefinition.tasks) {
    if (!isDeepStrictEqual(task, nextTasks.get(task.id))) {
      taskIds.add(task.id);
      contextIds.add(task.contextId);
    }
    nextTasks.delete(task.id);
  }
  for (const [id, task] of nextTasks) {
    taskIds.add(id);
    contextIds.add(task.contextId);
  }

  // A context whose incoming edges moved is protected by the same invariant,
  // so both endpoints of every changed edge join the footprint.
  const baseEdges = new Map(
    base.workingDefinition.edges.map((edge) => [edge.id, edge]),
  );
  const nextEdges = new Map(
    next.workingDefinition.edges.map((edge) => [edge.id, edge]),
  );
  for (const [id, edge] of [...baseEdges, ...nextEdges]) {
    if (isDeepStrictEqual(baseEdges.get(id), nextEdges.get(id))) continue;
    contextIds.add(edge.sourceContextId);
    contextIds.add(edge.targetContextId);
  }

  return { contextIds, taskIds };
}

/**
 * Every context the batch places on a lane it was not already on — a new
 * context, or one whose placement moved. DERIVED by diffing the validated result
 * against the snapshot, so it is exactly the set {@link refuseClosedLaneArrival}
 * gated at validation: same-lane residents are not arrivals, and a lane's
 * closure has never applied to the members it already holds.
 */
function collectLaneArrivals(
  base: GraphWorkflowExecution,
  next: GraphWorkflowExecution,
): PreparedLaneArrival[] {
  const baseLaneByContext = new Map(
    base.workingDefinition.executionContexts.map((context) => [
      context.id,
      context.placement.lane,
    ]),
  );

  // Keyed by lane, not by context: closure is a property of the lane, and a
  // fan-out placing eight readers on one group lane asks the same question eight
  // times. The first arrival's id rides along for the reprepare diagnostic.
  const arrivals = new Map<string, PreparedLaneArrival>();
  for (const context of next.workingDefinition.executionContexts) {
    const before = baseLaneByContext.get(context.id);
    const lane = context.placement.lane;
    const laneId = executionLaneIdFor(lane);
    if (before !== undefined && executionLaneIdFor(before) === laneId) continue;
    if (arrivals.has(laneId)) continue;
    arrivals.set(laneId, {
      contextId: context.id,
      pin: pinLaneClosure(base, lane),
    });
  }
  return Array.from(arrivals.values());
}

function describeEditability(execution: GraphWorkflowExecution): string {
  const editability = classifyExecutionEditability(execution);
  return editability.kind === "editable"
    ? `editable:${editability.quiescent ? "quiescent" : "running"}`
    : `not-editable:${editability.reason}`;
}

function captureFrontierWitness(
  base: GraphWorkflowExecution,
  next: GraphWorkflowExecution,
  delta: PreparedInstallDelta,
): PreparedFrontierWitness {
  const footprint = collectDeltaFootprint(base, next, delta);

  const contextLifecycles: Record<
    string,
    { lifecycle: ContextLifecycle; pin: ContextInitialStatePin | null }
  > = {};
  for (const contextId of footprint.contextIds) {
    // Pinned against the BASE definition — the one the batch was validated
    // against, and the one `liveRevision` fences at finalize.
    const pin = pinContextInitialState(base, contextId);
    contextLifecycles[contextId] = {
      lifecycle: classifyContextLifecycleFromPin(base, contextId, pin),
      pin,
    };
  }
  const taskLocks: Record<string, boolean> = {};
  for (const taskId of footprint.taskIds) {
    taskLocks[taskId] = isLiveTaskLocked(base, taskId);
  }

  return {
    structuralRevision: base.structuralRevision,
    liveRevision: base.liveRevision,
    editability: describeEditability(base),
    contextLifecycles,
    taskLocks,
    laneArrivals: collectLaneArrivals(base, next),
  };
}

/**
 * Stage a live-edit batch: run the full core against a snapshot, then bank the
 * validated state, its installable delta, and the preconditions that delta was
 * validated under. Rejects exactly as {@link applyLiveExecutionEdits} does — a
 * batch that cannot be prepared never reaches the lock.
 */
export function prepareLiveExecutionEdits(
  execution: GraphWorkflowExecution,
  request: LiveEditCoreRequest,
  deps: LiveEditDeps,
  options: LiveEditOptions = {},
): PrepareLiveExecutionEditsResult {
  const validated = validateLiveEditBatch(execution, request, deps, options);
  if (!validated.ok) return validated;

  const delta = buildInstallDelta(execution, validated.execution);

  return {
    ok: true,
    prepared: deepFreeze({
      executionId: execution.id,
      baseStateRevision: execution.executionStateRevision,
      execution: validated.execution,
      affectedContextIds: Array.from(validated.opContext.affectedContextIds),
      delta,
      witness: captureFrontierWitness(execution, validated.execution, delta),
    }),
  };
}

/**
 * Apply one state map's delta IN PLACE, touching only the entries the delta
 * names. Rebuilding the map instead — even a single `{...current}` spread — is
 * O(every context in the execution) inside the write queue, which is the cost
 * the staging seam exists to avoid. The target is the reducer's own private
 * clone (see {@link finalizePreparedEdits}), so mutating it is safe.
 */
function applyStateMapDelta<T extends object>(
  target: Record<string, T>,
  delta: StateMapDelta<T>,
): void {
  for (const id of delta.removed) {
    delete target[id];
  }
  for (const [id, entry] of Object.entries(delta.added)) {
    // Shallow copy: the prepared token is deeply frozen, and a frozen entry in a
    // map the reducer may still write to is a trap. O(one entry's fields).
    target[id] = { ...entry };
  }
  for (const [id, change] of Object.entries(delta.changed)) {
    const existing = target[id];
    if (existing === undefined) continue;
    Object.assign(existing, change.set);
  }
}

/**
 * Check that every precondition the delta was validated under still holds.
 * O(delta): one scalar comparison per fenced counter, one lifecycle
 * classification per footprint context, one lock read per footprint task, and
 * one comparison per field the delta rewrites. Nothing here walks the graph or
 * the runtime maps.
 */
function checkDeltaPreconditions(
  current: GraphWorkflowExecution,
  prepared: PreparedLiveEdits,
): PreparedEditsRepreparReason | null {
  const { delta, witness } = prepared;

  const unmergeable = delta.unmergeableKeys[0];
  if (unmergeable !== undefined) {
    return { kind: "unmergeable_change", field: unmergeable };
  }

  // One scalar covers every wholesale key. Because the repository derives it by
  // comparing the values, this catches a definition write from a writer that
  // moved no live-edit field — the script-validator remediation append is the
  // production case — which a `liveRevision` check would wave through and the
  // wholesale install would then erase.
  if (current.structuralRevision !== witness.structuralRevision) {
    return { kind: "structural_changed" };
  }
  if (current.liveRevision !== witness.liveRevision) {
    return { kind: "structural_changed" };
  }
  if (describeEditability(current) !== witness.editability) {
    return { kind: "editability_changed" };
  }

  for (const [contextId, pinned] of Object.entries(witness.contextLifecycles)) {
    if (
      classifyContextLifecycleFromPin(current, contextId, pinned.pin) !==
      pinned.lifecycle
    ) {
      return { kind: "context_lifecycle_changed", contextId };
    }
  }
  for (const [taskId, locked] of Object.entries(witness.taskLocks)) {
    if (isLiveTaskLocked(current, taskId) !== locked) {
      return { kind: "task_lock_changed", taskId };
    }
  }

  // Re-derived rather than fenced by a counter: no revision moves when a join
  // intent freezes a lane, so this is the only evidence that the lane the batch
  // validated against still accepts members. Ordered after the structural check
  // so the pins — whose loop membership is definition-derived — are known to
  // describe the definition `current` actually carries. O(arrivals × joins);
  // both are payload-sized, and nothing here walks the graph.
  for (const { contextId, pin } of witness.laneArrivals) {
    if (laneClosureFromPin(current, pin) !== null) {
      return { kind: "lane_closed", laneId: pin.laneId, contextId };
    }
  }

  // No per-key comparison of the wholesale values: `structuralRevision` above
  // fences all of them at once in O(1). Comparing them here — the lane plan and
  // the charter are whole structures — would be the total-state work this seam
  // exists to keep outside the write queue.

  for (const [mapKey, mapDelta] of [
    ["contextStates", delta.contextStates],
    ["taskStates", delta.taskStates],
  ] as const) {
    const currentMap: Readonly<Record<string, object>> = current[mapKey];
    for (const id of Object.keys(mapDelta.added)) {
      if (id in currentMap) {
        return { kind: "concurrent_write", field: `${mapKey}.${id}` };
      }
    }
    for (const id of mapDelta.removed) {
      if (!(id in currentMap)) {
        return { kind: "concurrent_write", field: `${mapKey}.${id}` };
      }
    }
    for (const [id, change] of Object.entries(mapDelta.changed)) {
      const existing = currentMap[id];
      if (existing === undefined) {
        return { kind: "concurrent_write", field: `${mapKey}.${id}` };
      }
      for (const [field, value] of Object.entries(change.base)) {
        if (
          !isDeepStrictEqual(
            (existing as Record<string, unknown>)[field],
            value,
          )
        ) {
          return {
            kind: "concurrent_write",
            field: `${mapKey}.${id}.${field}`,
          };
        }
      }
    }
  }

  return null;
}

/**
 * Install a prepared batch from inside the write-queue reducer.
 *
 * TAKES OWNERSHIP of `draft`, which must be the reducer's own execution — the
 * private clone `mutateActive` hands it. The merge writes the delta straight
 * into that object's state maps, because building new ones would mean copying
 * every context and task in the execution while holding the global write lock;
 * an install has to cost the payload, not the graph. Callers that need the
 * pre-install state must clone before calling. A refusal or a `reprepare`
 * leaves `draft` untouched: every precondition is checked before the first
 * write.
 *
 * Ordering is the contract. A pending halt refuses unconditionally — including
 * on the splice path — because a halt decided between prepare and finalize must
 * not be overwritten by a batch that never saw it. An unchanged fence proves
 * nothing committed since the snapshot, so the prepared (frozen, validated)
 * state installs verbatim. Otherwise the delta merges onto the CURRENT
 * execution, which is what makes an interleaved scheduler or runtime mutation
 * impossible to erase: every key and field the batch did not rewrite keeps
 * whatever that mutation wrote.
 *
 * The merge path never clones, never walks the definition, and never
 * re-validates. What licenses that is the delta's preconditions:
 * `structuralRevision` fences every wholesale key in O(1), and the footprint
 * lifecycles and per-field base values reproduce the frozen-past and
 * runtime-map invariants over exactly the entries the batch touches — every
 * other context and task is byte-identical between `draft` and the result, so
 * those invariants hold for them by construction. Anything a precondition
 * cannot settle signals `reprepare`, and the full re-validation happens outside
 * the lock where it belongs.
 */
export function finalizePreparedEdits(
  draft: GraphWorkflowExecution,
  prepared: PreparedLiveEdits,
): FinalizePreparedEditsResult {
  const current = draft;
  if (current.pendingHaltReason !== null) {
    return {
      ok: false,
      outcome: "refused",
      code: "pending_halt",
      issues: [
        liveEditIssue(
          "pending-halt",
          `Execution has a pending halt (${current.pendingHaltReason.type}); the staged edit was not installed`,
        ),
      ],
    };
  }

  if (current.id !== prepared.executionId) {
    return {
      ok: false,
      outcome: "refused",
      code: "execution_mismatch",
      issues: [
        liveEditIssue(
          "execution-mismatch",
          `Staged edit targets execution "${prepared.executionId}" but the active execution is "${current.id}"`,
        ),
      ],
    };
  }

  if (current.executionStateRevision === prepared.baseStateRevision) {
    return {
      ok: true,
      install: "spliced",
      execution: prepared.execution,
      affectedContextIds: prepared.affectedContextIds,
    };
  }

  const stale = checkDeltaPreconditions(current, prepared);
  if (stale) {
    return { ok: false, outcome: "reprepare", reason: stale };
  }

  // Preconditions all held; from here the writes land on the caller's draft.
  Object.assign(current, prepared.delta.wholesale);
  applyStateMapDelta(current.contextStates, prepared.delta.contextStates);
  applyStateMapDelta(current.taskStates, prepared.delta.taskStates);

  return {
    ok: true,
    install: "merged",
    execution: current,
    affectedContextIds: prepared.affectedContextIds,
  };
}

/**
 * The two loop-composition restrictions on runtime expansion (R11.1). They sit
 * on the SHARED mutation core rather than on an expansion-specific accept
 * point, because every agent-initiated structural write rides this core — the
 * expansion service (spec task `task-expansion-service`) composes its batch
 * here too, so it inherits both refusals and cannot assemble a request that
 * routes around them.
 *
 * `initiatorContextId` is the context whose lane agent is asking; its absence
 * marks the operator entry points (CLI/UI live edits, the plan-repair
 * supervisor), which are governed by the R11.2 freeze rules instead. A
 * task-only agent batch is not an expansion — a running pass instance may still
 * add its own tasks — so the initiator check reads the batch, not just its
 * source.
 */
function checkExpansionLoopRestrictions(
  execution: GraphWorkflowExecution,
  request: Pick<WorkflowLiveEditRequest, "operations">,
  initiatorContextId: string | undefined,
): LiveEditRejection | null {
  if (initiatorContextId === undefined) return null;

  const issues = validateExpansionPayloadLoopDeclarations(request);
  if (request.operations.some((op) => isStructuralLiveOp(op.type))) {
    issues.push(
      ...validateExpansionInitiator({
        initiatorContextId,
        loopGroups: execution.workingDefinition.loopGroups ?? [],
        activation: loopActivationReader(execution),
      }),
    );
  }

  return issues.length > 0 ? { code: "invalid_edit", issues } : null;
}

/**
 * Whether a declared loop is still capable of cloning its body — the question
 * the R11.1 expansion refusal actually turns on, now that `loopStates` carries
 * the answer (it replaces T11's conservative "every declared group is active"
 * placeholder).
 *
 * An UNSTARTED loop reads active: its activation path has not resolved, so it
 * may still take every pass, and a node appended inside its body would either
 * vanish at the next pass or silently multiply. Only a loop that concluded or
 * was never taken releases its body — at which point the instances are ordinary
 * settled contexts and expansion from one is unremarkable.
 */
function loopActivationReader(
  execution: GraphWorkflowExecution,
): LoopActivationReader {
  return {
    isActive(loopGroupId) {
      const activation =
        execution.loopStates[loopGroupId]?.activation ?? "unstarted";
      return activation === "unstarted" || activation === "running";
    },
  };
}

function isStructuralLiveOp(type: WorkflowLiveEditOperation["type"]): boolean {
  return (
    type === "add-context" ||
    type === "remove-context" ||
    type === "add-edge" ||
    type === "update-edge" ||
    type === "remove-edge" ||
    type === "materialize-loop-pass"
  );
}

function liveEditIssue(
  code: string,
  message: string,
  operationIndex?: number,
  extra: Partial<WorkflowGraphValidationError> = {},
): WorkflowGraphValidationError {
  return {
    code,
    message,
    ...(operationIndex !== undefined ? { operationIndex } : {}),
    ...extra,
  };
}

function rejectLiveEdit(
  code: LiveEditRejectionCode,
  issue: WorkflowGraphValidationError,
): LiveEditRejection {
  return { code, issues: [issue] };
}

function findLiveContext(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowResolvedContext | undefined {
  return execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
}

/**
 * The lane-membership freeze (lwp R10, decision D11) — the shared gate every
 * placement-establishing op passes through, so a lane agent's expansion, an
 * operator's live edit, and the plan-repair supervisor are all refused on the
 * same evidence and told the same typed code.
 *
 * Closure gates ARRIVALS, not residents: a context that is already on the lane
 * may keep editing its own envelope, because nothing new is joining a merge that
 * has already been promised. Only a placement naming a DIFFERENT lane than the
 * context currently sits on is an arrival.
 *
 * The engine's loop-pass unrolling is deliberately not routed through here. It
 * writes its instances into the definition directly, and the lane they inherit
 * cannot be closed: `planContextJoin` and `planFinalPublishJoin` both refuse to
 * consume a lane while its loop is open, so the freeze cannot fire before the
 * loop concludes.
 */
function refuseClosedLaneArrival(
  next: GraphWorkflowExecution,
  input: {
    contextId: string;
    lane: string;
    /** Where the context sits today; absent when the op is creating it. */
    currentLane?: string | undefined;
    index: number;
  },
): LiveEditRejection | null {
  if (
    input.currentLane !== undefined &&
    executionLaneIdFor(input.currentLane) === executionLaneIdFor(input.lane)
  ) {
    return null;
  }

  const closure = laneClosure(next, input.lane);
  if (closure === null) return null;

  return rejectLiveEdit(
    "invalid_edit",
    liveEditIssue(
      LANE_CLOSED_CODE,
      `Lane "${input.lane}" no longer accepts members (${closure.reason}): its content is already committed to a join, and there is no reopen verb. Place "${input.contextId}" on a new lane instead`,
      input.index,
      { contextId: input.contextId },
    ),
  );
}

function findLiveTask(
  execution: GraphWorkflowExecution,
  taskId: string,
): GraphWorkflowTaskDefinition | undefined {
  return execution.workingDefinition.tasks.find((entry) => entry.id === taskId);
}

function isLiveTaskLocked(
  execution: GraphWorkflowExecution,
  taskId: string,
): boolean {
  const status = execution.taskStates[taskId]?.status;
  return status === "completed" || status === "running";
}

/**
 * The per-op editability gate for a context (doc 06 classifier): a `frozen`
 * (completed) context is never editable; a `started` context is editable only
 * when the execution is quiescent — except the lane-agent `add_task` entry point,
 * which is permitted while running under its own mutability check.
 */
function liveContextEditGate(
  execution: GraphWorkflowExecution,
  contextId: string,
  quiescent: boolean,
  index: number,
  options: { laneAgent?: boolean } = {},
): LiveEditRejection | null {
  const lifecycle = classifyContextLifecycle(execution, contextId);
  if (lifecycle === "frozen") {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "context-frozen",
        `Context "${contextId}" is completed and cannot be edited`,
        index,
        { contextId },
      ),
    );
  }
  if (lifecycle === "started" && !quiescent && !options.laneAgent) {
    return rejectLiveEdit(
      "requires_pause",
      liveEditIssue(
        "requires-pause",
        `Context "${contextId}" has started; pause the execution to edit it`,
        index,
        { contextId },
      ),
    );
  }
  return null;
}

/**
 * Live-boundary counterpart of the seed-time selector freeze (design §6):
 * each role an edit REWRITES is expanded to an explicit command-name snapshot
 * against the current registry; a role whose selector the edit merely echoes
 * unchanged keeps its existing frozen snapshot — re-expanding it would let a
 * registry addition silently broaden a running execution's permissions. The
 * op's own `commands` field (if a client sent one) is never trusted.
 */
function freezeAgentValidationSnapshot(
  context: GraphWorkflowResolvedContext,
  prior: GraphWorkflowResolvedContext["agentValidation"],
  deps: LiveEditDeps,
): void {
  if (!context.agentValidation) return;
  const registered = Object.keys(
    deps.validationCommandPreflight().commandCosts,
  );
  for (const role of ["implementer", "contextValidator"] as const) {
    const next = context.agentValidation[role];
    const stored = prior?.[role];
    if (
      stored?.commands !== undefined &&
      isDeepStrictEqual(stored.value, next.value)
    ) {
      next.commands = [...stored.commands];
    } else {
      next.commands = expandCommandSelector(next.value, registered).commands;
    }
  }
}

/**
 * An authored assignment plus the bytes it will run under. Applied at the live-
 * edit boundary for the same reason execution start applies it at the seed
 * boundary: past this point the working definition is snapshot-bearing, and
 * nothing downstream of it consults the library.
 */
function seedLiveAssignment<T extends PlaceableAssignment>(
  assignment: T,
  deps: LiveEditDeps,
): T & { profileSnapshot: AgentProfileSnapshot } {
  return { ...assignment, profileSnapshot: deps.snapshotFor(assignment) };
}

function seedLiveCohort(
  cohort: ValidatorCohort,
  deps: LiveEditDeps,
): SeededValidatorCohort {
  return {
    ...cohort,
    // Dormant assignments included: a disabled cohort's members are enabled by
    // a later edit that does no resolution, so their bytes must land now.
    assignments: cohort.assignments.map((assignment) =>
      seedLiveAssignment(assignment, deps),
    ),
  };
}

function applyLiveConfigBlocks(
  context: GraphWorkflowResolvedContext,
  op: LiveContextConfigOp,
  deps: LiveEditDeps,
): void {
  if (op.implementer !== undefined) {
    context.implementer = seedLiveAssignment(op.implementer, deps);
  }
  // Whole-cohort replacement, matching the cascade: a live edit swaps the set
  // rather than merging into it, and `enabled: false` is how it turns off.
  if (op.contextValidator !== undefined) {
    context.contextValidator = seedLiveCohort(op.contextValidator, deps);
  }
  if (op.scriptValidator !== undefined) {
    context.scriptValidator = op.scriptValidator;
    context.scriptValidatorSource = "per-node";
  }
  if (op.humanApprovalGate !== undefined) {
    context.humanApprovalGate = op.humanApprovalGate;
  }
  if (op.askUserQuestions !== undefined) {
    context.askUserQuestions = op.askUserQuestions;
  }
  if (op.iterationPolicy !== undefined) {
    context.iterationPolicy = op.iterationPolicy;
  }
  if (op.circuitBreaker !== undefined) {
    context.circuitBreaker = op.circuitBreaker;
  }
  if (op.mutability !== undefined) context.mutability = op.mutability;
  if (op.planRepair !== undefined) context.planRepair = op.planRepair;
  if (op.collaboration !== undefined) context.collaboration = op.collaboration;
  if (op.agentValidation !== undefined) {
    context.agentValidation = op.agentValidation;
  }
}

/**
 * Place a task (already assigned to `contextId`) at `position` within its
 * context, then densely renumber the context. `position` is relative — the
 * server owns the numeric order. Returns an error message when an `after`/
 * `before` anchor is not a sibling.
 */
function placeTaskInLiveContext(
  execution: GraphWorkflowExecution,
  contextId: string,
  taskId: string,
  position: DefinitionEditTaskPosition | undefined,
): { ok: true } | { ok: false; message: string } {
  const siblings = getContextTasks(execution, contextId)
    .map((task) => task.id)
    .filter((id) => id !== taskId);

  let insertIndex: number;
  if (position === undefined || "at" in position) {
    insertIndex = position && position.at === "start" ? 0 : siblings.length;
  } else if ("after" in position) {
    const anchor = siblings.indexOf(position.after);
    if (anchor === -1) {
      return {
        ok: false,
        message: `position anchor task "${position.after}" is not in context "${contextId}"`,
      };
    }
    insertIndex = anchor + 1;
  } else {
    const anchor = siblings.indexOf(position.before);
    if (anchor === -1) {
      return {
        ok: false,
        message: `position anchor task "${position.before}" is not in context "${contextId}"`,
      };
    }
    insertIndex = anchor;
  }

  siblings.splice(insertIndex, 0, taskId);
  setContextTaskOrder(execution, contextId, siblings);
  return { ok: true };
}

function applyLiveEditOperation(
  next: GraphWorkflowExecution,
  operation: WorkflowLiveEditOperation,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  switch (operation.type) {
    case "amend-charter":
      return applyAmendCharter(next, operation, index, ctx);
    case "update-context":
      return applyUpdateContext(next, operation, index, ctx);
    case "add-task":
      return applyAddTask(next, operation, index, ctx);
    case "update-task":
      return applyUpdateTask(next, operation, index, ctx);
    case "remove-task":
      return applyRemoveTask(next, operation, index, ctx);
    case "move-task":
      return applyMoveTask(next, operation, index, ctx);
    case "reorder-tasks":
      return applyReorderTasks(next, operation, index, ctx);
    case "add-context":
      return applyAddContext(next, operation, index, ctx);
    case "remove-context":
      return applyRemoveContext(next, operation, index, ctx);
    case "add-edge":
      return applyAddEdge(next, operation, index, ctx);
    case "update-edge":
      return applyUpdateEdge(next, operation, index, ctx);
    case "remove-edge":
      return applyRemoveEdge(next, operation, index, ctx);
    case "update-lane-merge-validation":
      return applyUpdateLaneMergeValidation(next, operation, index, ctx);
    case "materialize-loop-pass":
      return applyMaterializeLoopPass(next, operation, index, ctx);
    case "raise-loop-max-passes":
      return applyRaiseLoopMaxPasses(next, operation, index, ctx);
    case "amend-loop-predicate":
      return applyAmendLoopPredicate(next, operation, index, ctx);
    case "edit-loop-template":
      return applyEditLoopTemplate(next, operation, index, ctx);
    default:
      return assertNever(
        operation,
        `unhandled live edit operation: ${JSON.stringify(operation)}`,
      );
  }
}

/**
 * Versioned charter amendment (docs/design/cc-cli/07). Partial-merges the op's
 * content fields onto the execution's charter, propagates the amended charter
 * to every NON-frozen context copy (frozen contexts deliberately keep the
 * as-run version they executed under — organic history that also keeps the
 * frontier invariant's frozen deep-compare intact), appends a metadata-only
 * entry to the amendment log, and freshens the charter shared-document stamp so
 * readers know the worktree pointer copy was re-rendered.
 */
function applyAmendCharter(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "amend-charter" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const notQuiescent = requireQuiescent(ctx, index);
  if (notQuiescent) return notQuiescent;

  // Only the lane-agent wrapper omits `source`, and it never emits this op;
  // reaching here means a new entry point skipped audit attribution.
  if (ctx.source === undefined) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "missing-edit-source",
        "amend-charter requires an attributable request source",
        index,
      ),
    );
  }

  const merged = structuredClone(next.charter);
  applyCharterContentEdit(merged, op);
  const parsed = workflowCharterSchema.safeParse(merged);
  if (!parsed.success) {
    return {
      code: "invalid_edit",
      issues: parsed.error.issues.map((issue) => ({
        ...zodIssueToValidationError(issue),
        operationIndex: index,
      })),
    };
  }

  next.charter = parsed.data;
  for (const context of next.workingDefinition.executionContexts) {
    if (classifyContextLifecycle(next, context.id) === "frozen") continue;
    context.charter = structuredClone(parsed.data);
    ctx.affectedContextIds.add(context.id);
  }

  const opValue = op as unknown as Record<string, unknown>;
  const fieldsChanged = CHARTER_CONTENT_EDIT_FIELDS.filter(
    (field) => opValue[field] !== undefined,
  );
  const amendedAt = ctx.deps.now();
  next.charterAmendments = [
    ...next.charterAmendments,
    {
      seq: (next.charterAmendments.at(-1)?.seq ?? 0) + 1,
      amendedAt,
      source: ctx.source,
      rationale: op.rationale,
      fieldsChanged,
      charterHash: computeCharterHash(parsed.data),
    },
  ];

  for (const document of next.sharedDocuments) {
    if (document.kind === "charter") {
      document.updatedAt = amendedAt;
    }
  }

  return null;
}

/**
 * Workflow-scope snapshot rewrite (design §6). Quiescence-gated like the
 * other workflow-scope op (`amend-charter`); the new selection is what FUTURE
 * merge submissions resolve against — an in-flight merge keeps the selection
 * it was submitted with, which is the service's snapshot, not this record.
 */
function applyUpdateLaneMergeValidation(
  next: GraphWorkflowExecution,
  op: Extract<
    WorkflowLiveEditOperation,
    { type: "update-lane-merge-validation" }
  >,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const notQuiescent = requireQuiescent(ctx, index);
  if (notQuiescent) return notQuiescent;

  next.workingDefinition.laneMergeValidation = structuredClone(
    op.laneMergeValidation,
  );
  ctx.laneMergeTouched = true;
  return null;
}

function applyUpdateContext(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "update-context" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const context = findLiveContext(next, op.contextId);
  if (!context) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-context",
        `No context "${op.contextId}" in this execution`,
        index,
        { contextId: op.contextId },
      ),
    );
  }
  const gate = liveContextEditGate(next, op.contextId, ctx.quiescent, index);
  if (gate) return gate;

  if (op.title !== undefined) context.title = op.title;
  if (op.acceptanceCriteria !== undefined) {
    context.acceptanceCriteria = op.acceptanceCriteria;
  }
  if (op.description === null) {
    delete context.description;
  } else if (op.description !== undefined) {
    context.description = op.description;
  }
  // Wholesale replace or clear — a JSON Schema document has no partial merge.
  //
  // A banked output is evidence about exactly one contract, so it is dropped
  // with the contract it was validated against: an unchanged re-statement keeps
  // it, a clear or a genuine replacement discards it. Without this the read side
  // would report a payload as "captured" against a schema that never accepted
  // it (R7.6/R7.7), and a still-running context would skip the capture its new
  // contract owes.
  if (op.outputSchema !== undefined) {
    const previous = context.outputSchema;
    if (op.outputSchema === null) {
      delete context.outputSchema;
    } else {
      context.outputSchema = op.outputSchema;
    }
    if (!isDeepStrictEqual(previous ?? null, op.outputSchema)) {
      delete next.contextOutputs[op.contextId];
    }
  }
  // Identity, like `outputSchema`: present replaces, `null` returns the context
  // to the `independent` default, absent leaves it. Any change here bumps the
  // context's route-control revision through the surface diff at the end of the
  // batch, so a settled route is re-decided under the new policy.
  if (op.routing === null) {
    delete context.routing;
  } else if (op.routing !== undefined) {
    context.routing = op.routing;
  }
  // Wholesale replacement (the grade discriminates on `mode`, so there is no
  // partial merge) and never a clear. WHEN it may change is already decided by
  // the editability gate above — unstarted freely, started only at quiescence;
  // WHETHER the new envelope can coexist with the lane's other members is the
  // frontier's question, because only the post-batch graph knows (lwp R10.2).
  if (op.placement !== undefined) {
    const closed = refuseClosedLaneArrival(next, {
      contextId: op.contextId,
      lane: op.placement.lane,
      currentLane: context.placement.lane,
      index,
    });
    if (closed) return closed;
    context.placement = op.placement;
    ctx.placementTouched = true;
  }
  const priorAgentValidation = context.agentValidation;
  applyLiveConfigBlocks(context, op, ctx.deps);
  if (op.agentValidation !== undefined) {
    freezeAgentValidationSnapshot(context, priorAgentValidation, ctx.deps);
  }

  ctx.affectedContextIds.add(op.contextId);
  if (op.scriptValidator !== undefined || op.agentValidation !== undefined) {
    ctx.validationTouchedContextIds.add(op.contextId);
  }
  return null;
}

function applyAddTask(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "add-task" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const context = findLiveContext(next, op.contextId);
  if (!context) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-context",
        `No context "${op.contextId}" for the added task`,
        index,
        { contextId: op.contextId },
      ),
    );
  }
  const laneAgentTarget =
    ctx.laneAgentContextId !== undefined &&
    (op.contextId === ctx.laneAgentContextId ||
      ctx.batchCreatedContextIds.has(op.contextId));
  const gate = liveContextEditGate(next, op.contextId, ctx.quiescent, index, {
    laneAgent: laneAgentTarget,
  });
  if (gate) return gate;

  const taskId = op.id ?? ctx.deps.createTaskId();
  if (findLiveTask(next, taskId)) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "duplicate-task-id",
        `Task "${taskId}" already exists`,
        index,
        { taskId },
      ),
    );
  }

  // Provenance follows the INITIATOR, not the target: a lane agent's own
  // add_task and the tasks it seeds into the contexts this same batch created
  // are both agent-authored work.
  const source = laneAgentTarget ? "agent" : ("user" as const);
  const task: GraphWorkflowTaskDefinition = {
    id: taskId,
    contextId: op.contextId,
    order: getContextTaskOrder(next, op.contextId) + 1,
    title: op.title,
    instructions: op.instructions,
    ...(op.metadata ? { metadata: op.metadata } : {}),
    source,
  };
  next.workingDefinition.tasks.push(task);
  next.taskStates[taskId] = buildInitialTaskState(task);

  const placed = placeTaskInLiveContext(
    next,
    op.contextId,
    taskId,
    op.position,
  );
  if (!placed.ok) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue("position-target-not-found", placed.message, index, {
        taskId,
      }),
    );
  }
  syncContextState(next, op.contextId);
  ctx.affectedContextIds.add(op.contextId);
  return null;
}

function applyUpdateTask(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "update-task" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const task = findLiveTask(next, op.taskId);
  if (!task) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-task",
        `No task "${op.taskId}" in this execution`,
        index,
        { taskId: op.taskId },
      ),
    );
  }
  if (isLiveTaskLocked(next, op.taskId)) {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "task-locked",
        `Task "${op.taskId}" is ${next.taskStates[op.taskId]?.status ?? "locked"} and cannot be edited`,
        index,
        { taskId: op.taskId, contextId: task.contextId },
      ),
    );
  }
  const gate = liveContextEditGate(next, task.contextId, ctx.quiescent, index);
  if (gate) return gate;

  if (op.title !== undefined) task.title = op.title;
  if (op.instructions !== undefined) task.instructions = op.instructions;
  if (op.metadata === null) {
    delete task.metadata;
  } else if (op.metadata !== undefined) {
    task.metadata = op.metadata;
  }
  ctx.affectedContextIds.add(task.contextId);
  return null;
}

function applyRemoveTask(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "remove-task" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const task = findLiveTask(next, op.taskId);
  if (!task) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-task",
        `No task "${op.taskId}" in this execution`,
        index,
        { taskId: op.taskId },
      ),
    );
  }
  if (isLiveTaskLocked(next, op.taskId)) {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "task-locked",
        `Task "${op.taskId}" is ${next.taskStates[op.taskId]?.status ?? "locked"} and cannot be removed`,
        index,
        { taskId: op.taskId, contextId: task.contextId },
      ),
    );
  }
  const gate = liveContextEditGate(next, task.contextId, ctx.quiescent, index);
  if (gate) return gate;

  const contextId = task.contextId;
  next.workingDefinition.tasks = next.workingDefinition.tasks.filter(
    (entry) => entry.id !== op.taskId,
  );
  delete next.taskStates[op.taskId];
  setContextTaskOrder(
    next,
    contextId,
    getContextTasks(next, contextId).map((entry) => entry.id),
  );
  syncContextState(next, contextId);
  ctx.affectedContextIds.add(contextId);
  return null;
}

function applyMoveTask(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "move-task" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const task = findLiveTask(next, op.taskId);
  if (!task) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-task",
        `No task "${op.taskId}" in this execution`,
        index,
        { taskId: op.taskId },
      ),
    );
  }
  if (isLiveTaskLocked(next, op.taskId)) {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "task-locked",
        `Task "${op.taskId}" is ${next.taskStates[op.taskId]?.status ?? "locked"} and cannot be moved`,
        index,
        { taskId: op.taskId, contextId: task.contextId },
      ),
    );
  }
  if (!findLiveContext(next, op.targetContextId)) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-target-context",
        `Move target "${op.targetContextId}" does not exist`,
        index,
        { contextId: op.targetContextId },
      ),
    );
  }

  const sourceContextId = task.contextId;
  const sourceLifecycle = classifyContextLifecycle(next, sourceContextId);
  const targetLifecycle = classifyContextLifecycle(next, op.targetContextId);

  if (targetLifecycle === "frozen") {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "target-context-frozen",
        `Move target "${op.targetContextId}" is completed and cannot receive tasks`,
        index,
        { contextId: op.targetContextId },
      ),
    );
  }
  if (sourceLifecycle === "frozen") {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "context-frozen",
        `Source context "${sourceContextId}" is completed and cannot be edited`,
        index,
        { contextId: sourceContextId },
      ),
    );
  }
  if (
    !ctx.quiescent &&
    (sourceLifecycle !== "unstarted" || targetLifecycle !== "unstarted")
  ) {
    return rejectLiveEdit(
      "requires_pause",
      liveEditIssue(
        "requires-pause",
        `move-task while running requires both source and target contexts to be unstarted`,
        index,
        { taskId: op.taskId },
      ),
    );
  }

  task.contextId = op.targetContextId;
  const placed = placeTaskInLiveContext(
    next,
    op.targetContextId,
    op.taskId,
    op.position,
  );
  if (!placed.ok) {
    task.contextId = sourceContextId;
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue("position-target-not-found", placed.message, index, {
        taskId: op.taskId,
      }),
    );
  }

  if (op.targetContextId !== sourceContextId) {
    setContextTaskOrder(
      next,
      sourceContextId,
      getContextTasks(next, sourceContextId).map((entry) => entry.id),
    );
    syncContextState(next, sourceContextId);
    ctx.affectedContextIds.add(sourceContextId);
  }
  syncContextState(next, op.targetContextId);
  ctx.affectedContextIds.add(op.targetContextId);
  return null;
}

function applyReorderTasks(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "reorder-tasks" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const context = findLiveContext(next, op.contextId);
  if (!context) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-context",
        `No context "${op.contextId}" in this execution`,
        index,
        { contextId: op.contextId },
      ),
    );
  }
  const gate = liveContextEditGate(next, op.contextId, ctx.quiescent, index);
  if (gate) return gate;

  const contextTasks = getContextTasks(next, op.contextId);
  const editableIds = contextTasks
    .filter((task) => !isLiveTaskLocked(next, task.id))
    .map((task) => task.id);
  const provided = new Set(op.orderedTaskIds);
  if (
    provided.size !== op.orderedTaskIds.length ||
    provided.size !== editableIds.length ||
    editableIds.some((id) => !provided.has(id))
  ) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "reorder-mismatch",
        `reorder-tasks for context "${op.contextId}" must be an exact permutation of its editable tasks`,
        index,
        { contextId: op.contextId },
      ),
    );
  }

  const reordered = [...op.orderedTaskIds];
  const finalOrder = contextTasks.map((task) =>
    isLiveTaskLocked(next, task.id) ? task.id : reordered.shift()!,
  );
  setContextTaskOrder(next, op.contextId, finalOrder);
  syncContextState(next, op.contextId);
  ctx.affectedContextIds.add(op.contextId);
  return null;
}

// Structural ops (add-context / remove-context / add-edge / remove-edge) all
// require a quiescent execution (doc 06, D5): the edge topology and context set
// are the graph's shape, so shape edits only land while the scheduler is idle.
function requireQuiescent(
  ctx: LiveEditOpContext,
  index: number,
): LiveEditRejection | null {
  if (ctx.quiescent || ctx.additiveAmendment) return null;
  return rejectLiveEdit(
    "requires_pause",
    liveEditIssue(
      "requires-pause",
      "Structural edits require a quiescent execution; pause it first",
      index,
    ),
  );
}

/**
 * The gate for the two APPEND-ONLY structural ops (D4 R6.5). Identical to
 * {@link requireQuiescent} for every client-reachable caller; the two
 * server-derived paths — lane-agent expansion and engine loop unrolling — append
 * to a running graph without a pause because their own admission rules (bound
 * implementer + `allowAgentContextAdd`, or a settled loop pass) are stricter
 * than quiescence, and because pausing to grow the graph would defeat the point
 * of growing it. The exemption is deliberately not extended to the destructive
 * edge/context ops.
 */
function requireQuiescentUnlessServerDerivedAppend(
  ctx: LiveEditOpContext,
  index: number,
): LiveEditRejection | null {
  if (ctx.structuralSource !== undefined) return null;
  return requireQuiescent(ctx, index);
}

/**
 * Project a resolved context's config blocks into the `add-context` seed base.
 * Resolved `collaboration` is `.optional()` on legacy executions, but the seed
 * base must always carry one — fall back to resolved global defaults when the
 * source context has no snapshot (doc 06, D11).
 *
 * The projection itself lives in `generated-child-config.ts` so this path and
 * the expansion compiler read the SAME set of blocks; a config block added to
 * one and missed by the other is how a gate silently stops being inherited.
 */
function resolvedConfigFromContext(
  source: GraphWorkflowResolvedContext,
  deps: LiveEditDeps,
): ResolvedContextConfig {
  const defaults = deps.resolvedGlobalDefaults();
  return {
    ...resolvedContextConfig(source, defaults.collaboration),
    scriptValidatorSource: source.scriptValidatorSource ?? "global",
    agentValidation: source.agentValidation ?? defaults.agentValidation,
  };
}

function applyAddContext(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "add-context" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const notQuiescent = requireQuiescentUnlessServerDerivedAppend(ctx, index);
  if (notQuiescent) return notQuiescent;

  if (findLiveContext(next, op.id)) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "duplicate-context-id",
        `Context "${op.id}" already exists`,
        index,
        { contextId: op.id },
      ),
    );
  }

  // Ahead of the config seeding: an add onto a frozen lane is refused on the
  // lane alone, so it should not first resolve a config source it will discard.
  const placement = op.placement ?? { lane: op.id, mode: "full" as const };
  const closed = refuseClosedLaneArrival(next, {
    contextId: op.id,
    lane: placement.lane,
    index,
  });
  if (closed) return closed;

  let base: ResolvedContextConfig;
  if (op.configFromContextId !== undefined) {
    const source = findLiveContext(next, op.configFromContextId);
    if (!source) {
      return rejectLiveEdit(
        "invalid_edit",
        liveEditIssue(
          "unknown-config-source",
          `configFromContextId "${op.configFromContextId}" does not exist`,
          index,
          { contextId: op.configFromContextId },
        ),
      );
    }
    base = resolvedConfigFromContext(source, ctx.deps);
  } else {
    base =
      ctx.amendmentContextSeed === undefined
        ? ctx.deps.resolvedGlobalDefaults()
        : structuredClone(ctx.amendmentContextSeed);
  }

  // Explicit op fields override the seeded base. The charter is workflow-global
  // content, copied from the execution to match every resolved context
  // (resolve-config.ts).
  const context: GraphWorkflowResolvedContext = {
    id: op.id,
    title: op.title,
    acceptanceCriteria: op.acceptanceCriteria,
    ...(op.description !== undefined ? { description: op.description } : {}),
    // Never seeded from `configFromContextId`: an output contract is per-context
    // identity, not inheritable config (D1).
    ...(op.outputSchema !== undefined ? { outputSchema: op.outputSchema } : {}),
    // Same reason: a routing policy describes this context's own outgoing edge
    // set, so it is never seeded from `configFromContextId`.
    ...(op.routing !== undefined ? { routing: op.routing } : {}),
    // Never seeded from `configFromContextId` either — a lane and its owned
    // prefixes are the one thing two contexts must NOT share by accident, and
    // sharing a lane is a claim about concurrency and ownership between two
    // specific contexts that copying config cannot establish. Without an
    // authored placement the context gets a single-member lane of its own,
    // matching the saved-tier add (`definition-edits.ts`) and the shape a
    // live-added context had before placement was authored; the frontier
    // validates the result either way.
    placement,
    implementer:
      op.implementer === undefined
        ? base.implementer
        : seedLiveAssignment(op.implementer, ctx.deps),
    contextValidator:
      op.contextValidator === undefined
        ? base.contextValidator
        : seedLiveCohort(op.contextValidator, ctx.deps),
    scriptValidator: op.scriptValidator ?? base.scriptValidator,
    scriptValidatorSource:
      op.scriptValidator !== undefined
        ? "per-node"
        : (base.scriptValidatorSource ?? "global"),
    humanApprovalGate: op.humanApprovalGate ?? base.humanApprovalGate,
    askUserQuestions: op.askUserQuestions ?? base.askUserQuestions,
    mutability: op.mutability ?? base.mutability,
    circuitBreaker: op.circuitBreaker ?? base.circuitBreaker,
    iterationPolicy: op.iterationPolicy ?? base.iterationPolicy,
    planRepair: op.planRepair ?? base.planRepair,
    collaboration: op.collaboration ?? base.collaboration,
    agentValidation: op.agentValidation ?? base.agentValidation,
    charter: next.charter,
  };
  // A config copied from a source context keeps that context's frozen
  // snapshot (never broadens); an explicit op selector freezes fresh here.
  freezeAgentValidationSnapshot(context, base.agentValidation, ctx.deps);
  next.workingDefinition.executionContexts.push(context);
  next.contextStates[op.id] = buildInitialContextState(
    context,
    next.workingDefinition.tasks,
  );

  ctx.affectedContextIds.add(op.id);
  ctx.validationTouchedContextIds.add(op.id);
  ctx.batchCreatedContextIds.add(op.id);
  // An add always establishes a placement, authored or fallback, so the lane it
  // joins is checked here rather than at provisioning time.
  ctx.placementTouched = true;
  return null;
}

/**
 * Unroll one pass of a declared loop group (D4 R9) — the engine's only
 * structural write that runs on a NON-quiescent execution.
 *
 * That exemption is safe by construction rather than by trust, and every clause
 * below is load-bearing for it: the op writes only BRAND-NEW nodes in the
 * reserved `<loopGroupId>__p<K>__…` namespace that no author may inhabit, it
 * touches no existing context's definition entry, runtime state or INCOMING
 * edges, and the one pre-existing node it names — the prior pass's exit — gains
 * an outgoing edge only, which the frozen-past invariant does not pin. There is
 * therefore no started or frozen context whose picture a concurrent turn and
 * this batch could disagree about, which is exactly what the quiescence gate
 * protects everywhere else.
 *
 * The clone is verbatim from the group's versioned body TEMPLATE, not from the
 * previous pass's instances: D10 requires every pass to run the config the seed
 * resolved, so a live edit to pass K's config must not silently become the
 * contract for pass K+1.
 *
 * The prior-exit wiring edge is the new pass entry's only incoming edge. The
 * loop's boundary routing edge was consumed once by pass 1 and is never cloned
 * (R9); the boundary INPUTS reach later passes through the loop state's
 * activation-time snapshot instead.
 */
function applyMaterializeLoopPass(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "materialize-loop-pass" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  if (!ctx.engineLoopSettlement) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "loop-materialization-unauthorized",
        "Loop passes are unrolled by the engine's settlement transaction only; this entry point cannot materialize one",
        index,
      ),
    );
  }

  const group = next.workingDefinition.loopGroups?.find(
    (candidate) => candidate.id === op.loopGroupId,
  );
  if (!group) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-loop-group",
        `No loop group "${op.loopGroupId}" is declared`,
        index,
      ),
    );
  }

  const priorExitContextId = loopInstanceId(
    group.id,
    op.pass - 1,
    group.exitContextId,
  );
  if (!findLiveContext(next, priorExitContextId)) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-loop-pass-instance",
        `Loop group "${group.id}" has no pass ${op.pass - 1} exit instance "${priorExitContextId}" to wire pass ${op.pass} onto`,
        index,
        { contextId: priorExitContextId },
      ),
    );
  }

  const mint = (authoredId: string): string =>
    loopInstanceId(group.id, op.pass, authoredId);

  for (const context of group.template.contexts) {
    if (!findLiveContext(next, mint(context.id))) continue;
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "duplicate-context-id",
        `Loop group "${group.id}" pass ${op.pass} is already materialized`,
        index,
        { contextId: mint(context.id) },
      ),
    );
  }

  for (const context of group.template.contexts) {
    next.workingDefinition.executionContexts.push({
      ...structuredClone(context),
      id: mint(context.id),
      // The CURRENT charter, matching every other freshly created context: a
      // pass that starts after an amendment runs under the amended rules.
      charter: structuredClone(next.charter),
    });
  }
  for (const task of group.template.tasks) {
    const instance: GraphWorkflowTaskDefinition = {
      ...structuredClone(task),
      id: mint(task.id),
      contextId: mint(task.contextId),
    };
    next.workingDefinition.tasks.push(instance);
    next.taskStates[instance.id] = buildInitialTaskState(instance);
  }
  for (const context of group.template.contexts) {
    const instanceId = mint(context.id);
    const instance = findLiveContext(next, instanceId);
    if (!instance) continue;
    next.contextStates[instanceId] = buildInitialContextState(
      instance,
      next.workingDefinition.tasks,
    );
    ctx.affectedContextIds.add(instanceId);
  }
  for (const edge of group.template.edges) {
    next.workingDefinition.edges.push({
      ...structuredClone(edge),
      id: mint(edge.id),
      sourceContextId: mint(edge.sourceContextId),
      targetContextId: mint(edge.targetContextId),
    });
  }
  next.workingDefinition.edges.push({
    id: mint(LOOP_PASS_ENTRY_EDGE_SUFFIX),
    sourceContextId: priorExitContextId,
    targetContextId: mint(group.entryContextId),
  });

  return null;
}

// ============================================================
// The three edits a STARTED loop admits (D4 R11.2)
// ============================================================
// Membership is frozen by the VOCABULARY — no operation names a body's
// contexts, its entry or exit, its internal edges, or the execution backstop —
// so what is left to gate here is WHEN each of the three may land, and the
// audit trail each one owes.
//
// All three are quiescence-class: they change what the settlement transaction
// will decide, and the engine settles on live scheduling passes. A predicate
// amendment is stricter still (R11: halted only), because it moves the bar a
// completed pass was already judged against.

/**
 * The shared preamble for the loop-control ops: quiescence, a declared and
 * still-live loop group, and an attributable source for the audit log.
 */
function resolveLoopControlTarget(
  next: GraphWorkflowExecution,
  loopGroupId: string,
  index: number,
  ctx: LiveEditOpContext,
):
  | { ok: true; group: GraphWorkflowResolvedLoopGroup }
  | { ok: false; rejection: LiveEditRejection } {
  const notQuiescent = requireQuiescent(ctx, index);
  if (notQuiescent) return { ok: false, rejection: notQuiescent };

  if (ctx.source === undefined) {
    return {
      ok: false,
      rejection: rejectLiveEdit(
        "invalid_edit",
        liveEditIssue(
          "missing-edit-source",
          "loop-control edits require an attributable request source",
          index,
        ),
      ),
    };
  }

  const group = next.workingDefinition.loopGroups?.find(
    (candidate) => candidate.id === loopGroupId,
  );
  if (!group) {
    return {
      ok: false,
      rejection: rejectLiveEdit(
        "invalid_edit",
        liveEditIssue(
          "unknown-loop-group",
          `No loop group "${loopGroupId}" is declared`,
          index,
        ),
      ),
    };
  }

  // A concluded or untaken loop has no future pass an edit could reach, and its
  // completed passes are never re-run — so there is nothing an amendment could
  // honestly do. Fail closed rather than record an edit with no effect.
  const activation = next.loopStates[loopGroupId]?.activation ?? "unstarted";
  if (activation === "concluded" || activation === "skipped") {
    return {
      ok: false,
      rejection: rejectLiveEdit(
        "invalid_edit",
        liveEditIssue(
          "loop-already-settled",
          `Loop group "${loopGroupId}" has already ${activation === "concluded" ? "concluded" : "been skipped"}; its passes are settled and cannot be re-decided`,
          index,
        ),
      ),
    };
  }

  return { ok: true, group };
}

/**
 * Record the accepted edit and bump the loop's control revision, which is the
 * whole mechanism behind "the repair takes effect at the resume decision": the
 * decision record's dedup key reads it, so a bumped revision makes settlement
 * re-decide the pass it already decided.
 *
 * EVERY accepted loop-control op bumps it, template edits included (decision
 * D10) — the revision is the audit counter for "the loop's terms moved", so an
 * op that left it unchanged would make the amendment log and the revision
 * disagree about what an operator changed.
 */
function recordLoopControlAmendment(
  next: GraphWorkflowExecution,
  group: GraphWorkflowResolvedLoopGroup,
  kind: LoopControlAmendment["kind"],
  rationale: string | null,
  ctx: LiveEditOpContext,
): void {
  const state = ensureLoopState(next, group.id);
  state.loopControlRevision += 1;
  next.loopControlAmendments.push({
    seq: (next.loopControlAmendments.at(-1)?.seq ?? 0) + 1,
    loopGroupId: group.id,
    kind,
    rationale,
    loopControlRevision: state.loopControlRevision,
    templateVersion: group.templateVersion,
    maxPasses: group.maxPasses,
    // Only the lane-agent wrapper omits `source`, and the preamble already
    // refused that path.
    source: ctx.source ?? "cli",
    amendedAt: ctx.deps.now(),
  });
}

function applyRaiseLoopMaxPasses(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "raise-loop-max-passes" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const target = resolveLoopControlTarget(next, op.loopGroupId, index, ctx);
  if (!target.ok) return target.rejection;
  const { group } = target;

  // Raising is the only direction R11.2 admits: lowering a started loop's cap
  // would retroactively make passes that already ran unaffordable. The ceiling
  // above it — the unraisable execution backstop — is enforced by the
  // accept-time budget rule the frontier re-runs, so it is not restated here.
  if (op.maxPasses <= group.maxPasses) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "loop-max-passes-not-raised",
        `Loop group "${group.id}" already allows ${group.maxPasses} pass(es); a started loop admits a RAISED cap only`,
        index,
      ),
    );
  }

  group.maxPasses = op.maxPasses;
  recordLoopControlAmendment(
    next,
    group,
    "raise-max-passes",
    op.rationale ?? null,
    ctx,
  );
  return null;
}

function applyAmendLoopPredicate(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "amend-loop-predicate" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const target = resolveLoopControlTarget(next, op.loopGroupId, index, ctx);
  if (!target.ok) return target.rejection;
  const { group } = target;

  // Halted, not merely quiescent (R11). A paused execution has passes in
  // flight whose exits will be judged against whatever the predicate says when
  // they land; a halted one has a final recorded verdict the operator is
  // answering, which is exactly the amendment R12.2 makes non-retroactive.
  if (next.status !== "halted") {
    return rejectLiveEdit(
      "requires_pause",
      liveEditIssue(
        "loop-predicate-requires-halt",
        `Loop group "${group.id}"'s exit predicate is amendable only while the execution is halted; the loop is ${next.status}`,
        index,
      ),
    );
  }

  group.until = structuredClone(op.until);
  recordLoopControlAmendment(next, group, "amend-predicate", op.rationale, ctx);
  return null;
}

function applyEditLoopTemplate(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "edit-loop-template" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const target = resolveLoopControlTarget(next, op.loopGroupId, index, ctx);
  if (!target.ok) return target.rejection;
  const { group } = target;

  for (const contentOp of op.operations) {
    const rejection = applyLoopTemplateContentOp(group, contentOp, index, ctx);
    if (rejection) return rejection;
  }

  // ONE bump per accepted op, not per nested edit: the version identifies the
  // template a pass cloned, and the whole batch installs atomically.
  group.templateVersion += 1;
  recordLoopControlAmendment(next, group, "edit-template", null, ctx);
  return null;
}

/**
 * Apply one content edit to a body template. The template is a frozen snapshot,
 * not part of the scheduled graph, so none of the runtime gates apply to it —
 * no pass instance is running THIS, and the instances that cloned it are
 * ordinary contexts answering to the ordinary freeze rules.
 */
function applyLoopTemplateContentOp(
  group: GraphWorkflowResolvedLoopGroup,
  op: LoopTemplateContentOperation,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const templateContext = (contextId: string) =>
    group.template.contexts.find((entry) => entry.id === contextId);
  const unknownContext = (contextId: string): LiveEditRejection =>
    rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-loop-template-context",
        `Loop group "${group.id}" has no body-template context "${contextId}" — template edits address the template's own ids, never a materialized pass instance`,
        index,
        { contextId },
      ),
    );
  const unknownTask = (taskId: string): LiveEditRejection =>
    rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-loop-template-task",
        `Loop group "${group.id}" has no body-template task "${taskId}"`,
        index,
        { taskId },
      ),
    );

  switch (op.type) {
    case "update-context": {
      const context = templateContext(op.contextId);
      if (!context) return unknownContext(op.contextId);
      if (op.title !== undefined) context.title = op.title;
      if (op.acceptanceCriteria !== undefined) {
        context.acceptanceCriteria = op.acceptanceCriteria;
      }
      if (op.description === null) {
        delete context.description;
      } else if (op.description !== undefined) {
        context.description = op.description;
      }
      return null;
    }
    case "add-task": {
      if (!templateContext(op.contextId)) return unknownContext(op.contextId);
      const taskId = op.id ?? ctx.deps.createTaskId();
      if (group.template.tasks.some((entry) => entry.id === taskId)) {
        return rejectLiveEdit(
          "invalid_edit",
          liveEditIssue(
            "duplicate-task-id",
            `Loop group "${group.id}" already has a body-template task "${taskId}"`,
            index,
            { taskId },
          ),
        );
      }
      group.template.tasks.push({
        id: taskId,
        contextId: op.contextId,
        order: templateTaskIds(group, op.contextId).length + 1,
        title: op.title,
        instructions: op.instructions,
        ...(op.metadata ? { metadata: op.metadata } : {}),
        source: "user",
      });
      const placed = placeTemplateTask(
        group,
        op.contextId,
        taskId,
        op.position,
      );
      if (!placed.ok) {
        return rejectLiveEdit(
          "invalid_edit",
          liveEditIssue("position-target-not-found", placed.message, index, {
            taskId,
          }),
        );
      }
      return null;
    }
    case "update-task": {
      const task = group.template.tasks.find((entry) => entry.id === op.taskId);
      if (!task) return unknownTask(op.taskId);
      if (op.title !== undefined) task.title = op.title;
      if (op.instructions !== undefined) task.instructions = op.instructions;
      if (op.metadata === null) {
        delete task.metadata;
      } else if (op.metadata !== undefined) {
        task.metadata = op.metadata;
      }
      return null;
    }
    case "remove-task": {
      const task = group.template.tasks.find((entry) => entry.id === op.taskId);
      if (!task) return unknownTask(op.taskId);
      const contextId = task.contextId;
      group.template.tasks = group.template.tasks.filter(
        (entry) => entry.id !== op.taskId,
      );
      renumberTemplateTasks(
        group,
        contextId,
        templateTaskIds(group, contextId),
      );
      return null;
    }
    case "reorder-tasks": {
      if (!templateContext(op.contextId)) return unknownContext(op.contextId);
      const current = templateTaskIds(group, op.contextId);
      const provided = new Set(op.orderedTaskIds);
      if (
        provided.size !== op.orderedTaskIds.length ||
        provided.size !== current.length ||
        current.some((id) => !provided.has(id))
      ) {
        return rejectLiveEdit(
          "invalid_edit",
          liveEditIssue(
            "reorder-mismatch",
            `reorder-tasks for body-template context "${op.contextId}" must be an exact permutation of its tasks`,
            index,
            { contextId: op.contextId },
          ),
        );
      }
      renumberTemplateTasks(group, op.contextId, op.orderedTaskIds);
      return null;
    }
    default:
      return assertNever(
        op,
        `unhandled loop template content operation: ${JSON.stringify(op)}`,
      );
  }
}

/** A template context's task ids, in current order. */
function templateTaskIds(
  group: GraphWorkflowResolvedLoopGroup,
  contextId: string,
): string[] {
  return group.template.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order)
    .map((task) => task.id);
}

/** Densely renumber one template context to 1..n in the given order. */
function renumberTemplateTasks(
  group: GraphWorkflowResolvedLoopGroup,
  contextId: string,
  orderedTaskIds: readonly string[],
): void {
  orderedTaskIds.forEach((taskId, position) => {
    const task = group.template.tasks.find((entry) => entry.id === taskId);
    if (task && task.contextId === contextId) task.order = position + 1;
  });
}

/** {@link placeTaskInLiveContext} for a body template's own task list. */
function placeTemplateTask(
  group: GraphWorkflowResolvedLoopGroup,
  contextId: string,
  taskId: string,
  position: DefinitionEditTaskPosition | undefined,
): { ok: true } | { ok: false; message: string } {
  const siblings = templateTaskIds(group, contextId).filter(
    (id) => id !== taskId,
  );

  let insertIndex: number;
  if (position === undefined || "at" in position) {
    insertIndex = position && position.at === "start" ? 0 : siblings.length;
  } else if ("after" in position) {
    const anchor = siblings.indexOf(position.after);
    if (anchor === -1) {
      return {
        ok: false,
        message: `position anchor task "${position.after}" is not in body-template context "${contextId}"`,
      };
    }
    insertIndex = anchor + 1;
  } else {
    const anchor = siblings.indexOf(position.before);
    if (anchor === -1) {
      return {
        ok: false,
        message: `position anchor task "${position.before}" is not in body-template context "${contextId}"`,
      };
    }
    insertIndex = anchor;
  }

  siblings.splice(insertIndex, 0, taskId);
  renumberTemplateTasks(group, contextId, siblings);
  return { ok: true };
}

function applyRemoveContext(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "remove-context" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const notQuiescent = requireQuiescent(ctx, index);
  if (notQuiescent) return notQuiescent;

  const context = findLiveContext(next, op.contextId);
  if (!context) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-context",
        `No context "${op.contextId}" in this execution`,
        index,
        { contextId: op.contextId },
      ),
    );
  }

  const lifecycle = classifyContextLifecycle(next, op.contextId);
  if (lifecycle === "frozen") {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "context-frozen",
        `Context "${op.contextId}" is completed and cannot be removed`,
        index,
        { contextId: op.contextId },
      ),
    );
  }
  if (lifecycle === "started") {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "remove-started-context",
        `Context "${op.contextId}" has started; only an unstarted context can be removed`,
        index,
        { contextId: op.contextId },
      ),
    );
  }

  // Outgoing edges must be dropped explicitly first (doc 06, D5) so a
  // transitive-dependency removal is never a silent side effect.
  const outgoing = next.workingDefinition.edges.filter(
    (edge) => edge.sourceContextId === op.contextId,
  );
  if (outgoing.length > 0) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "remove-context-outgoing-edges",
        `Context "${op.contextId}" still has ${outgoing.length} outgoing edge(s); remove them first`,
        index,
        { contextId: op.contextId },
      ),
    );
  }

  const contextTasks = getContextTasks(next, op.contextId);
  if (contextTasks.length > 0 && op.deleteTasks !== true) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "context-not-empty",
        `Context "${op.contextId}" still has ${contextTasks.length} task(s); pass deleteTasks: true to remove them`,
        index,
        { contextId: op.contextId },
      ),
    );
  }

  for (const task of contextTasks) {
    delete next.taskStates[task.id];
  }
  next.workingDefinition.tasks = next.workingDefinition.tasks.filter(
    (task) => task.contextId !== op.contextId,
  );
  next.workingDefinition.executionContexts =
    next.workingDefinition.executionContexts.filter(
      (entry) => entry.id !== op.contextId,
    );
  // Incoming edges cascade automatically (the upstream's executed work is
  // unaffected by dropping a future dependency).
  next.workingDefinition.edges = next.workingDefinition.edges.filter(
    (edge) =>
      edge.sourceContextId !== op.contextId &&
      edge.targetContextId !== op.contextId,
  );
  delete next.contextStates[op.contextId];

  ctx.affectedContextIds.add(op.contextId);
  return null;
}

function applyAddEdge(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "add-edge" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const notQuiescent = requireQuiescentUnlessServerDerivedAppend(ctx, index);
  if (notQuiescent) return notQuiescent;

  if (!findLiveContext(next, op.sourceContextId)) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-edge-source",
        `Edge source "${op.sourceContextId}" does not exist`,
        index,
        { contextId: op.sourceContextId },
      ),
    );
  }
  if (!findLiveContext(next, op.targetContextId)) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-edge-target",
        `Edge target "${op.targetContextId}" does not exist`,
        index,
        { contextId: op.targetContextId },
      ),
    );
  }

  // The target's incoming edge set is protected once it has started (adding a
  // future dependency to a running/completed context reshapes executed work);
  // the source may be any lifecycle — a new out-edge only sequences future work.
  const targetLifecycle = classifyContextLifecycle(next, op.targetContextId);
  if (targetLifecycle !== "unstarted") {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "protected-incoming-edge",
        `Cannot add an incoming edge to ${targetLifecycle} context "${op.targetContextId}"`,
        index,
        { contextId: op.targetContextId },
      ),
    );
  }

  if (
    findLiveEdge(
      next.workingDefinition.edges,
      op.sourceContextId,
      op.targetContextId,
    )
  ) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "edge-already-exists",
        `Edge ${op.sourceContextId} → ${op.targetContextId} already exists`,
        index,
        { contextId: op.targetContextId },
      ),
    );
  }

  if (
    op.id !== undefined &&
    next.workingDefinition.edges.some((edge) => edge.id === op.id)
  ) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "edge-id-already-exists",
        `Edge id "${op.id}" already exists`,
        index,
        { contextId: op.targetContextId },
      ),
    );
  }

  next.workingDefinition.edges.push({
    id:
      op.id ??
      mintLiveEdgeId(
        next.workingDefinition.edges,
        op.sourceContextId,
        op.targetContextId,
      ),
    sourceContextId: op.sourceContextId,
    targetContextId: op.targetContextId,
    // Guard legality (source outputSchema present, subset-valid document,
    // compatible with the source's declared output, at most one else per
    // source) is enforced by the frontier's `validateWorkflowDefinition` pass,
    // which every mutation path already rides — never re-checked here.
    ...(op.when !== undefined ? { when: op.when } : {}),
  });
  ctx.affectedContextIds.add(op.sourceContextId);
  ctx.affectedContextIds.add(op.targetContextId);
  return null;
}

/**
 * Set, replace, or clear an edge's activation guard, addressed by edge id — the
 * only unambiguous addressing once a source carries parallel guarded edges (D2).
 * Gated exactly like the other structural edge ops: quiescent execution, and the
 * edge's target still unstarted, because a guard decides whether that target
 * runs at all.
 */
function applyUpdateEdge(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "update-edge" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const notQuiescent = requireQuiescent(ctx, index);
  if (notQuiescent) return notQuiescent;

  const edge = next.workingDefinition.edges.find(
    (entry) => entry.id === op.edgeId,
  );
  if (!edge) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue("unknown-edge", `No edge "${op.edgeId}"`, index, {
        edgeId: op.edgeId,
      }),
    );
  }

  const targetLifecycle = classifyContextLifecycle(next, edge.targetContextId);
  if (targetLifecycle !== "unstarted") {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "protected-incoming-edge",
        `Cannot change the guard on an incoming edge of ${targetLifecycle} context "${edge.targetContextId}"`,
        index,
        { contextId: edge.targetContextId, edgeId: edge.id },
      ),
    );
  }

  if (op.when === null) {
    delete edge.when;
  } else if (op.when !== undefined) {
    edge.when = op.when;
  }

  ctx.affectedContextIds.add(edge.sourceContextId);
  ctx.affectedContextIds.add(edge.targetContextId);
  return null;
}

function applyRemoveEdge(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "remove-edge" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const notQuiescent = requireQuiescent(ctx, index);
  if (notQuiescent) return notQuiescent;

  const matches = matchLiveEdges(next.workingDefinition.edges, op);
  const described =
    op.edgeId !== undefined
      ? `"${op.edgeId}"`
      : `${op.sourceContextId} → ${op.targetContextId}`;

  if (matches.length === 0) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue("unknown-edge", `No edge ${described}`, index, {
        ...(op.edgeId !== undefined ? { edgeId: op.edgeId } : {}),
        ...(op.targetContextId !== undefined
          ? { contextId: op.targetContextId }
          : {}),
      }),
    );
  }
  // Endpoint addressing is first-match by nature; with guards, parallel edges
  // between one pair carry different routing meaning, so removing whichever came
  // first would silently delete the wrong branch (D2). Name the candidates so
  // the caller retries by id.
  if (matches.length > 1) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "ambiguous-edge-endpoints",
        `${matches.length} edges match ${described}; address one by edgeId: ${matches
          .map((edge) => edge.id)
          .join(", ")}`,
        index,
      ),
    );
  }

  const edge = matches[0]!;
  const targetLifecycle = classifyContextLifecycle(next, edge.targetContextId);
  if (targetLifecycle !== "unstarted") {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "protected-incoming-edge",
        `Cannot remove an incoming edge of ${targetLifecycle} context "${edge.targetContextId}"`,
        index,
        { contextId: edge.targetContextId, edgeId: edge.id },
      ),
    );
  }

  next.workingDefinition.edges = next.workingDefinition.edges.filter(
    (entry) => entry.id !== edge.id,
  );
  ctx.affectedContextIds.add(edge.sourceContextId);
  ctx.affectedContextIds.add(edge.targetContextId);
  return null;
}

/** Every edge an id- or endpoint-addressed `remove-edge` could mean. */
function matchLiveEdges(
  edges: readonly GraphWorkflowContextEdge[],
  op: Extract<WorkflowLiveEditOperation, { type: "remove-edge" }>,
): GraphWorkflowContextEdge[] {
  if (op.edgeId !== undefined) {
    return edges.filter((edge) => edge.id === op.edgeId);
  }
  return edges.filter(
    (edge) =>
      edge.sourceContextId === op.sourceContextId &&
      edge.targetContextId === op.targetContextId,
  );
}

function findLiveEdge(
  edges: GraphWorkflowContextEdge[],
  sourceContextId: string,
  targetContextId: string,
): GraphWorkflowContextEdge | undefined {
  return edges.find(
    (edge) =>
      edge.sourceContextId === sourceContextId &&
      edge.targetContextId === targetContextId,
  );
}

function mintLiveEdgeId(
  edges: readonly GraphWorkflowContextEdge[],
  sourceContextId: string,
  targetContextId: string,
): string {
  return mintEdgeId(
    new Set(edges.map((edge) => edge.id)),
    sourceContextId,
    targetContextId,
  );
}

/**
 * The execution-frontier invariant (doc 06, §"The execution-frontier invariant")
 * — the post-batch safety net that guarantees the whole result is legal, beyond
 * what the per-op gates already enforce. In order: graph validity (unique ids,
 * DAG acyclicity), frozen-past unchanged (a completed/started context's prose +
 * config, completed tasks, and incoming edges are byte-identical), resolved-config
 * validity (concrete model/effort pairs and command selections), and
 * runtime-map 1:1 consistency. A violation rejects the whole batch.
 */
function checkLiveEditFrontier(
  original: GraphWorkflowExecution,
  next: GraphWorkflowExecution,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const structural = validateWorkflowDefinition(next.workingDefinition);
  if (!structural.ok) {
    return { code: "invalid_edit", issues: structural.errors };
  }

  const frozenPast = checkFrozenPastUnchanged(original, next);
  if (frozenPast.length > 0) {
    return { code: "frozen", issues: frozenPast };
  }

  const resolved = validateResolvedWorkflow(next.workingDefinition);
  if (!resolved.ok) {
    return { code: "invalid_edit", issues: resolved.errors };
  }

  const placementIssues = checkPlacements(next, ctx);
  if (placementIssues.length > 0) {
    return { code: "invalid_edit", issues: placementIssues };
  }

  const commandIssues = checkValidationCommandSelections(next, ctx);
  if (commandIssues.length > 0) {
    const hasOversizedCommand = commandIssues.some(
      (issue) => issue.code === VALIDATION_COST_EXCEEDS_LIMIT_CODE,
    );
    return {
      code: hasOversizedCommand
        ? VALIDATION_COST_EXCEEDS_LIMIT_CODE
        : "invalid_edit",
      issues: commandIssues,
    };
  }

  const pinIssues = checkLiveSessionReadOnlyPin(next);
  if (pinIssues.length > 0) {
    return { code: "invalid_edit", issues: pinIssues };
  }

  const mapIssues = checkRuntimeMapConsistency(next);
  if (mapIssues.length > 0) {
    return { code: "invalid_edit", issues: mapIssues };
  }

  const coverageIssues = checkCriterionMustRunCoverage(original, next, ctx);
  if (coverageIssues.length > 0) {
    return { code: "invalid_edit", issues: coverageIssues };
  }
  return null;
}

/**
 * Frontier check — placement (lwp R1, R10.2), asked of the POST-BATCH working
 * definition through the same composite the authored tier uses, so a lane name,
 * an owned prefix, or a read-only grade means the same thing whether it arrived
 * in a plan or in a live edit.
 *
 * Only a batch that established or rewrote a placement is judged. The check is
 * whole-definition by nature — the pairwise disjointness question is about a
 * PAIR, and the refusal names the lower-indexed member, which need not be the
 * context the batch touched — so running it on every edit would let an execution
 * seeded before placement existed refuse edits that have nothing to do with it.
 *
 * "Concurrent" here is decided by dependency reachability, not by which contexts
 * happen to be running: two lane members that nothing sequences can hold the
 * lane's one worktree at the same time, and an active sibling is exactly the
 * case where that has already happened.
 */
function checkPlacements(
  next: GraphWorkflowExecution,
  ctx: LiveEditOpContext,
): WorkflowGraphValidationError[] {
  if (!ctx.placementTouched) return [];
  return validatePlacements(next.workingDefinition);
}

/**
 * Frontier check — the dirty-worktree exemption's lifetime invariant (R8.3,
 * decision D10). A run admitted over uncommitted changes was admitted BECAUSE
 * its resolved mechanics could not write the repository, so every later
 * structural mutation has to leave that true: a write-capable grade, a lane
 * other than the session, a script-validator selection, or an enabled
 * collaborator would each hand the run a write surface the launch guard never
 * approved.
 *
 * Deliberately unlike {@link checkPlacements}, this is UNCONDITIONAL for a
 * pinned execution: the question is keyed on the run's pin, never on whether
 * the batch claimed to touch placement. Enabling collaboration touches no
 * placement at all and would sail past a placement-scoped gate, and the
 * post-batch state is the only thing that can answer whether the invariant
 * still holds. A clean-worktree launch pins nothing, so this costs an unpinned
 * run one boolean read.
 */
function checkLiveSessionReadOnlyPin(
  next: GraphWorkflowExecution,
): WorkflowGraphValidationError[] {
  if (!next.liveSessionReadOnlyPinned) return [];
  return collectLiveSessionReadOnlyViolations(next.workingDefinition);
}

/**
 * Frontier check #5 — criterion protection (R5.2, decision D11). Skipping a
 * context must never implicitly waive a linked spec acceptance criterion, so
 * every mutation that rides this seam — live edit, expansion, loop unrolling —
 * is refused when it would leave a linked criterion with no covering context
 * that runs on every path. Removing the covering context and putting a guard on
 * an ANCESTOR edge are the same loss, which is why the question is asked of the
 * projection's transitive must-run set rather than of the batch's ops.
 *
 * Only spec-linked executions are locked: the criterion→context map comes from
 * the registered execution contract, which derives nothing for an unlinked
 * definition.
 *
 * The verdict is a property of the POST-BATCH graph, never of what the batch
 * changed: an execution that already carries a gap does not license further
 * edits under it, so a batch that merely leaves the gap standing — or removes
 * the skippable context still nominally covering it — is refused too. The only
 * accepted edit on such an execution is one that restores coverage.
 */
function checkCriterionMustRunCoverage(
  original: GraphWorkflowExecution,
  next: GraphWorkflowExecution,
  ctx: LiveEditOpContext,
): WorkflowGraphValidationError[] {
  const contract = ctx.deps.executionContract;
  if (contract === undefined) return [];

  const before = contract.deriveCriterionContextCoverage(
    original.workingDefinition,
  );
  const after = contract.deriveCriterionContextCoverage(next.workingDefinition);

  // The criteria the LINK carries, not the criteria the result still mentions:
  // a batch that drops the last covering task must read as coverage lost, not as
  // a criterion that stopped existing.
  const linkedCoverage: Record<string, readonly string[]> = {};
  for (const criterionId of Object.keys(before)) {
    linkedCoverage[criterionId] = [];
  }
  Object.assign(linkedCoverage, after);

  return findCriteriaWithoutMustRunCoverage({
    ...next.workingDefinition,
    coverageByCriterionId: linkedCoverage,
  }).map((gap) =>
    liveEditIssue(
      "criterion-must-run-coverage-lost",
      `Acceptance criterion "${gap.criterionId}" would be left without a context that runs on every path${
        gap.coveringContextIds.length === 0
          ? ""
          : ` (covered only by ${gap.coveringContextIds.join(", ")})`
      }`,
      undefined,
      gap.coveringContextIds[0] === undefined
        ? {}
        : { contextId: gap.coveringContextIds[0] },
    ),
  );
}

/** Sorted incoming source-context ids per target — the protected dependency set. */
function incomingEdgeSources(
  execution: GraphWorkflowExecution,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of execution.workingDefinition.edges) {
    const sources = map.get(edge.targetContextId) ?? [];
    sources.push(edge.sourceContextId);
    map.set(edge.targetContextId, sources);
  }
  for (const sources of map.values()) {
    sources.sort();
  }
  return map;
}

/**
 * Frontier check #1 (doc 06): for every context that was `frozen`/`started`
 * BEFORE the batch, its incoming edge set and its completed tasks must be
 * byte-identical afterward, and a `frozen` context's whole definition entry must
 * be unchanged (a `started` context may take permitted prose/config edits while
 * quiescent, so only its completed tasks + incoming edges are pinned).
 */
function checkFrozenPastUnchanged(
  original: GraphWorkflowExecution,
  next: GraphWorkflowExecution,
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];
  const nextContextById = new Map(
    next.workingDefinition.executionContexts.map((entry) => [entry.id, entry]),
  );
  const nextTaskById = new Map(
    next.workingDefinition.tasks.map((task) => [task.id, task]),
  );
  const originalIncoming = incomingEdgeSources(original);
  const nextIncoming = incomingEdgeSources(next);

  for (const context of original.workingDefinition.executionContexts) {
    const lifecycle = classifyContextLifecycle(original, context.id);
    if (lifecycle === "unstarted") continue;

    if (
      !isDeepStrictEqual(
        originalIncoming.get(context.id) ?? [],
        nextIncoming.get(context.id) ?? [],
      )
    ) {
      errors.push(
        liveEditIssue(
          "frozen-incoming-edges-changed",
          `Incoming edges of ${lifecycle} context "${context.id}" cannot change`,
          undefined,
          { contextId: context.id },
        ),
      );
    }

    if (lifecycle === "frozen") {
      const nextContext = nextContextById.get(context.id);
      if (!nextContext || !isDeepStrictEqual(context, nextContext)) {
        errors.push(
          liveEditIssue(
            "frozen-context-changed",
            `Completed context "${context.id}" cannot be edited`,
            undefined,
            { contextId: context.id },
          ),
        );
      }
    }

    for (const task of original.workingDefinition.tasks) {
      if (task.contextId !== context.id) continue;
      if (original.taskStates[task.id]?.status !== "completed") continue;
      const nextTask = nextTaskById.get(task.id);
      if (!nextTask || !isDeepStrictEqual(task, nextTask)) {
        errors.push(
          liveEditIssue(
            "frozen-completed-task-changed",
            `Completed task "${task.id}" cannot be edited or moved`,
            undefined,
            { taskId: task.id, contextId: context.id },
          ),
        );
      }
    }
  }

  return errors;
}

/**
 * Frontier check (validation-concurrency §§3, 6): command selections written by
 * a live edit must be registered and runnable under the global capacity.
 * Scoped to `validationTouchedContextIds` (same rationale as the script-validator
 * prerequisite): a pre-existing bad selection elsewhere never fails an
 * unrelated batch, and a task-only batch never consults the registry.
 */
function checkValidationCommandSelections(
  next: GraphWorkflowExecution,
  ctx: LiveEditOpContext,
): WorkflowGraphValidationError[] {
  if (ctx.validationTouchedContextIds.size === 0 && !ctx.laneMergeTouched) {
    return [];
  }
  const preflight = ctx.deps.validationCommandPreflight();

  const errors: WorkflowGraphValidationError[] = [];
  for (const contextId of ctx.validationTouchedContextIds) {
    const context = findLiveContext(next, contextId);
    if (!context) continue;
    errors.push(
      ...collectValidationCommandIssuesForResolvedContext(
        context,
        preflight,
        next.workingDefinition.laneMergeValidation.commands,
      ),
    );
  }
  if (ctx.laneMergeTouched) {
    errors.push(
      ...collectLaneMergeValidationCommandIssues(
        next.workingDefinition.laneMergeValidation?.commands,
        preflight,
      ),
    );
    for (const context of next.workingDefinition.executionContexts) {
      if (ctx.validationTouchedContextIds.has(context.id)) continue;
      errors.push(
        ...collectValidationCommandIssuesForResolvedContext(
          context,
          preflight,
          next.workingDefinition.laneMergeValidation.commands,
        ).filter(
          (issue) =>
            issue.code === ENVELOPED_SCRIPT_VALIDATION_NOT_COVERED_CODE,
        ),
      );
    }
  }
  return errors;
}

function checkRuntimeMapConsistency(
  execution: GraphWorkflowExecution,
): WorkflowGraphValidationError[] {
  const errors: WorkflowGraphValidationError[] = [];
  const contextIds = new Set(
    execution.workingDefinition.executionContexts.map((entry) => entry.id),
  );
  const stateContextIds = new Set(Object.keys(execution.contextStates));
  for (const contextId of contextIds) {
    if (!stateContextIds.has(contextId)) {
      errors.push(
        liveEditIssue(
          "runtime-map-missing-context-state",
          `Context "${contextId}" has no runtime state`,
          undefined,
          { contextId },
        ),
      );
    }
  }
  for (const contextId of stateContextIds) {
    if (!contextIds.has(contextId)) {
      errors.push(
        liveEditIssue(
          "runtime-map-orphan-context-state",
          `Runtime state references missing context "${contextId}"`,
          undefined,
          { contextId },
        ),
      );
    }
  }

  const taskIds = new Set(
    execution.workingDefinition.tasks.map((entry) => entry.id),
  );
  const stateTaskIds = new Set(Object.keys(execution.taskStates));
  for (const taskId of taskIds) {
    if (!stateTaskIds.has(taskId)) {
      errors.push(
        liveEditIssue(
          "runtime-map-missing-task-state",
          `Task "${taskId}" has no runtime state`,
          undefined,
          { taskId },
        ),
      );
    }
  }
  for (const taskId of stateTaskIds) {
    if (!taskIds.has(taskId)) {
      errors.push(
        liveEditIssue(
          "runtime-map-orphan-task-state",
          `Runtime state references missing task "${taskId}"`,
          undefined,
          { taskId },
        ),
      );
    }
  }

  for (const contextId of execution.activeContextIds) {
    if (!contextIds.has(contextId)) {
      errors.push(
        liveEditIssue(
          "runtime-map-unknown-active-context",
          `activeContextIds references missing context "${contextId}"`,
          undefined,
          { contextId },
        ),
      );
    }
  }

  for (const context of execution.workingDefinition.executionContexts) {
    const state = execution.contextStates[context.id];
    if (!state) continue;
    const total = execution.workingDefinition.tasks.filter(
      (task) => task.contextId === context.id,
    ).length;
    const completed = execution.workingDefinition.tasks.filter(
      (task) =>
        task.contextId === context.id &&
        execution.taskStates[task.id]?.status === "completed",
    ).length;
    if (state.totalTaskCount !== total) {
      errors.push(
        liveEditIssue(
          "runtime-map-total-count-mismatch",
          `Context "${context.id}" totalTaskCount ${state.totalTaskCount} does not match ${total} task(s)`,
          undefined,
          { contextId: context.id },
        ),
      );
    }
    if (state.completedTaskCount !== completed) {
      errors.push(
        liveEditIssue(
          "runtime-map-completed-count-mismatch",
          `Context "${context.id}" completedTaskCount ${state.completedTaskCount} does not match ${completed} completed task(s)`,
          undefined,
          { contextId: context.id },
        ),
      );
    }
  }

  return errors;
}

function zodIssueToValidationError(issue: {
  path: PropertyKey[];
  message: string;
}): WorkflowGraphValidationError {
  const path = issue.path.map((segment) => String(segment)).join(".");
  return {
    code: "invalid-execution",
    message: path ? `${path}: ${issue.message}` : issue.message,
    ...(path ? { field: path } : {}),
  };
}
