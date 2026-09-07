import {
  orderedContextTaskIds,
  setTaskOrder,
  isPermutation,
  insertTask,
  removeTask,
  moveTask,
  removeContextContent,
  matchEdgeTargets,
  resolveEdgeTarget,
  updateEdgeGuard,
  removeEdge,
} from "./document-edit-mechanics";
import type {
  CharterInvariant,
  SourceOfTruth,
  WorkflowCharter,
} from "@/lib/workflows/charter-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  WorkflowDefinitionRecord,
  WorkflowGraphValidationError,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { mintEdgeId as mintSharedEdgeId } from "./edge-identity";
import type { DefinitionEditOperation } from "@/lib/workflows/edit-schemas";
import { workflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import { validateAuthoredDefinition } from "./definition-validation";
import { generateWorkflowLayout } from "./layout";
import {
  findLockedRegionTouch,
  regionLockedInstruction,
  regionLockedMessage,
  type DefinitionPath,
} from "./locked-regions";
import { type GraphExecutionContract } from "./execution-contract-port";

/**
 * Apply an ordered batch of targeted edits to a saved workflow definition
 * (docs/design/cc-cli/05). Pure — clones its input, mutates the copy, and never
 * touches the source record. Operations apply sequentially against the in-memory
 * copy so later ops see earlier results (add a context, then its tasks, then its
 * edges — in one batch). The batch is atomic:
 *
 *  - the FIRST per-op precondition failure (unknown/duplicate id, non-empty
 *    context removal, permutation mismatch) rejects the whole batch — subsequent
 *    ops may depend on the failed one, so we stop rather than apply past it;
 *  - after the last op the complete mutated definition runs the SAME accept-time
 *    gate as create/replace: a Zod re-parse (catches charter/parameter shape
 *    drift a partial edit could introduce) followed by `validateAuthoredDefinition`
 *    (structure, DAG acyclicity, parameter lint, prerequisites), collecting every
 *    error.
 *
 * A batch therefore either produces a definition indistinguishable from one
 * accepted via `create`, or returns issues and changes nothing. The revision is
 * NOT touched here — `storage.update()` owns minting it.
 */
export type ApplyDefinitionEditsResult =
  | { ok: true; record: WorkflowDefinitionRecord }
  | { ok: false; issues: DefinitionEditIssue[] };

export type DefinitionEditIssue = WorkflowGraphValidationError & {
  instruction?: string;
};

export function applyDefinitionEdits(
  record: WorkflowDefinitionRecord,
  operations: DefinitionEditOperation[],
  executionContract: GraphExecutionContract,
): ApplyDefinitionEditsResult {
  const next = structuredClone(record);
  const definition = next.definition;

  for (let index = 0; index < operations.length; index += 1) {
    const issue = applyOperation(next, operations[index]!, index);
    if (issue) {
      return { ok: false, issues: [issue] };
    }
  }

  if (operations.some(changesTaskMembership)) {
    const derived =
      executionContract.deriveContextAcceptanceCriteria(definition);
    if (!derived.ok) {
      return {
        ok: false,
        issues: derived.issues.map((issue) => ({
          ...issue,
          instruction: derived.instruction,
        })),
      };
    }
    for (const context of definition.executionContexts) {
      const acceptanceCriteria =
        derived.acceptanceCriteriaByContextId[context.id];
      if (acceptanceCriteria !== undefined) {
        context.acceptanceCriteria = acceptanceCriteria;
      }
    }
  }

  const parsed = workflowSemanticDefinitionSchema.safeParse(definition);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => {
        const path = issue.path.join(".");
        return {
          code: "invalid-definition",
          message: path ? `${path}: ${issue.message}` : issue.message,
          ...(path ? { field: path } : {}),
        };
      }),
    };
  }

  const structural = validateAuthoredDefinition(parsed.data);
  if (!structural.ok) {
    return { ok: false, issues: structural.errors };
  }

  next.definition = parsed.data;
  next.layout = generateWorkflowLayout(parsed.data, record.layout);
  return { ok: true, record: next };
}

function changesTaskMembership(operation: DefinitionEditOperation): boolean {
  return (
    operation.type === "add-task" ||
    operation.type === "remove-task" ||
    operation.type === "move-task" ||
    operation.type === "remove-context"
  );
}

/**
 * Map a definition-edit issue to the CLI's locator-first `{ path, message }`
 * shape (docs/design/cc-cli/05 §Error contract). Per-op precondition failures
 * carry `operationIndex` and address `operations[i]`; post-batch graph/shape
 * errors have no index and bucket under `graph`. The code prefixes the message
 * so the offending invariant reads first.
 */
export function formatDefinitionEditIssue(
  error: WorkflowGraphValidationError,
): {
  path: string;
  message: string;
} {
  const path =
    error.operationIndex !== undefined
      ? `operations[${error.operationIndex}]`
      : (error.field ?? "graph");
  return { path, message: `${error.code} — ${error.message}` };
}

// ============================================================
// Operation application
// ============================================================

function presentFieldPaths(
  prefix: DefinitionPath,
  value: Record<string, unknown>,
  fields: readonly string[],
): DefinitionPath[] {
  return fields
    .filter((field) => value[field] !== undefined)
    .map((field) => [...prefix, field]);
}

function contextTaskOrderPaths(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): DefinitionPath[] {
  return definition.tasks
    .filter((task) => task.contextId === contextId)
    .map((task) => ["tasks", task.id, "order"]);
}

function definitionEditTouchedPaths(
  record: WorkflowDefinitionRecord,
  operation: DefinitionEditOperation,
): DefinitionPath[] {
  const definition = record.definition;
  const value = operation as unknown as Record<string, unknown>;

  switch (operation.type) {
    case "update-workflow":
      return presentFieldPaths([], value, ["name", "description"]);
    case "update-charter":
      return presentFieldPaths(["charter"], value, [
        "mission",
        "conventions",
        "nonGoals",
        "vocabulary",
        "testStrategy",
        "knownAmbiguities",
        "invariants",
        "sourcesOfTruth",
      ]);
    case "update-workflow-config":
      return presentFieldPaths(["workflowConfig"], value, [
        "implementer",
        "contextValidator",
        "scriptValidator",
        "iterationPolicy",
        "circuitBreaker",
        "mutability",
        "planRepair",
        "collaboration",
        "humanApprovalGate",
        "askUserQuestions",
        "agentValidation",
        "memory",
        "laneMergeValidation",
      ]);
    case "add-context":
      return [["executionContexts", operation.id]];
    case "update-context":
      return presentFieldPaths(
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
          "mutability",
          "circuitBreaker",
          "iterationPolicy",
          "planRepair",
          "collaboration",
          "humanApprovalGate",
          "askUserQuestions",
          "agentValidation",
          "memory",
        ],
      );
    case "remove-context": {
      const paths: DefinitionPath[] = [
        ["executionContexts", operation.contextId],
      ];
      for (const task of definition.tasks) {
        if (task.contextId === operation.contextId) {
          paths.push(["tasks", task.id]);
        }
      }
      for (const edge of definition.edges) {
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
        ["tasks", operation.id],
        ...contextTaskOrderPaths(definition, operation.contextId),
      ];
    case "update-task":
      return presentFieldPaths(["tasks", operation.taskId], value, [
        "title",
        "instructions",
        "metadata",
      ]);
    case "remove-task": {
      const task = definition.tasks.find(
        (entry) => entry.id === operation.taskId,
      );
      return [
        ["tasks", operation.taskId],
        ...(task ? contextTaskOrderPaths(definition, task.contextId) : []),
      ];
    }
    case "move-task": {
      const task = definition.tasks.find(
        (entry) => entry.id === operation.taskId,
      );
      const targetContextId = operation.contextId ?? task?.contextId;
      return [
        ["tasks", operation.taskId, "contextId"],
        ["tasks", operation.taskId, "order"],
        ...(task ? contextTaskOrderPaths(definition, task.contextId) : []),
        ...(targetContextId
          ? contextTaskOrderPaths(definition, targetContextId)
          : []),
      ];
    }
    case "reorder-tasks":
      return contextTaskOrderPaths(definition, operation.contextId);
    case "add-edge":
      return [
        [
          "edges",
          mintEdgeId(
            definition,
            operation.sourceContextId,
            operation.targetContextId,
          ),
        ],
      ];
    case "update-edge":
      return [["edges", operation.edgeId, "when"]];
    case "remove-edge": {
      const matches = matchEdgeTargets(definition.edges, operation);
      return matches.length > 0
        ? matches.map((edge): DefinitionPath => ["edges", edge.id])
        : [["edges", "unknown"]];
    }
    case "add-parameter":
      return [["parameters", operation.declaration.name]];
    case "update-parameter":
      return [["parameters", operation.name]];
    case "remove-parameter":
      return [["parameters", operation.name]];
    case "add-prerequisite":
    case "remove-prerequisite":
      return [["prerequisites"]];
  }
}

function applyOperation(
  record: WorkflowDefinitionRecord,
  operation: DefinitionEditOperation,
  index: number,
): DefinitionEditIssue | null {
  const definition = record.definition;
  const fail = (
    code: string,
    message: string,
    extra: Partial<DefinitionEditIssue> = {},
  ): DefinitionEditIssue => ({
    code,
    message,
    operationIndex: index,
    ...extra,
  });

  const locked = findLockedRegionTouch(
    definition,
    definitionEditTouchedPaths(record, operation),
  );
  if (locked) {
    return fail("region_locked", regionLockedMessage(locked), {
      field: locked.lockedPath,
      instruction: regionLockedInstruction(locked),
    });
  }

  switch (operation.type) {
    case "update-workflow": {
      if (operation.name !== undefined) record.name = operation.name;
      if (operation.description !== undefined) {
        record.description = operation.description;
      }
      return null;
    }

    case "update-charter": {
      applyCharterContentEdit(definition.charter, operation);
      return null;
    }

    case "update-workflow-config": {
      const config = definition.workflowConfig;
      applyOptionalBlock(config, "implementer", operation.implementer);
      applyOptionalBlock(
        config,
        "contextValidator",
        operation.contextValidator,
      );
      applyOptionalBlock(config, "scriptValidator", operation.scriptValidator);
      applyOptionalBlock(config, "iterationPolicy", operation.iterationPolicy);
      applyOptionalBlock(config, "circuitBreaker", operation.circuitBreaker);
      applyOptionalBlock(config, "mutability", operation.mutability);
      applyOptionalBlock(config, "planRepair", operation.planRepair);
      applyOptionalBlock(config, "collaboration", operation.collaboration);
      applyOptionalBlock(
        config,
        "humanApprovalGate",
        operation.humanApprovalGate,
      );
      applyOptionalBlock(
        config,
        "askUserQuestions",
        operation.askUserQuestions,
      );
      applyOptionalBlock(config, "agentValidation", operation.agentValidation);
      applyOptionalBlock(config, "memory", operation.memory);
      applyOptionalBlock(
        config,
        "laneMergeValidation",
        operation.laneMergeValidation,
      );
      return null;
    }

    case "add-context": {
      if (findContext(definition, operation.id)) {
        return fail(
          "duplicate-context-id",
          `context "${operation.id}" already exists`,
          { contextId: operation.id },
        );
      }
      const context: GraphWorkflowExecutionContextDefinition = {
        id: operation.id,
        title: operation.title,
        acceptanceCriteria: operation.acceptanceCriteria,
        // Authored placement wins. Without one the context falls back to a
        // single-member lane of its own, matching the one-worktree-per-context
        // shape an added context had before placement was authored. The
        // resulting definition is re-validated below, so an id that cannot be a
        // lane name is refused with a located issue.
        placement: operation.placement ?? { lane: operation.id, mode: "full" },
        ...(operation.description !== undefined
          ? { description: operation.description }
          : {}),
        ...(operation.outputSchema !== undefined
          ? { outputSchema: operation.outputSchema }
          : {}),
        ...(operation.routing !== undefined
          ? { routing: operation.routing }
          : {}),
        ...(operation.implementer !== undefined
          ? { implementer: operation.implementer }
          : {}),
        ...(operation.contextValidator !== undefined
          ? { contextValidator: operation.contextValidator }
          : {}),
        ...(operation.scriptValidator !== undefined
          ? { scriptValidator: operation.scriptValidator }
          : {}),
        ...(operation.mutability !== undefined
          ? { mutability: operation.mutability }
          : {}),
        ...(operation.circuitBreaker !== undefined
          ? { circuitBreaker: operation.circuitBreaker }
          : {}),
        ...(operation.iterationPolicy !== undefined
          ? { iterationPolicy: operation.iterationPolicy }
          : {}),
        ...(operation.planRepair !== undefined
          ? { planRepair: operation.planRepair }
          : {}),
        ...(operation.collaboration !== undefined
          ? { collaboration: operation.collaboration }
          : {}),
        ...(operation.humanApprovalGate !== undefined
          ? { humanApprovalGate: operation.humanApprovalGate }
          : {}),
        ...(operation.askUserQuestions !== undefined
          ? { askUserQuestions: operation.askUserQuestions }
          : {}),
        ...(operation.agentValidation !== undefined
          ? { agentValidation: operation.agentValidation }
          : {}),
        ...(operation.memory !== undefined ? { memory: operation.memory } : {}),
      };
      definition.executionContexts.push(context);
      return null;
    }

    case "update-context": {
      const context = findContext(definition, operation.contextId);
      if (!context) {
        return fail(
          "unknown-context",
          `no context "${operation.contextId}" in this definition`,
          { contextId: operation.contextId },
        );
      }
      if (operation.title !== undefined) context.title = operation.title;
      if (operation.acceptanceCriteria !== undefined) {
        context.acceptanceCriteria = operation.acceptanceCriteria;
      }
      // Wholesale replacement, never a merge: the grade discriminates on `mode`,
      // so merging an owning placement's paths onto a read-only one would build
      // a shape the union has no member for.
      if (operation.placement !== undefined) {
        context.placement = operation.placement;
      }
      applyOptionalBlock(context, "description", operation.description);
      applyOptionalBlock(context, "outputSchema", operation.outputSchema);
      applyOptionalBlock(context, "routing", operation.routing);
      applyOptionalBlock(context, "implementer", operation.implementer);
      applyOptionalBlock(
        context,
        "contextValidator",
        operation.contextValidator,
      );
      applyOptionalBlock(context, "scriptValidator", operation.scriptValidator);
      applyOptionalBlock(context, "mutability", operation.mutability);
      applyOptionalBlock(context, "circuitBreaker", operation.circuitBreaker);
      applyOptionalBlock(context, "iterationPolicy", operation.iterationPolicy);
      applyOptionalBlock(context, "planRepair", operation.planRepair);
      applyOptionalBlock(context, "collaboration", operation.collaboration);
      applyOptionalBlock(
        context,
        "humanApprovalGate",
        operation.humanApprovalGate,
      );
      applyOptionalBlock(
        context,
        "askUserQuestions",
        operation.askUserQuestions,
      );
      applyOptionalBlock(context, "agentValidation", operation.agentValidation);
      applyOptionalBlock(context, "memory", operation.memory);
      return null;
    }

    case "remove-context": {
      const context = findContext(definition, operation.contextId);
      if (!context) {
        return fail(
          "unknown-context",
          `no context "${operation.contextId}" in this definition`,
          { contextId: operation.contextId },
        );
      }
      const contextTasks = definition.tasks.filter(
        (task) => task.contextId === operation.contextId,
      );
      if (contextTasks.length > 0 && operation.deleteTasks !== true) {
        return fail(
          "context-not-empty",
          `context "${operation.contextId}" still has ${contextTasks.length} task(s); pass deleteTasks: true to remove them`,
          { contextId: operation.contextId },
        );
      }
      removeContextContent(definition, operation.contextId);
      return null;
    }

    case "add-task": {
      if (findTask(definition, operation.id)) {
        return fail(
          "duplicate-task-id",
          `task "${operation.id}" already exists`,
          { taskId: operation.id },
        );
      }
      if (!findContext(definition, operation.contextId)) {
        return fail(
          "unknown-context",
          `no context "${operation.contextId}" for task "${operation.id}"`,
          { contextId: operation.contextId },
        );
      }
      const task: GraphWorkflowTaskDefinition = {
        id: operation.id,
        contextId: operation.contextId,
        order: 0,
        title: operation.title,
        instructions: operation.instructions,
        ...(operation.metadata !== undefined
          ? { metadata: operation.metadata }
          : {}),
        source: "user",
      };
      const placed = insertTask(definition.tasks, task, operation.position);
      if (!placed.ok) {
        return fail("position-target-not-found", placed.message, {
          taskId: operation.id,
        });
      }
      return null;
    }

    case "update-task": {
      const task = findTask(definition, operation.taskId);
      if (!task) {
        return fail(
          "unknown-task-id",
          `no task "${operation.taskId}" in this definition`,
          { taskId: operation.taskId },
        );
      }
      if (operation.title !== undefined) task.title = operation.title;
      if (operation.instructions !== undefined) {
        task.instructions = operation.instructions;
      }
      if (operation.metadata === null) {
        delete task.metadata;
      } else if (operation.metadata !== undefined) {
        task.metadata = operation.metadata;
      }
      return null;
    }

    case "remove-task": {
      const task = findTask(definition, operation.taskId);
      if (!task) {
        return fail(
          "unknown-task-id",
          `no task "${operation.taskId}" in this definition`,
          { taskId: operation.taskId },
        );
      }
      removeTask(definition.tasks, task);
      return null;
    }

    case "move-task": {
      const task = findTask(definition, operation.taskId);
      if (!task) {
        return fail(
          "unknown-task-id",
          `no task "${operation.taskId}" in this definition`,
          { taskId: operation.taskId },
        );
      }
      const sourceContextId = task.contextId;
      const targetContextId = operation.contextId ?? sourceContextId;
      if (
        operation.contextId !== undefined &&
        !findContext(definition, targetContextId)
      ) {
        return fail(
          "unknown-target-context",
          `no context "${targetContextId}" to move task "${operation.taskId}" into`,
          { contextId: targetContextId },
        );
      }
      const placed = moveTask(
        definition.tasks,
        task,
        targetContextId,
        operation.position,
      );
      if (!placed.ok) {
        return fail("position-target-not-found", placed.message, {
          taskId: operation.taskId,
        });
      }
      return null;
    }

    case "reorder-tasks": {
      const contextTaskIds = orderedContextTaskIds(
        definition.tasks,
        operation.contextId,
      );
      if (!isPermutation(contextTaskIds, operation.orderedTaskIds)) {
        return fail(
          "reorder-mismatch",
          `orderedTaskIds must be an exact permutation of context "${operation.contextId}"'s tasks`,
          { contextId: operation.contextId },
        );
      }
      setTaskOrder(definition.tasks, operation.orderedTaskIds);
      return null;
    }

    case "add-edge": {
      if (matchEdgeTargets(definition.edges, operation).length > 0) {
        return fail(
          "edge-already-exists",
          `${operation.sourceContextId} → ${operation.targetContextId}`,
        );
      }
      definition.edges.push({
        id: mintEdgeId(
          definition,
          operation.sourceContextId,
          operation.targetContextId,
        ),
        sourceContextId: operation.sourceContextId,
        targetContextId: operation.targetContextId,
        ...(operation.when !== undefined ? { when: operation.when } : {}),
      });
      return null;
    }

    case "update-edge": {
      const edge = definition.edges.find(
        (entry) => entry.id === operation.edgeId,
      );
      if (!edge) {
        return fail("unknown-edge", `no edge "${operation.edgeId}"`, {
          edgeId: operation.edgeId,
        });
      }
      updateEdgeGuard(edge, operation.when);
      return null;
    }

    case "remove-edge": {
      const resolved = resolveEdgeTarget(definition.edges, operation);
      if (!resolved.ok)
        return fail(resolved.code, resolved.message, resolved.extra);
      definition.edges = removeEdge(definition.edges, resolved.edge.id);
      return null;
    }

    case "add-parameter": {
      if (
        definition.parameters.some(
          (param) => param.name === operation.declaration.name,
        )
      ) {
        return fail(
          "duplicate-parameter-name",
          `parameter "${operation.declaration.name}" already declared`,
          { parameterName: operation.declaration.name },
        );
      }
      definition.parameters.push(operation.declaration);
      return null;
    }

    case "update-parameter": {
      const paramIndex = definition.parameters.findIndex(
        (param) => param.name === operation.name,
      );
      if (paramIndex === -1) {
        return fail(
          "unknown-parameter",
          `no parameter "${operation.name}" to update`,
          { parameterName: operation.name },
        );
      }
      definition.parameters[paramIndex] = operation.declaration;
      return null;
    }

    case "remove-parameter": {
      const paramIndex = definition.parameters.findIndex(
        (param) => param.name === operation.name,
      );
      if (paramIndex === -1) {
        return fail(
          "unknown-parameter",
          `no parameter "${operation.name}" to remove`,
          { parameterName: operation.name },
        );
      }
      definition.parameters.splice(paramIndex, 1);
      return null;
    }

    case "add-prerequisite": {
      definition.prerequisites.push(operation.prerequisite);
      return null;
    }

    case "remove-prerequisite": {
      const selector = operation.path ?? operation.skill;
      if (selector === undefined) {
        return fail(
          "invalid-prerequisite-selector",
          `remove-prerequisite for kind "${operation.kind}" requires a ${operation.kind === "path" ? "path" : "skill"}`,
        );
      }
      const matchIndex = definition.prerequisites.findIndex((prereq) =>
        operation.kind === "path"
          ? prereq.kind === "path" && prereq.path === operation.path
          : prereq.kind === "skill" && prereq.skill === operation.skill,
      );
      if (matchIndex === -1) {
        return fail(
          "unknown-prerequisite",
          `no ${operation.kind} prerequisite "${selector}" to remove`,
        );
      }
      definition.prerequisites.splice(matchIndex, 1);
      return null;
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function findContext(
  definition: WorkflowSemanticDefinition,
  contextId: string,
): GraphWorkflowExecutionContextDefinition | undefined {
  return definition.executionContexts.find((entry) => entry.id === contextId);
}

function findTask(
  definition: WorkflowSemanticDefinition,
  taskId: string,
): GraphWorkflowTaskDefinition | undefined {
  return definition.tasks.find((entry) => entry.id === taskId);
}

function mintEdgeId(
  definition: WorkflowSemanticDefinition,
  sourceContextId: string,
  targetContextId: string,
): string {
  return mintSharedEdgeId(
    new Set(definition.edges.map((edge) => edge.id)),
    sourceContextId,
    targetContextId,
  );
}

/**
 * The charter content fields a saved-tier `update-charter` or live
 * `amend-charter` op may carry (`charterContentEditShape` in edit-schemas.ts) —
 * structural so both op types satisfy it and share one merge.
 */
export interface CharterContentEdit {
  mission?: string;
  conventions?: string[] | null;
  nonGoals?: string[] | null;
  vocabulary?: string[] | null;
  testStrategy?: string | null;
  knownAmbiguities?: string[] | null;
  invariants?: CharterInvariant[] | null;
  sourcesOfTruth?: SourceOfTruth[];
}

/** Partial-merge a charter edit: arrays replace wholesale, `null` clears. */
export function applyCharterContentEdit(
  charter: WorkflowCharter,
  edit: CharterContentEdit,
): void {
  if (edit.mission !== undefined) charter.mission = edit.mission;
  applyOptionalBlock(charter, "conventions", edit.conventions);
  applyOptionalBlock(charter, "nonGoals", edit.nonGoals);
  applyOptionalBlock(charter, "vocabulary", edit.vocabulary);
  applyOptionalBlock(charter, "testStrategy", edit.testStrategy);
  applyOptionalBlock(charter, "knownAmbiguities", edit.knownAmbiguities);
  applyOptionalBlock(charter, "invariants", edit.invariants);
  if (edit.sourcesOfTruth !== undefined) {
    charter.sourcesOfTruth = edit.sourcesOfTruth;
  }
}

/**
 * Partial-update an optional property: `undefined` leaves it untouched, `null`
 * clears it (restores cascade inheritance / removes the section), a value sets
 * it. Only ever called on optional keys, so `delete` is well-typed.
 */
function applyOptionalBlock<T, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    delete target[key];
    return;
  }
  target[key] = value;
}
