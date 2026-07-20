import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createLogger } from "@/lib/logging";
import { assertNever } from "@/lib/shared/assert-never";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  createExecutionIndex,
  type ExecutionIndex,
} from "@/lib/workflow-graph/execution-index";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowContextEdge,
  GraphWorkflowResolvedContext,
  GraphWorkflowTaskDefinition,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  WorkflowLiveEditOperation,
  WorkflowLiveEditRequest,
} from "@/lib/workflows/edit-schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import {
  GraphWorkflowValidationError,
  validateResolvedWorkflow,
  validateWorkflowDefinition,
} from "./validation";
import {
  classifyContextLifecycle,
  classifyExecutionEditability,
} from "./lifecycle-classifier";
import {
  buildInitialContextState,
  buildInitialTaskState,
} from "./execution-state";
import { computeLanePlan, recomputeLanePlanForSubgraph } from "./lane-plan";
import type { DefinitionEditTaskPosition } from "@/lib/workflows/edit-schemas";
import {
  findLockedRegionTouch,
  regionLockedInstruction,
  regionLockedMessage,
  type DefinitionPath,
} from "./locked-regions";

const logger = createLogger("graph-workflow-runtime-edits");

export interface AgentAddedTask {
  slug?: string;
  title: string;
  instructions: string;
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
  ): GraphWorkflowExecution {
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
    // above is enforced here; the core owns task placement, runtime-map sync,
    // and lanePlan recompute. `laneAgentContextId` lets the add bypass the
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

    const execLogger = getExecutionLogger(execution.id);
    execLogger?.task(contextId, "task.added_by_agent", {
      taskId,
      title: task.title,
      instructionsLength: task.instructions.length,
    });
    logger.info("graph-workflow.task.added_by_agent", {
      executionId: execution.id,
      contextId,
      taskId,
      title: task.title,
    });

    return nextExecution;
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
  | "humanApprovalGate"
  | "askUserQuestions"
  | "mutability"
  | "circuitBreaker"
  | "iterationPolicy"
> & {
  collaboration: NonNullable<GraphWorkflowResolvedContext["collaboration"]>;
};

/**
 * Injected capabilities for the pure core — method syntax for bivariant checking
 * (engineering-principles Deps rule). `createTaskId` mints slugs for id-less task
 * adds; `resolvedGlobalDefaults` supplies the `add-context` config base;
 * `hasPreMergeCommand` gates enabling a script validator (frontier invariant #3).
 */
export interface LiveEditDeps {
  createTaskId(): string;
  resolvedGlobalDefaults(): ResolvedContextConfig;
  hasPreMergeCommand(): boolean;
}

export type LiveEditRejectionCode =
  | "frozen"
  | "requires_pause"
  | "region_locked"
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
export interface LiveEditOptions {
  laneAgentContextId?: string;
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
    hasPreMergeCommand() {
      throw new Error("lane-agent add_task does not enable a script validator");
    },
  };
}

interface LiveEditRejection {
  code: LiveEditRejectionCode;
  issues: WorkflowGraphValidationError[];
}

interface LiveEditOpContext {
  quiescent: boolean;
  deps: LiveEditDeps;
  affectedContextIds: Set<string>;
  configTouchedContextIds: Set<string>;
  laneAgentContextId: string | undefined;
}

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
    case "update-context":
      return presentLiveFieldPaths(
        ["executionContexts", operation.contextId],
        value,
        [
          "title",
          "description",
          "acceptanceCriteria",
          "implementer",
          "contextValidator",
          "scriptValidator",
          "humanApprovalGate",
          "askUserQuestions",
          "iterationPolicy",
          "circuitBreaker",
          "mutability",
          "collaboration",
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
          mintLiveEdgeId(
            execution.workingDefinition.edges,
            operation.sourceContextId,
            operation.targetContextId,
          ),
        ],
      ];
    case "remove-edge": {
      const edge = execution.workingDefinition.edges.find(
        (entry) =>
          entry.sourceContextId === operation.sourceContextId &&
          entry.targetContextId === operation.targetContextId,
      );
      return [["edges", edge?.id ?? "unknown"]];
    }
  }
}

type LiveContextConfigOp =
  | Extract<WorkflowLiveEditOperation, { type: "update-context" }>
  | Extract<WorkflowLiveEditOperation, { type: "add-context" }>;

/**
 * Apply an ordered, atomic batch of live edits to a launched execution. Pure —
 * clones the input, applies ops sequentially (so a later op sees an earlier
 * one's result), and rejects the whole batch on the first failing op. On success
 * the runtime maps and lanePlan are re-synced and the whole execution is
 * re-parsed. `liveRevision` is NOT touched here (the route/wrapper owns exactly
 * one increment per accepted mutation).
 */
export function applyLiveExecutionEdits(
  execution: GraphWorkflowExecution,
  request: Pick<WorkflowLiveEditRequest, "operations">,
  deps: LiveEditDeps,
  options: LiveEditOptions = {},
): ApplyLiveExecutionEditsResult {
  const editability = classifyExecutionEditability(execution);
  const quiescent = editability.kind === "editable" && editability.quiescent;

  const next = cloneExecution(execution);
  const affectedContextIds = new Set<string>();
  const configTouchedContextIds = new Set<string>();
  let hasStructuralOp = false;

  const opContext: LiveEditOpContext = {
    quiescent,
    deps,
    affectedContextIds,
    configTouchedContextIds,
    laneAgentContextId: options.laneAgentContextId,
  };

  for (let index = 0; index < request.operations.length; index += 1) {
    const operation = request.operations[index]!;
    const locked = findLockedRegionTouch(
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
        instruction: regionLockedInstruction(locked.sourceUri),
      };
    }
    const rejection = applyLiveEditOperation(next, operation, index, opContext);
    if (rejection) {
      return { ok: false, code: rejection.code, issues: rejection.issues };
    }
    if (isStructuralLiveOp(operation.type)) {
      hasStructuralOp = true;
    }
  }

  // lanePlan: full recompute for structural batches (edge topology changed),
  // subgraph recompute for task-only batches (matches today's add_task).
  if (hasStructuralOp) {
    next.lanePlan = computeLanePlan(next.workingDefinition);
  } else if (affectedContextIds.size > 0) {
    next.lanePlan = recomputeLanePlanForSubgraph({
      definition: next.workingDefinition,
      previousPlan: execution.lanePlan,
      contextIds: Array.from(affectedContextIds),
    });
  }

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

  return {
    ok: true,
    execution: parsed.data,
    affectedContextIds: Array.from(affectedContextIds),
  };
}

function isStructuralLiveOp(type: WorkflowLiveEditOperation["type"]): boolean {
  return (
    type === "add-context" ||
    type === "remove-context" ||
    type === "add-edge" ||
    type === "remove-edge"
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

function applyLiveConfigBlocks(
  context: GraphWorkflowResolvedContext,
  op: LiveContextConfigOp,
): void {
  if (op.implementer !== undefined) context.implementer = op.implementer;
  // `null` disables the validator (matches the resolved context's nullable field).
  if (op.contextValidator !== undefined) {
    context.contextValidator = op.contextValidator;
  }
  if (op.scriptValidator !== undefined) {
    context.scriptValidator = op.scriptValidator;
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
  if (op.collaboration !== undefined) context.collaboration = op.collaboration;
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
    case "remove-edge":
      return applyRemoveEdge(next, operation, index, ctx);
    default:
      return assertNever(
        operation,
        `unhandled live edit operation: ${JSON.stringify(operation)}`,
      );
  }
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
  applyLiveConfigBlocks(context, op);

  ctx.affectedContextIds.add(op.contextId);
  ctx.configTouchedContextIds.add(op.contextId);
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
  const gate = liveContextEditGate(next, op.contextId, ctx.quiescent, index, {
    laneAgent: op.contextId === ctx.laneAgentContextId,
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

  const source =
    op.contextId === ctx.laneAgentContextId ? "agent" : ("user" as const);
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
  if (ctx.quiescent) return null;
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
 * Project a resolved context's config blocks into the `add-context` seed base.
 * Resolved `collaboration` is `.optional()` on legacy executions, but the seed
 * base must always carry one — fall back to resolved global defaults when the
 * source context has no snapshot (doc 06, D11).
 */
function resolvedConfigFromContext(
  source: GraphWorkflowResolvedContext,
  deps: LiveEditDeps,
): ResolvedContextConfig {
  return {
    implementer: source.implementer,
    contextValidator: source.contextValidator,
    scriptValidator: source.scriptValidator,
    humanApprovalGate: source.humanApprovalGate,
    askUserQuestions: source.askUserQuestions,
    mutability: source.mutability,
    circuitBreaker: source.circuitBreaker,
    iterationPolicy: source.iterationPolicy,
    collaboration:
      source.collaboration ?? deps.resolvedGlobalDefaults().collaboration,
  };
}

function applyAddContext(
  next: GraphWorkflowExecution,
  op: Extract<WorkflowLiveEditOperation, { type: "add-context" }>,
  index: number,
  ctx: LiveEditOpContext,
): LiveEditRejection | null {
  const notQuiescent = requireQuiescent(ctx, index);
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
    base = ctx.deps.resolvedGlobalDefaults();
  }

  // Explicit op fields override the seeded base; `contextValidator: null`
  // disables it, so the `!== undefined` guard distinguishes "disable" from
  // "inherit the base". The charter is workflow-global content, copied from the
  // execution to match every resolved context (resolve-config.ts).
  const context: GraphWorkflowResolvedContext = {
    id: op.id,
    title: op.title,
    acceptanceCriteria: op.acceptanceCriteria,
    ...(op.description !== undefined ? { description: op.description } : {}),
    implementer: op.implementer ?? base.implementer,
    contextValidator:
      op.contextValidator !== undefined
        ? op.contextValidator
        : base.contextValidator,
    scriptValidator: op.scriptValidator ?? base.scriptValidator,
    humanApprovalGate: op.humanApprovalGate ?? base.humanApprovalGate,
    askUserQuestions: op.askUserQuestions ?? base.askUserQuestions,
    mutability: op.mutability ?? base.mutability,
    circuitBreaker: op.circuitBreaker ?? base.circuitBreaker,
    iterationPolicy: op.iterationPolicy ?? base.iterationPolicy,
    collaboration: op.collaboration ?? base.collaboration,
    charter: next.charter,
  };
  next.workingDefinition.executionContexts.push(context);
  next.contextStates[op.id] = buildInitialContextState(
    context,
    next.workingDefinition.tasks,
  );

  ctx.affectedContextIds.add(op.id);
  ctx.configTouchedContextIds.add(op.id);
  return null;
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
  const notQuiescent = requireQuiescent(ctx, index);
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

  next.workingDefinition.edges.push({
    id: mintLiveEdgeId(
      next.workingDefinition.edges,
      op.sourceContextId,
      op.targetContextId,
    ),
    sourceContextId: op.sourceContextId,
    targetContextId: op.targetContextId,
  });
  ctx.affectedContextIds.add(op.sourceContextId);
  ctx.affectedContextIds.add(op.targetContextId);
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

  const edge = findLiveEdge(
    next.workingDefinition.edges,
    op.sourceContextId,
    op.targetContextId,
  );
  if (!edge) {
    return rejectLiveEdit(
      "invalid_edit",
      liveEditIssue(
        "unknown-edge",
        `No edge ${op.sourceContextId} → ${op.targetContextId}`,
        index,
        { contextId: op.targetContextId },
      ),
    );
  }

  const targetLifecycle = classifyContextLifecycle(next, op.targetContextId);
  if (targetLifecycle !== "unstarted") {
    return rejectLiveEdit(
      "frozen",
      liveEditIssue(
        "protected-incoming-edge",
        `Cannot remove an incoming edge of ${targetLifecycle} context "${op.targetContextId}"`,
        index,
        { contextId: op.targetContextId },
      ),
    );
  }

  next.workingDefinition.edges = next.workingDefinition.edges.filter(
    (entry) => entry.id !== edge.id,
  );
  ctx.affectedContextIds.add(op.sourceContextId);
  ctx.affectedContextIds.add(op.targetContextId);
  return null;
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
  edges: GraphWorkflowContextEdge[],
  sourceContextId: string,
  targetContextId: string,
): string {
  const base = `${sourceContextId}__${targetContextId}`;
  const existing = new Set(edges.map((edge) => edge.id));
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * The execution-frontier invariant (doc 06, §"The execution-frontier invariant")
 * — the post-batch safety net that guarantees the whole result is legal, beyond
 * what the per-op gates already enforce. In order: graph validity (unique ids,
 * DAG acyclicity), frozen-past unchanged (a completed/started context's prose +
 * config, completed tasks, and incoming edges are byte-identical), resolved-config
 * validity (concrete model/effort pairs, script validator prerequisite), and
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

  const scriptIssues = checkScriptValidatorPrerequisite(next, ctx);
  if (scriptIssues.length > 0) {
    return { code: "invalid_edit", issues: scriptIssues };
  }

  const mapIssues = checkRuntimeMapConsistency(next);
  if (mapIssues.length > 0) {
    return { code: "invalid_edit", issues: mapIssues };
  }
  return null;
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
 * Frontier check #3 tail (doc 06): a context may enable its script validator only
 * when the project defines a `preMergeCommand` — otherwise the
 * `script_validator_missing_command` halt would be baked into the next tick.
 * Scoped to `configTouchedContextIds` so a pre-existing (already-halting) context
 * elsewhere never fails an unrelated task-only batch.
 */
function checkScriptValidatorPrerequisite(
  next: GraphWorkflowExecution,
  ctx: LiveEditOpContext,
): WorkflowGraphValidationError[] {
  if (ctx.configTouchedContextIds.size === 0) return [];
  if (ctx.deps.hasPreMergeCommand()) return [];

  const errors: WorkflowGraphValidationError[] = [];
  for (const contextId of ctx.configTouchedContextIds) {
    const context = findLiveContext(next, contextId);
    if (context?.scriptValidator.enabled) {
      errors.push(
        liveEditIssue(
          "script-validator-missing-command",
          `Context "${contextId}" enables a script validator but the project has no preMergeCommand`,
          undefined,
          { contextId },
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
