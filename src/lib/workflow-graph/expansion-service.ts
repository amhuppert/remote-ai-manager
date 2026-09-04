/**
 * Runtime graph expansion (D4 R6/R7) — the one agent-facing path that grows a
 * RUNNING execution's graph.
 *
 * Two layers, deliberately split:
 *
 * - {@link compileExpansionBatch} is pure. It turns the lane's handle-addressed
 *   payload into deterministic ids and a batch of ADDITIVE live-edit ops, and it
 *   decides the envelope — the closed set of shapes an expansion may take. It
 *   never mutates and never talks to the repository, so the whole envelope is
 *   table-testable against ordinary execution fixtures.
 *
 * - {@link createGraphWorkflowExpansionService} runs that batch through the
 *   prepare/finalize staging seam (`.cc/graph-workflow-docs/mutation-staging-seam.md`):
 *   full validation OUTSIDE the write queue, an O(payload) install INSIDE it
 *   behind the repository-derived fences, with the envelope's time-sensitive
 *   halves — the bound implementer conversation and each rejoin target's
 *   unstarted/unreserved state — re-checked in the lock before anything lands.
 *
 * The service composes its ops through `applyLiveExecutionEdits`' shared core
 * rather than writing to the repository itself, so it inherits every invariant
 * that core enforces: Kahn acyclicity, the execution-frontier checks, the
 * criterion must-run coverage lock, the loop-composition refusals (R11.1), and
 * the route-control revision bump. There is deliberately no second mutation
 * path — the envelope here NARROWS what the core already permits, it never
 * widens it.
 *
 * Idempotency, caps, and receipts ride on top of that, in a deliberate ORDER:
 * a request is identified by the canonical hash of its payload, classified
 * against the durable receipt ledger BEFORE any cap is consulted (or the very
 * request that spent the last budget slot would be refused when its own lane
 * retried it), and only then measured against the ceilings. An acceptance
 * receipt commits in the same mutation as the graph change; a refusal commits a
 * ring receipt in a mutation that changes nothing else.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import { createLogger } from "@/lib/logging";
import type { AgentAssignment } from "@/lib/workflow-graph/config-schemas";
import {
  contextOutputSchemaSchema,
  contextPlacementSchema,
} from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowGraphValidationError } from "@/lib/workflow-graph/definition-schemas";
import { acceptanceCriteriaSchema } from "./criteria/criterion-records";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type {
  GraphWorkflowEventDelivery,
  PublishGraphExpansionInput,
  PublishLiveEditAppliedInput,
} from "./execution-events";
import type { MutateActiveResult } from "./execution-repository";
import {
  compileGeneratedChildConfig,
  generatedChildConfigOverrideSchema,
  resolvedContextConfig,
} from "./generated-child-config";
import {
  EXPANSION_REQUEST_ID_REUSED,
  checkExpansionBudgetCaps,
  checkExpansionRequestCaps,
  classifyExpansionAttempt,
  expansionReuseMessage,
  recordExpansionAcceptance,
  recordExpansionRefusal,
} from "./expansion-receipts";
import {
  expansionCanonicalByteLength,
  expansionCanonicalPayload,
  expansionPayloadHash,
} from "./expansion-payload";
import { classifyContextLifecycle } from "./lifecycle-classifier";
import { resolveBoundConversationId } from "./lane-binding";
import {
  finalizePreparedEdits,
  prepareLiveExecutionEdits,
  type LiveEditDeps,
  type PreparedLiveEdits,
  type ResolvedContextConfig,
} from "./runtime-edits";
import {
  prepareLiveEditAssignmentSnapshots,
  type PrepareAssignmentSnapshotsResult,
} from "./live-edit-preparation";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExpansionAcceptanceReceipt,
  GraphWorkflowExpansionRefusalReceipt,
} from "./schemas";
import {
  createRegisteredGraphExecutionContract,
  type GraphExecutionContract,
} from "./execution-contract-port";

const logger = createLogger("graph-workflow-expansion");

/**
 * Handles are the agent's own local names for the nodes it is creating. Kebab
 * only — no underscores, which keeps a handle structurally incapable of
 * inhabiting the reserved `__p<K>__` loop-instance namespace, and no dots or
 * slashes, which keeps a minted id safe in a URL segment.
 */
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const expansionHandleSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(HANDLE_PATTERN, "handle must be kebab-case (a-z, 0-9, -)");

const expansionContextSchema = z
  .object({
    handle: expansionHandleSchema,
    title: z.string().trim().min(1).max(200),
    // Prose or {id, statement} records (#69 change 4 stage 1); the compiler
    // copies the value verbatim onto the generated add-context operation.
    acceptanceCriteria: acceptanceCriteriaSchema,
    description: z.string().trim().min(1).optional(),
    outputSchema: contextOutputSchemaSchema.optional(),
    /**
     * Where this context runs and what it may write (lwp R10.1). REQUIRED of
     * every generated context, but parsed as optional so a payload that omits it
     * is refused by the compiler with a code naming the handle rather than by a
     * schema error naming an array index — the same reason the lane grammar
     * itself is checked at accept time rather than in the Zod shape.
     */
    placement: contextPlacementSchema.optional(),
    /**
     * A PRE-EXISTING context to seed this child's TUNING config from. Never a
     * sibling this batch creates: seeding from one would make the compiled
     * config depend on operation order, and a batch is one proposition about
     * the graph. Protected blocks ignore this entirely (see
     * `generated-child-config.ts`).
     */
    configFromContextId: z.string().trim().min(1).optional(),
    config: generatedChildConfigOverrideSchema.optional(),
  })
  .strict();

const expansionTaskSchema = z
  .object({
    /**
     * The batch handle this task belongs to. Flat rather than nested under the
     * context on purpose: R6's "every task targets a batch-created context" is
     * a REFUSAL, and a refusal you cannot express is a refusal you cannot test.
     */
    contextHandle: z.string().trim().min(1),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1),
  })
  .strict();

const expansionEdgeSchema = z
  .object({
    /** The invoker's context id, or a batch handle. */
    from: z.string().trim().min(1),
    /** A batch handle, or a pre-declared rejoin context's id. */
    to: z.string().trim().min(1),
  })
  .strict();

/**
 * The agent-facing expansion payload. `.strict()` at every level is
 * load-bearing: it is what makes "no remove/update/move/reorder op" a property
 * of the vocabulary rather than a check someone has to remember — the payload
 * simply has nowhere to put one.
 */
export const graphExpansionRequestSchema = z
  .object({
    /** The lane's idempotency key. Single-use; the idempotency slice keys receipts on it. */
    requestId: z.string().trim().min(1).max(200),
    /** Why the lane is expanding — audited with the receipt. */
    rationale: z.string().trim().min(1).max(4000),
    /** ≥1 by construction: an expansion that creates no context is not one. */
    contexts: z.array(expansionContextSchema).min(1),
    /** ≥1 by construction: a generated context with zero tasks is refused (R7). */
    tasks: z.array(expansionTaskSchema).min(1),
    edges: z.array(expansionEdgeSchema).default([]),
  })
  .strict();

export type GraphExpansionRequest = z.infer<typeof graphExpansionRequestSchema>;

/**
 * The identity a typed refusal event needs when the expansion never reaches the
 * service — the route refuses an unauthorized lane or an unparseable payload
 * before there is an execution to read (R6.2).
 */
export interface ExpansionRefusalNotice {
  projectPath: string;
  sessionName: string;
  /** Empty when the refused body named none. */
  executionId: string;
  invokerContextId: string;
  /** Empty when the refused body named none. */
  requestId: string;
  refusalCode: string;
}

/**
 * The one shape a refused expansion event takes, wherever the refusal is
 * decided. Both refusal sites — the route's pre-service gates and the service's
 * own envelope — build their event through this, so "refused" means the same row
 * either way: no ids added, and the refusal code the lane was told.
 */
export function expansionRefusalEventInput(
  notice: ExpansionRefusalNotice,
  occurredAt: string,
): PublishGraphExpansionInput {
  return {
    projectPath: notice.projectPath,
    sessionName: notice.sessionName,
    executionId: notice.executionId,
    invokerContextId: notice.invokerContextId,
    requestId: notice.requestId,
    outcome: "refused",
    addedContextIds: [],
    addedTaskIds: [],
    rejoinContextIds: [],
    refusalCode: notice.refusalCode,
    occurredAt,
  };
}

/**
 * The live-edit verbs an expansion may not express. `graphExpansionRequestSchema`
 * is `.strict()`, so a payload carrying one is already refused — this only
 * decides WHICH refusal the lane is told about.
 */
const NON_ADDITIVE_OPERATION_PATTERN = /^(remove|update|move|reorder)-[a-z-]+$/;

/** Depth cap for the refusal scan: a payload this deep is malformed regardless. */
const REFUSAL_SCAN_MAX_DEPTH = 8;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Does any node in this payload declare a non-additive operation `type`? Read
 * through own properties only, so a payload whose prototype was poisoned with a
 * `type` cannot borrow a verdict it never declared.
 *
 * Only a `type` FIELD counts — not any string that happens to match — so a
 * rationale explaining why the lane is not removing something is still just
 * prose.
 */
function declaresNonAdditiveOperation(value: unknown, depth: number): boolean {
  if (depth > REFUSAL_SCAN_MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.some((item) => declaresNonAdditiveOperation(item, depth + 1));
  }
  if (typeof value !== "object" || value === null) return false;

  const type = hasOwn(value, "type")
    ? (value as Record<string, unknown>)["type"]
    : undefined;
  if (typeof type === "string" && NON_ADDITIVE_OPERATION_PATTERN.test(type)) {
    return true;
  }

  return Object.entries(value).some(([, child]) =>
    declaresNonAdditiveOperation(child, depth + 1),
  );
}

/**
 * The refusal code for a payload `graphExpansionRequestSchema` rejected. R6.2
 * names the smuggled remove/update/move/reorder op as its own envelope
 * violation, so a lane that tried one is told that rather than "the payload did
 * not parse" — the distinction is the difference between "fix your JSON" and
 * "expansion is additive-only; ask a human to restructure the graph".
 */
export function classifyExpansionPayloadRefusal(body: unknown): string {
  return declaresNonAdditiveOperation(body, 0)
    ? "expansion-non-additive-operation"
    : "expansion-payload-invalid";
}

export interface CompiledExpansion {
  /** Additive live-edit ops in dependency order: contexts, tasks, then edges. */
  operations: WorkflowLiveEditOperation[];
  /** Execution-pinned implementer bytes inherited from a non-invoker seed. */
  inheritedImplementerSnapshots: Readonly<Record<string, AgentProfileSnapshot>>;
  createdContextIds: string[];
  createdTaskIds: string[];
  /** Pre-existing contexts this batch rejoins, deduplicated and sorted. */
  rejoinContextIds: string[];
  contextIdByHandle: Readonly<Record<string, string>>;
}

function copyAssignment(assignment: AgentAssignment): AgentAssignment {
  return {
    id: assignment.id,
    profile: { ...assignment.profile },
    ...(assignment.focus !== undefined ? { focus: assignment.focus } : {}),
    agent: structuredClone(assignment.agent),
  };
}

export type CompileExpansionResult =
  | { ok: true; compiled: CompiledExpansion }
  | { ok: false; issues: WorkflowGraphValidationError[] };

function assignmentPreparationPlan(batch: CompiledExpansion): {
  operations: WorkflowLiveEditOperation[];
  inheritedSnapshotByAssignment: ReadonlyMap<
    AgentAssignment,
    AgentProfileSnapshot
  >;
} {
  const inheritedSnapshotByAssignment = new Map<
    AgentAssignment,
    AgentProfileSnapshot
  >();
  const operations = batch.operations.map((operation) => {
    if (operation.type !== "add-context") return operation;
    const snapshot = batch.inheritedImplementerSnapshots[operation.id];
    if (snapshot === undefined || operation.implementer === undefined) {
      return operation;
    }

    // The compiler copied this assignment into a unique operation object and
    // recorded its trusted execution snapshot separately. Removing it from the
    // generic preparation batch prevents a later library edit from replacing
    // those bytes, while same-profile payload overrides still resolve afresh.
    inheritedSnapshotByAssignment.set(operation.implementer, snapshot);
    const { implementer: _inheritedImplementer, ...operationToPrepare } =
      operation;
    return operationToPrepare as WorkflowLiveEditOperation;
  });

  return { operations, inheritedSnapshotByAssignment };
}

function issue(
  code: string,
  message: string,
  extra: Partial<WorkflowGraphValidationError> = {},
): WorkflowGraphValidationError {
  return { code, message, ...extra };
}

function refuse(
  code: string,
  message: string,
  extra: Partial<WorkflowGraphValidationError> = {},
): CompileExpansionResult {
  return { ok: false, issues: [issue(code, message, extra)] };
}

/**
 * The deterministic id a handle compiles to. Derived from (invoker, requestId,
 * handle) so the SAME request always compiles to the SAME graph — which is what
 * lets a retry be recognised as a replay rather than producing a second,
 * near-identical subgraph. The handle stays in the id because these ids are read
 * by humans in the inspector and by agents in prompts.
 */
export function expansionContextId(
  invokerContextId: string,
  requestId: string,
  handle: string,
): string {
  const digest = createHash("sha256")
    .update(`${invokerContextId} ${requestId}`)
    .digest("hex")
    .slice(0, 8);
  return `${invokerContextId}-x${digest}-${handle}`;
}

function expansionTaskId(contextId: string, ordinal: number): string {
  return `${contextId}-t${ordinal}`;
}

/** Forward reachability over a set of directed edges, from one root. */
function reachableFrom(
  root: string,
  edges: readonly { from: string; to: string }[],
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * Is a pre-existing context RESERVED — has the engine already committed to
 * running it? A scheduling reservation, a lane assignment, or a persisted
 * landing intent each mean a decision about this context has been taken, and
 * adding an incoming dependency after that point would reshape work already in
 * flight. Checked at compile AND re-checked inside the serialized mutation,
 * because all three can be stamped between the two.
 */
function isContextReserved(
  execution: GraphWorkflowExecution,
  contextId: string,
): boolean {
  const state = execution.contextStates[contextId];
  if (!state) return false;
  return (
    state.reservedByBatchId != null ||
    state.laneId !== null ||
    state.landingIntent !== null
  );
}

/**
 * Why a rejoin target may not gain an incoming edge, or `null` when it may.
 *
 * Reservation is a STRICTER reading of the same evidence the lifecycle
 * classifier already refuses on — every reservation marker is runtime state, so
 * a reserved context never classifies `unstarted` — but R6 names the two
 * refusals separately, and a lane told "already reserved" learns something a
 * lane told "started" does not. So the status decides which verdict fits: a
 * context still `pending` that carries a reservation is reserved; anything that
 * has actually moved is started.
 */
function rejoinTargetRefusal(
  execution: GraphWorkflowExecution,
  contextId: string,
): { code: string; message: string } | null {
  const lifecycle = classifyContextLifecycle(execution, contextId);
  if (lifecycle === "unstarted") return null;
  if (
    execution.contextStates[contextId]?.status === "pending" &&
    isContextReserved(execution, contextId)
  ) {
    return {
      code: "expansion-rejoin-reserved",
      message: `Rejoin target "${contextId}" is already reserved for execution`,
    };
  }
  return {
    code: "expansion-rejoin-started",
    message: `Rejoin target "${contextId}" is ${lifecycle}; only an unstarted, unreserved context may gain an incoming edge`,
  };
}

/**
 * Compile a lane's expansion payload into an additive live-edit batch, or
 * refuse it. Every refusal is fail-closed and whole-batch: an expansion is one
 * proposition about the shape of the graph, so half of it is never an answer.
 */
export function compileExpansionBatch(input: {
  execution: GraphWorkflowExecution;
  invokerContextId: string;
  request: GraphExpansionRequest;
  /** Collaboration fallback for resolved contexts seeded before that snapshot existed. */
  resolvedGlobalDefaults: ResolvedContextConfig;
}): CompileExpansionResult {
  const { execution, invokerContextId, request, resolvedGlobalDefaults } =
    input;
  const definition = execution.workingDefinition;

  const invoker = definition.executionContexts.find(
    (context) => context.id === invokerContextId,
  );
  if (!invoker) {
    return refuse(
      "expansion-invoker-not-found",
      `No context "${invokerContextId}" in this execution`,
      { contextId: invokerContextId },
    );
  }
  if (invoker.mutability.allowAgentContextAdd !== true) {
    return refuse(
      "expansion-not-authorized",
      `Context "${invokerContextId}" does not allow agent graph expansion (mutability.allowAgentContextAdd is disabled)`,
      { contextId: invokerContextId },
    );
  }
  if (execution.status !== "running") {
    return refuse(
      "expansion-execution-not-running",
      `Graph expansion is allowed only while the execution is running (status "${execution.status}")`,
    );
  }
  if (
    execution.contextStates[invokerContextId]?.status !== "running" ||
    !execution.activeContextIds.includes(invokerContextId)
  ) {
    return refuse(
      "expansion-invoker-not-running",
      `Context "${invokerContextId}" is not a running, active context`,
      { contextId: invokerContextId },
    );
  }

  const existingContextIds = new Set(
    definition.executionContexts.map((context) => context.id),
  );

  // --- handles -------------------------------------------------------------
  const contextIdByHandle = new Map<string, string>();
  for (const context of request.contexts) {
    // Placement is required of generated contexts (lwp R10.1). There is no
    // inherit-from-invoker fallback: sharing a lane is a claim about concurrency
    // and ownership between two specific contexts, and a lane an agent did not
    // choose is exactly the claim it cannot have meant to make.
    if (context.placement === undefined) {
      return refuse(
        "expansion-placement-missing",
        `Generated context "${context.handle}" declares no placement; every expansion context must name the lane it runs on and what it may write`,
      );
    }
    if (contextIdByHandle.has(context.handle)) {
      return refuse(
        "expansion-duplicate-handle",
        `Handle "${context.handle}" is declared twice in this request`,
      );
    }
    if (existingContextIds.has(context.handle)) {
      // Endpoint resolution reads a handle first, so a handle that shadows an
      // existing context id would make an edge silently mean the wrong thing.
      return refuse(
        "expansion-handle-shadows-context",
        `Handle "${context.handle}" collides with existing context "${context.handle}"`,
        { contextId: context.handle },
      );
    }
    const contextId = expansionContextId(
      invokerContextId,
      request.requestId,
      context.handle,
    );
    if (existingContextIds.has(contextId)) {
      return refuse(
        "expansion-context-id-taken",
        `Generated context id "${contextId}" already exists in this execution`,
        { contextId },
      );
    }
    contextIdByHandle.set(context.handle, contextId);
  }

  // --- tasks ---------------------------------------------------------------
  const taskCountByHandle = new Map<string, number>();
  const taskOperations: WorkflowLiveEditOperation[] = [];
  const createdTaskIds: string[] = [];
  for (const task of request.tasks) {
    const contextId = contextIdByHandle.get(task.contextHandle);
    if (contextId === undefined) {
      return refuse(
        "expansion-task-target-not-in-batch",
        `Task "${task.title}" targets "${task.contextHandle}", which this request does not create; expansion may only add tasks to the contexts it creates`,
      );
    }
    const ordinal = (taskCountByHandle.get(task.contextHandle) ?? 0) + 1;
    taskCountByHandle.set(task.contextHandle, ordinal);
    const taskId = expansionTaskId(contextId, ordinal);
    createdTaskIds.push(taskId);
    taskOperations.push({
      type: "add-task",
      id: taskId,
      contextId,
      title: task.title,
      instructions: task.instructions,
    });
  }
  for (const context of request.contexts) {
    if ((taskCountByHandle.get(context.handle) ?? 0) === 0) {
      return refuse(
        "expansion-context-without-task",
        `Generated context "${context.handle}" carries no tasks`,
      );
    }
  }

  // --- edges ---------------------------------------------------------------
  const rejoinContextIds = new Set<string>();
  const edgeOperations: WorkflowLiveEditOperation[] = [];
  const resolvedEdges: { from: string; to: string }[] = [];
  for (const edge of request.edges) {
    const sourceId =
      edge.from === invokerContextId
        ? invokerContextId
        : contextIdByHandle.get(edge.from);
    if (sourceId === undefined) {
      return refuse(
        "expansion-edge-source-outside-batch",
        `Edge source "${edge.from}" is neither the invoking context nor a context this request creates`,
        { contextId: edge.from },
      );
    }

    const batchTargetId = contextIdByHandle.get(edge.to);
    let targetId: string;
    if (batchTargetId !== undefined) {
      targetId = batchTargetId;
    } else {
      // A pre-declared rejoin target. Each is admitted individually, and a
      // batch with any failing target is refused whole.
      if (!existingContextIds.has(edge.to)) {
        return refuse(
          "expansion-edge-target-unknown",
          `Edge target "${edge.to}" is neither a context this request creates nor an existing context`,
          { contextId: edge.to },
        );
      }
      if (
        !reachableFrom(
          invokerContextId,
          definition.edges.map((existing) => ({
            from: existing.sourceContextId,
            to: existing.targetContextId,
          })),
        ).has(edge.to)
      ) {
        return refuse(
          "expansion-rejoin-not-downstream",
          `Rejoin target "${edge.to}" is not downstream of "${invokerContextId}"`,
          { contextId: edge.to },
        );
      }
      const unavailable = rejoinTargetRefusal(execution, edge.to);
      if (unavailable) {
        return refuse(unavailable.code, unavailable.message, {
          contextId: edge.to,
        });
      }
      targetId = edge.to;
      rejoinContextIds.add(edge.to);
    }

    resolvedEdges.push({ from: sourceId, to: targetId });
    edgeOperations.push({
      type: "add-edge",
      sourceContextId: sourceId,
      targetContextId: targetId,
    });
  }

  // --- reachability --------------------------------------------------------
  const reachable = reachableFrom(invokerContextId, resolvedEdges);
  for (const [handle, contextId] of contextIdByHandle) {
    if (!reachable.has(contextId)) {
      return refuse(
        "expansion-context-unreachable",
        `Generated context "${handle}" is not reachable from "${invokerContextId}"`,
        { contextId },
      );
    }
  }

  // --- child config --------------------------------------------------------
  // The compiler decides every block here, then expresses that decision through
  // the live-edit boundary without turning inherited controls into new edits:
  // protected blocks seed from the invoker, while tuning blocks and the stamped
  // mutability are explicit. This preserves execution-pinned cohort and command
  // snapshots across later profile-library and command-registry changes.
  const invokerConfig = resolvedContextConfig(
    invoker,
    resolvedGlobalDefaults.collaboration,
    resolvedGlobalDefaults.agentValidation,
    resolvedGlobalDefaults.memory,
  );
  const contextOperations: WorkflowLiveEditOperation[] = [];
  const inheritedImplementerSnapshots: Record<string, AgentProfileSnapshot> =
    {};
  for (const context of request.contexts) {
    let seed: ResolvedContextConfig | null = null;
    if (context.configFromContextId !== undefined) {
      const source = definition.executionContexts.find(
        (candidate) => candidate.id === context.configFromContextId,
      );
      if (!source) {
        return refuse(
          "expansion-config-source-unknown",
          `configFromContextId "${context.configFromContextId}" is not an existing context in this execution`,
          { contextId: context.configFromContextId },
        );
      }
      seed = resolvedContextConfig(
        source,
        resolvedGlobalDefaults.collaboration,
        resolvedGlobalDefaults.agentValidation,
        resolvedGlobalDefaults.memory,
      );
    }

    const childConfig = compileGeneratedChildConfig({
      invoker: invokerConfig,
      seed,
      overrides: context.config,
    });
    if (!childConfig.ok) {
      return { ok: false, issues: childConfig.issues };
    }

    const childContextId =
      contextIdByHandle.get(context.handle) ?? context.handle;
    const hasPayloadImplementer = context.config?.implementer !== undefined;
    const inheritsNonInvokerImplementer =
      !hasPayloadImplementer &&
      context.configFromContextId !== undefined &&
      context.configFromContextId !== invokerContextId;
    const explicitImplementer =
      hasPayloadImplementer || inheritsNonInvokerImplementer
        ? copyAssignment(childConfig.config.implementer)
        : undefined;
    if (inheritsNonInvokerImplementer && seed !== null) {
      inheritedImplementerSnapshots[childContextId] = structuredClone(
        seed.implementer.profileSnapshot,
      );
    }

    contextOperations.push({
      type: "add-context",
      id: childContextId,
      title: context.title,
      acceptanceCriteria: context.acceptanceCriteria,
      ...(context.description !== undefined
        ? { description: context.description }
        : {}),
      ...(context.outputSchema !== undefined
        ? { outputSchema: context.outputSchema }
        : {}),
      // Never seeded from `configFromContextId`, for the same reason the live
      // add refuses to: a lane and its owned prefixes are the one thing two
      // contexts must not share by accident. The handle loop above already
      // refused a payload that omitted it.
      ...(context.placement !== undefined
        ? { placement: context.placement }
        : {}),
      configFromContextId: invokerContextId,
      ...(explicitImplementer !== undefined
        ? { implementer: explicitImplementer }
        : {}),
      iterationPolicy: childConfig.config.iterationPolicy,
      circuitBreaker: childConfig.config.circuitBreaker,
      scriptValidator: childConfig.config.scriptValidator,
      mutability: childConfig.config.mutability,
    });
  }

  return {
    ok: true,
    compiled: {
      operations: [...contextOperations, ...taskOperations, ...edgeOperations],
      inheritedImplementerSnapshots,
      createdContextIds: [...contextIdByHandle.values()],
      createdTaskIds,
      rejoinContextIds: [...rejoinContextIds].sort(),
      contextIdByHandle: Object.fromEntries(contextIdByHandle),
    },
  };
}

// ============================================================
// The service
// ============================================================

export interface GraphWorkflowExpansionServiceDeps {
  getActiveExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  mutateActive(
    projectPath: string,
    sessionName: string,
    fn: (
      execution: GraphWorkflowExecution,
    ) => MutateActiveResult | GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution>;
  buildLiveEditDeps(projectPath: string): Promise<LiveEditDeps>;
  executionContract?: GraphExecutionContract;
  /** Resolve every assignment introduced by the compiled batch before mutation. */
  prepareAssignmentSnapshots?(
    projectPath: string,
    operations: readonly WorkflowLiveEditOperation[],
  ): Promise<PrepareAssignmentSnapshotsResult>;
  publishLiveEditApplied(
    input: PublishLiveEditAppliedInput,
  ): GraphWorkflowEventDelivery;
  publishGraphExpansion(
    input: PublishGraphExpansionInput,
  ): GraphWorkflowEventDelivery;
  /** Broadcast a delivery that has no mutation to ride — refusals only. */
  deliver(delivery: GraphWorkflowEventDelivery): void;
  now(): string;
}

export interface GraphExpansionInput {
  projectPath: string;
  sessionName: string;
  /** The execution the lane believes it is running in (stale-lane guard). */
  executionId: string;
  contextId: string;
  /** The lane's conversation, from its verified capability. */
  conversationId: string;
  request: GraphExpansionRequest;
}

export type GraphExpansionOutcome =
  | {
      ok: true;
      /**
       * True when this answer came from a permanent acceptance receipt rather
       * than a fresh mutation — the same (invoker, requestId, payload hash) was
       * already applied, so the graph was not touched again.
       */
      replayed: boolean;
      liveRevision: number;
      createdContextIds: string[];
      createdTaskIds: string[];
      rejoinContextIds: string[];
    }
  | {
      ok: false;
      /** Maps onto the HTTP contract: `forbidden` → 403, the rest → 409. */
      kind: "no_active_execution" | "forbidden" | "refused" | "conflict";
      issues: WorkflowGraphValidationError[];
    };

type ExpansionRefusalKind = Exclude<
  Extract<GraphExpansionOutcome, { ok: false }>["kind"],
  "no_active_execution"
>;

/**
 * The two refusals that mean "this lane may not ask", as opposed to "this
 * request is malformed" — the only ones that map to 403. Read from the refusal
 * CODE so a replayed receipt reports the same status the original refusal did.
 */
const FORBIDDEN_REFUSAL_CODES: readonly string[] = [
  "expansion-not-authorized",
  "expansion-lane-not-bound",
];

function refusalKindFor(code: string | undefined): ExpansionRefusalKind {
  return FORBIDDEN_REFUSAL_CODES.includes(code ?? "") ? "forbidden" : "refused";
}

/**
 * A refusal decided inside the reducer. Thrown so the mutation aborts and
 * nothing persists — the same shape the live-edit apply pipeline uses.
 */
class ExpansionRefusalSignal extends Error {
  constructor(
    readonly kind: ExpansionRefusalKind,
    readonly issues: WorkflowGraphValidationError[],
  ) {
    super(issues[0]?.message ?? "graph expansion refused");
    this.name = "ExpansionRefusalSignal";
  }
}

/**
 * The active execution was replaced between validating an attempt and
 * committing its refusal receipt. Thrown inside the reducer to abort the write
 * rather than file the receipt against an execution it does not describe.
 */
class ExpansionExecutionSwapped extends Error {
  constructor(readonly activeExecutionId: string) {
    super(
      `The active execution changed to "${activeExecutionId}" before the refusal receipt could be committed`,
    );
    this.name = "ExpansionExecutionSwapped";
  }
}

/**
 * How many times a staged batch may be re-prepared before giving up. A
 * reprepare means the graph moved under the batch between prepare and finalize;
 * retrying is correct, but retrying forever under a busy scheduler is not — the
 * lane gets a conflict it can act on instead.
 */
const MAX_PREPARE_ATTEMPTS = 3;

/**
 * The envelope halves that can change between compile and commit. Re-checked
 * inside the serialized mutation so a rejoin target that got dispatched, or a
 * lane that lost its binding, cannot be caught by a batch validated a moment
 * earlier. Everything else the compile decided is fenced by the staging seam's
 * `structuralRevision`.
 */
function recheckVolatileEnvelope(
  current: GraphWorkflowExecution,
  input: {
    contextId: string;
    conversationId: string;
    rejoinContextIds: readonly string[];
  },
): WorkflowGraphValidationError[] {
  const issues: WorkflowGraphValidationError[] = [];

  const bound = resolveBoundConversationId(current, input.contextId);
  if (bound !== input.conversationId) {
    issues.push(
      issue(
        "expansion-lane-not-bound",
        `Conversation "${input.conversationId}" is no longer the implementer bound to context "${input.contextId}"`,
        { contextId: input.contextId },
      ),
    );
  }

  const invoker = current.workingDefinition.executionContexts.find(
    (context) => context.id === input.contextId,
  );
  if (invoker?.mutability.allowAgentContextAdd !== true) {
    issues.push(
      issue(
        "expansion-not-authorized",
        `Context "${input.contextId}" does not allow agent graph expansion (mutability.allowAgentContextAdd is disabled)`,
        { contextId: input.contextId },
      ),
    );
  }

  for (const rejoinId of input.rejoinContextIds) {
    const unavailable = rejoinTargetRefusal(current, rejoinId);
    if (unavailable) {
      issues.push(
        issue(unavailable.code, unavailable.message, { contextId: rejoinId }),
      );
    }
  }

  return issues;
}

export function createGraphWorkflowExpansionService(
  deps: GraphWorkflowExpansionServiceDeps,
) {
  const executionContract =
    deps.executionContract ?? createRegisteredGraphExecutionContract();

  function refusalDelivery(
    input: GraphExpansionInput,
    refusalCode: string,
  ): GraphWorkflowEventDelivery {
    return deps.publishGraphExpansion(
      expansionRefusalEventInput(
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          executionId: input.executionId,
          invokerContextId: input.contextId,
          requestId: input.request.requestId,
          refusalCode,
        },
        deps.now(),
      ),
    );
  }

  /**
   * Refuse without touching the graph, and make the refusal DURABLE.
   *
   * The typed event and the ring receipt commit together in one mutation that
   * changes nothing else — no graph edit, no `liveRevision` bump — because the
   * receipt is what lets the next identical retry be answered from the ledger
   * instead of re-validated. The ring is bounded at
   * `EXPANSION_CAPS.refusalRingSize`, so a misbehaving lane cannot grow state
   * by being refused; it can only rotate its own entries out.
   *
   * If that commit fails, the lane is still owed an answer and the refusal is
   * still owed an audit row, so the event falls back to a plain broadcast — the
   * pre-receipt behaviour, with the durability lost rather than the whole
   * refusal.
   *
   * The commit is FENCED by execution id. `mutateActive` writes whatever is
   * active at commit time, not what was validated a moment earlier, so an
   * execution replaced mid-attempt would otherwise receive this attempt's
   * receipt while the event still names the old execution. The ledger is
   * per-execution state: a foreign receipt would let the replacement answer a
   * genuinely unknown request from it instead of validating it as NEW (R6.3).
   * The acceptance path is already fenced the same way, inside
   * `finalizePreparedEdits` (`execution-mismatch`).
   */
  async function refused(
    input: GraphExpansionInput,
    payloadHash: string,
    kind: ExpansionRefusalKind,
    issues: WorkflowGraphValidationError[],
  ): Promise<GraphExpansionOutcome> {
    const refusalCode = issues[0]?.code ?? "expansion-refused";
    logger.warn("graph_expansion.refused", {
      executionId: input.executionId,
      contextId: input.contextId,
      requestId: input.request.requestId,
      kind,
      refusalCode,
      issueCount: issues.length,
    });

    const receipt: GraphWorkflowExpansionRefusalReceipt = {
      requestId: input.request.requestId,
      payloadHash,
      invokerContextId: input.contextId,
      refusalCode,
      refusedAt: deps.now(),
    };
    try {
      await deps.mutateActive(
        input.projectPath,
        input.sessionName,
        (current) => {
          if (current.id !== input.executionId) {
            // Throwing aborts the whole mutation: the repository delivers
            // events only AFTER the transaction commits, so nothing is written
            // and nothing is published from in here.
            throw new ExpansionExecutionSwapped(current.id);
          }
          const delivery = refusalDelivery(input, refusalCode);
          return {
            execution: {
              ...current,
              expansionReceipts: recordExpansionRefusal(
                current.expansionReceipts,
                receipt,
              ),
            },
            events: delivery.events,
            pushes: delivery.pushes,
          };
        },
      );
    } catch (error) {
      if (error instanceof ExpansionExecutionSwapped) {
        // Expected interleaving, not a fault: the execution this attempt was
        // validated against is gone, so its receipt has nowhere durable to
        // live. Losing it is correct — the replacement must treat a repeat as
        // NEW.
        logger.warn("graph_expansion.refusal_receipt_execution_swapped", {
          executionId: input.executionId,
          activeExecutionId: error.activeExecutionId,
          contextId: input.contextId,
          requestId: input.request.requestId,
          refusalCode,
        });
      } else {
        logger.error("graph_expansion.refusal_receipt_failed", {
          executionId: input.executionId,
          contextId: input.contextId,
          requestId: input.request.requestId,
          refusalCode,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      deps.deliver(refusalDelivery(input, refusalCode));
    }

    return { ok: false, kind, issues };
  }

  /**
   * Answer a retry from its retained refusal receipt. Nothing is re-validated
   * and nothing is recorded — the ring already holds this exact attempt, and
   * re-recording it would let a retry loop keep its own entry alive at the
   * expense of the other nineteen.
   */
  function replayRefusal(
    input: GraphExpansionInput,
    receipt: GraphWorkflowExpansionRefusalReceipt,
  ): GraphExpansionOutcome {
    logger.info("graph_expansion.refusal_replayed", {
      executionId: input.executionId,
      contextId: input.contextId,
      requestId: input.request.requestId,
      refusalCode: receipt.refusalCode,
    });
    deps.deliver(refusalDelivery(input, receipt.refusalCode));
    return {
      ok: false,
      kind: refusalKindFor(receipt.refusalCode),
      issues: [
        issue(
          receipt.refusalCode,
          `This request was already refused (${receipt.refusalCode}); expansion requestIds are single-use, so retry with a new requestId`,
          { contextId: input.contextId },
        ),
      ],
    };
  }

  async function expand(
    input: GraphExpansionInput,
  ): Promise<GraphExpansionOutcome> {
    const liveEditDeps = await deps.buildLiveEditDeps(input.projectPath);

    // The request's identity, computed once: the same payload always hashes to
    // the same value regardless of key order or which optional fields the lane
    // spelled out, so a retry of the SAME proposition is recognisable as one.
    const canonicalPayload = expansionCanonicalPayload(input.request);
    const payloadHash = expansionPayloadHash(canonicalPayload);
    const canonicalBytes = expansionCanonicalByteLength(canonicalPayload);

    for (let attempt = 1; attempt <= MAX_PREPARE_ATTEMPTS; attempt += 1) {
      const execution = await deps.getActiveExecution(
        input.projectPath,
        input.sessionName,
      );
      if (!execution || execution.id !== input.executionId) {
        return { ok: false, kind: "no_active_execution", issues: [] };
      }
      const loadedExecutionContract = executionContract.loadLiveEdit(execution);

      // The lane binding is envelope, not transport: a capability whose
      // conversation is no longer this context's implementer is refused here
      // and again inside the lock. Ahead of the receipt ledger, because a lane
      // that may not ask may not replay another lane's answer either.
      const bound = resolveBoundConversationId(execution, input.contextId);
      if (bound !== input.conversationId) {
        return refused(input, payloadHash, "forbidden", [
          issue(
            "expansion-lane-not-bound",
            `Conversation "${input.conversationId}" is not the implementer bound to context "${input.contextId}"`,
            { contextId: input.contextId },
          ),
        ]);
      }

      // --- idempotency, decided BEFORE the caps ---------------------------
      // Deliberate ordering: the request that spent the execution's last
      // budget slot must still replay when its own lane retries it, and it
      // cannot if a cap gets to answer first.
      const verdict = classifyExpansionAttempt({
        receipts: execution.expansionReceipts,
        invokerContextId: input.contextId,
        requestId: input.request.requestId,
        payloadHash,
      });
      if (verdict.kind === "replay") {
        logger.info("graph_expansion.replayed", {
          executionId: input.executionId,
          contextId: input.contextId,
          requestId: input.request.requestId,
          liveRevision: verdict.receipt.liveRevision,
        });
        return {
          ok: true,
          replayed: true,
          liveRevision: verdict.receipt.liveRevision,
          createdContextIds: [...verdict.receipt.addedContextIds],
          createdTaskIds: [...verdict.receipt.addedTaskIds],
          rejoinContextIds: [...verdict.receipt.rejoinContextIds],
        };
      }
      if (verdict.kind === "replay-refusal") {
        return replayRefusal(input, verdict.receipt);
      }
      if (verdict.kind === "reused") {
        return refused(input, payloadHash, "refused", [
          issue(
            EXPANSION_REQUEST_ID_REUSED,
            expansionReuseMessage(input.request.requestId, input.contextId),
            { contextId: input.contextId },
          ),
        ]);
      }

      // --- caps (R8) -------------------------------------------------------
      // Ahead of compilation: an oversized batch should be refused on its
      // declared size, not after the envelope walk has priced it.
      const capRefusal =
        checkExpansionRequestCaps({
          contexts: input.request.contexts,
          tasks: input.request.tasks,
          edges: input.request.edges,
          canonicalBytes,
        }) ??
        checkExpansionBudgetCaps({
          receipts: execution.expansionReceipts,
          invokerContextId: input.contextId,
          newContextCount: input.request.contexts.length,
        });
      if (capRefusal) {
        return refused(input, payloadHash, "refused", [
          issue(capRefusal.code, capRefusal.message, {
            contextId: input.contextId,
          }),
        ]);
      }

      const compiled = compileExpansionBatch({
        execution,
        invokerContextId: input.contextId,
        request: input.request,
        resolvedGlobalDefaults: liveEditDeps.resolvedGlobalDefaults(),
      });
      if (!compiled.ok) {
        return refused(
          input,
          payloadHash,
          refusalKindFor(compiled.issues[0]?.code),
          compiled.issues,
        );
      }
      const batch = compiled.compiled;
      const assignmentPlan = assignmentPreparationPlan(batch);

      const assignmentPreparation = deps.prepareAssignmentSnapshots
        ? await deps.prepareAssignmentSnapshots(
            input.projectPath,
            assignmentPlan.operations,
          )
        : await prepareLiveEditAssignmentSnapshots({
            operations: assignmentPlan.operations,
            composeSnapshot: async (assignment) =>
              liveEditDeps.snapshotFor(assignment),
          });
      if (!assignmentPreparation.ok) {
        return refused(
          input,
          payloadHash,
          "refused",
          assignmentPreparation.issues,
        );
      }
      const preparedLiveEditDeps: LiveEditDeps = {
        ...liveEditDeps,
        executionContract: loadedExecutionContract,
        snapshotFor: (assignment) => {
          const inherited =
            assignmentPlan.inheritedSnapshotByAssignment.get(assignment);
          return inherited === undefined
            ? assignmentPreparation.prepared.snapshotFor(assignment)
            : structuredClone(inherited);
        },
      };

      // Full validation, outside the write queue. Rejects with exactly the
      // codes `applyLiveExecutionEdits` rejects with — including the R11.1 loop
      // refusals and the criterion must-run coverage lock, both of which live on
      // the shared core precisely so this path cannot route around them.
      // No `source`: that field is amendment-log attribution for the
      // `amend-charter` op, which this vocabulary cannot express. The
      // server-derived `lane-agent` attribution rides the emitted events.
      const prepared = prepareLiveExecutionEdits(
        execution,
        { operations: batch.operations },
        preparedLiveEditDeps,
        {
          laneAgentContextId: input.contextId,
          structuralSource: "lane-agent-expansion",
        },
      );
      if (!prepared.ok) {
        return refused(
          input,
          payloadHash,
          refusalKindFor(prepared.issues[0]?.code),
          prepared.issues,
        );
      }

      const installed = await installPrepared(
        input,
        payloadHash,
        batch,
        prepared.prepared,
      );
      if (installed.kind === "reprepare") continue;
      return installed.outcome;
    }

    return refused(input, payloadHash, "conflict", [
      issue(
        "expansion-concurrent-modification",
        `The execution changed under this request ${MAX_PREPARE_ATTEMPTS} times; retry the expansion`,
      ),
    ]);
  }

  async function installPrepared(
    input: GraphExpansionInput,
    payloadHash: string,
    batch: CompiledExpansion,
    prepared: PreparedLiveEdits,
  ): Promise<
    { kind: "reprepare" } | { kind: "settled"; outcome: GraphExpansionOutcome }
  > {
    let repreparing = false;
    let liveRevision = 0;
    try {
      await deps.mutateActive(
        input.projectPath,
        input.sessionName,
        (current) => {
          const stale = recheckVolatileEnvelope(current, {
            contextId: input.contextId,
            conversationId: input.conversationId,
            rejoinContextIds: batch.rejoinContextIds,
          });
          if (stale.length > 0) {
            throw new ExpansionRefusalSignal(
              refusalKindFor(stale[0]?.code),
              stale,
            );
          }

          const finalized = finalizePreparedEdits(current, prepared);
          if (!finalized.ok) {
            if (finalized.outcome === "reprepare") {
              repreparing = true;
              throw new ExpansionRefusalSignal("conflict", [
                issue(
                  "expansion-reprepare",
                  `The execution moved under this batch (${finalized.reason.kind})`,
                ),
              ]);
            }
            throw new ExpansionRefusalSignal("conflict", finalized.issues);
          }

          // Exactly one increment per accepted mutation (doc 06, D4). The core
          // never touches `liveRevision`; this entry point owns its bump.
          liveRevision = finalized.execution.liveRevision + 1;
          // The PERMANENT receipt lands in the same mutation as the graph
          // change: it is what a retry replays instead of expanding twice, and
          // what the cumulative budget is counted from, so an accepted
          // expansion whose receipt did not commit would be both replayable-as-
          // new and free of charge.
          const acceptance: GraphWorkflowExpansionAcceptanceReceipt = {
            requestId: input.request.requestId,
            payloadHash,
            invokerContextId: input.contextId,
            initiatorConversationId: input.conversationId,
            rationale: input.request.rationale,
            addedContextIds: batch.createdContextIds,
            addedTaskIds: batch.createdTaskIds,
            rejoinContextIds: batch.rejoinContextIds,
            liveRevision,
            acceptedAt: deps.now(),
          };
          const bumped: GraphWorkflowExecution = {
            ...finalized.execution,
            liveRevision,
            expansionReceipts: recordExpansionAcceptance(
              finalized.execution.expansionReceipts,
              acceptance,
            ),
          };

          // Both event receipts ride THIS mutation, so the audit rows and the
          // graph change commit together or not at all.
          const liveEdit = deps.publishLiveEditApplied({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            executionId: bumped.id,
            liveRevision,
            operationCount: batch.operations.length,
            affectedContextIds: [...finalized.affectedContextIds],
            source: "lane-agent",
          });
          const expansion = deps.publishGraphExpansion({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            executionId: bumped.id,
            invokerContextId: input.contextId,
            requestId: input.request.requestId,
            outcome: "accepted",
            addedContextIds: batch.createdContextIds,
            addedTaskIds: batch.createdTaskIds,
            rejoinContextIds: batch.rejoinContextIds,
            refusalCode: null,
            occurredAt: deps.now(),
          });

          return {
            execution: bumped,
            events: [...liveEdit.events, ...expansion.events],
            pushes: [...liveEdit.pushes, ...expansion.pushes],
          };
        },
      );
    } catch (error) {
      if (error instanceof ExpansionRefusalSignal) {
        // A reprepare is not a refusal: the batch may still be accepted against
        // fresh state, so it records nothing and re-enters the attempt loop.
        if (repreparing) return { kind: "reprepare" };
        return {
          kind: "settled",
          outcome: await refused(input, payloadHash, error.kind, error.issues),
        };
      }
      throw error;
    }

    logger.info("graph_expansion.accepted", {
      executionId: input.executionId,
      contextId: input.contextId,
      requestId: input.request.requestId,
      liveRevision,
      addedContextCount: batch.createdContextIds.length,
      addedTaskCount: batch.createdTaskIds.length,
      rejoinContextCount: batch.rejoinContextIds.length,
    });

    return {
      kind: "settled",
      outcome: {
        ok: true,
        replayed: false,
        liveRevision,
        createdContextIds: batch.createdContextIds,
        createdTaskIds: batch.createdTaskIds,
        rejoinContextIds: batch.rejoinContextIds,
      },
    };
  }

  return { expand };
}
