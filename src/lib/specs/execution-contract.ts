import type {
  GraphWorkflowTaskDefinition,
  WorkflowGraphValidationError,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type {
  GraphExecutionContract,
  GraphExecutionContractDefinition,
  GraphExecutionContractDecision,
  GraphExecutionContractDerivation,
} from "@/lib/workflow-graph/execution-contract-port";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";

const SPEC_EXECUTION_URI_PREFIX = "spec-execution://";
const SPEC_URI_PREFIX = "spec://";
const GROUP_ACCEPTANCE_CRITERIA =
  "Validate the locked criterion briefs of every task currently assigned to this context. The effective contract is the union of those task briefs; regrouping must never drop or weaken one.";

const metadataKeys = {
  taskElementId: "specTaskElementId",
  taskHandle: "specTaskHandle",
  dependsOnTaskElementIds: "specDependsOnTaskElementIds",
  criterionElementIds: "specCriterionElementIds",
  criterionBriefs: "specCriterionBriefs",
} as const;

interface CompiledTask {
  task: GraphWorkflowTaskDefinition;
  elementId: string;
  handle: string;
  dependencyElementIds: string[];
}

interface CompiledTaskIndex {
  tasks: CompiledTask[];
  byElementId: Map<string, CompiledTask>;
}

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issue: WorkflowGraphValidationError };

function isSpecExecution(
  definition: GraphExecutionContractDefinition,
): boolean {
  return (
    definition.origin?.sourceUri.startsWith(SPEC_EXECUTION_URI_PREFIX) === true
  );
}

function isCompiledTask(
  definition: GraphExecutionContractDefinition,
  task: GraphWorkflowTaskDefinition,
): boolean {
  const metadata = task.metadata;
  if (
    metadata?.[metadataKeys.taskElementId] !== undefined ||
    metadata?.[metadataKeys.taskHandle] !== undefined ||
    metadata?.[metadataKeys.dependsOnTaskElementIds] !== undefined ||
    metadata?.[metadataKeys.criterionBriefs] !== undefined
  ) {
    return true;
  }
  return (
    definition.lockedRegions?.some(
      (region) =>
        region.sourceUri.startsWith(SPEC_URI_PREFIX) &&
        region.paths.includes(`/tasks/${task.id}/metadata`),
    ) === true
  );
}

function metadataIssue(
  task: GraphWorkflowTaskDefinition,
  key: string,
  message: string,
): WorkflowGraphValidationError {
  return {
    code: "spec-contract-metadata-invalid",
    message: `Compiled task "${task.id}" has invalid ${key}: ${message}`,
    taskId: task.id,
    field: `/tasks/${task.id}/metadata/${key}`,
  };
}

function requiredMetadata(
  task: GraphWorkflowTaskDefinition,
  key: string,
): ParseResult<string> {
  const value = task.metadata?.[key];
  if (value === undefined || value.length === 0) {
    return { ok: false, issue: metadataIssue(task, key, "value is required") };
  }
  return { ok: true, value };
}

function stringArrayMetadata(
  task: GraphWorkflowTaskDefinition,
  key: string,
): ParseResult<string[]> {
  const raw = requiredMetadata(task, key);
  if (!raw.ok) return raw;
  try {
    const value: unknown = JSON.parse(raw.value);
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== "string")
    ) {
      return {
        ok: false,
        issue: metadataIssue(task, key, "expected a JSON string array"),
      };
    }
    return { ok: true, value };
  } catch {
    return {
      ok: false,
      issue: metadataIssue(task, key, "expected valid JSON"),
    };
  }
}

function stringRecordMetadata(
  task: GraphWorkflowTaskDefinition,
  key: string,
): ParseResult<Record<string, string>> {
  const raw = requiredMetadata(task, key);
  if (!raw.ok) return raw;
  try {
    const value: unknown = JSON.parse(raw.value);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.values(value).some((entry) => typeof entry !== "string")
    ) {
      return {
        ok: false,
        issue: metadataIssue(task, key, "expected a JSON string record"),
      };
    }
    return { ok: true, value: value as Record<string, string> };
  } catch {
    return {
      ok: false,
      issue: metadataIssue(task, key, "expected valid JSON"),
    };
  }
}

function compiledTaskIndex(
  definition: GraphExecutionContractDefinition,
): ParseResult<CompiledTaskIndex> {
  const tasks: CompiledTask[] = [];
  const byElementId = new Map<string, CompiledTask>();

  for (const task of definition.tasks) {
    if (!isCompiledTask(definition, task)) continue;
    const elementId = requiredMetadata(task, metadataKeys.taskElementId);
    if (!elementId.ok) return elementId;
    const handle = requiredMetadata(task, metadataKeys.taskHandle);
    if (!handle.ok) return handle;
    const dependencies = stringArrayMetadata(
      task,
      metadataKeys.dependsOnTaskElementIds,
    );
    if (!dependencies.ok) return dependencies;
    if (byElementId.has(elementId.value)) {
      return {
        ok: false,
        issue: metadataIssue(
          task,
          metadataKeys.taskElementId,
          `duplicate element id "${elementId.value}"`,
        ),
      };
    }
    const compiled = {
      task,
      elementId: elementId.value,
      handle: handle.value,
      dependencyElementIds: dependencies.value,
    };
    tasks.push(compiled);
    byElementId.set(compiled.elementId, compiled);
  }

  return { ok: true, value: { tasks, byElementId } };
}

function refusal(
  code: string,
  issues: WorkflowGraphValidationError[],
  instruction: string,
): Exclude<GraphExecutionContractDecision, { ok: true }> {
  return { ok: false, code, issues, instruction };
}

function contextIsReachable(
  definition: GraphExecutionContractDefinition,
  sourceContextId: string,
  targetContextId: string,
): boolean {
  const targetsBySource = new Map<string, string[]>();
  for (const edge of definition.edges) {
    const targets = targetsBySource.get(edge.sourceContextId) ?? [];
    targets.push(edge.targetContextId);
    targetsBySource.set(edge.sourceContextId, targets);
  }
  const pending = [sourceContextId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const target of targetsBySource.get(current) ?? []) {
      if (target === targetContextId) return true;
      if (!visited.has(target)) pending.push(target);
    }
  }
  return false;
}

export function validateSpecDependencyEmbedding(
  definition: GraphExecutionContractDefinition,
): GraphExecutionContractDecision {
  if (!isSpecExecution(definition)) return { ok: true };
  const indexed = compiledTaskIndex(definition);
  if (!indexed.ok) {
    return refusal(
      "spec_dependency_embedding_invalid",
      [indexed.issue],
      "Restore the compiled task metadata from the approved spec revision.",
    );
  }

  const issues: WorkflowGraphValidationError[] = [];
  for (const dependent of indexed.value.tasks) {
    for (const dependencyElementId of dependent.dependencyElementIds) {
      const predecessor = indexed.value.byElementId.get(dependencyElementId);
      if (predecessor === undefined) {
        issues.push({
          code: "spec-dependency-task-missing",
          message: `${dependent.handle} declares missing predecessor "${dependencyElementId}".`,
          taskId: dependent.task.id,
        });
        continue;
      }
      if (predecessor.task.contextId === dependent.task.contextId) {
        if (predecessor.task.order >= dependent.task.order) {
          issues.push({
            code: "spec-dependency-order-invalid",
            message: `${predecessor.handle} must precede ${dependent.handle} in context "${dependent.task.contextId}".`,
            taskId: dependent.task.id,
            contextId: dependent.task.contextId,
          });
        }
        continue;
      }
      if (
        !contextIsReachable(
          definition,
          predecessor.task.contextId,
          dependent.task.contextId,
        )
      ) {
        issues.push({
          code: "spec-dependency-path-missing",
          message: `${predecessor.handle} must precede ${dependent.handle}, but context "${predecessor.task.contextId}" cannot reach "${dependent.task.contextId}".`,
          taskId: dependent.task.id,
          contextId: dependent.task.contextId,
        });
      }
    }
  }

  return issues.length === 0
    ? { ok: true }
    : refusal(
        "spec_dependency_embedding_invalid",
        issues,
        "Restore context reachability or intra-context task order so every declared spec dependency is embedded before approval or execution start.",
      );
}

function validateSpecLiveEdit(
  execution: GraphWorkflowExecution,
  operation: WorkflowLiveEditOperation,
): GraphExecutionContractDecision {
  if (
    !isSpecExecution(execution.workingDefinition) ||
    operation.type !== "move-task" ||
    execution.status === "pending"
  ) {
    return { ok: true };
  }
  return refusal(
    "spec_grouping_frozen",
    [
      {
        code: "spec-grouping-frozen",
        message: `Task grouping for spec execution "${execution.id}" is frozen after execution start; "${operation.taskId}" cannot be moved.`,
        taskId: operation.taskId,
      },
    ],
    "Start a new spec execution to use a different task grouping.",
  );
}

function validateSpecTaskCompletion(
  execution: GraphWorkflowExecution,
  taskId: string,
): GraphExecutionContractDecision {
  const definition = execution.workingDefinition;
  if (!isSpecExecution(definition)) return { ok: true };
  const indexed = compiledTaskIndex(definition);
  if (!indexed.ok) {
    return refusal(
      "spec_predecessor_incomplete",
      [indexed.issue],
      "Restore the compiled task metadata before completing spec tasks.",
    );
  }
  const dependent = indexed.value.tasks.find(
    (candidate) => candidate.task.id === taskId,
  );
  if (dependent === undefined) return { ok: true };

  for (const dependencyElementId of dependent.dependencyElementIds) {
    const predecessor = indexed.value.byElementId.get(dependencyElementId);
    if (predecessor === undefined) {
      return refusal(
        "spec_predecessor_incomplete",
        [
          {
            code: "spec-predecessor-missing",
            message: `${dependent.handle} declares missing predecessor "${dependencyElementId}".`,
            taskId,
          },
        ],
        "Restore the compiled predecessor before completing this task.",
      );
    }
    if (predecessor.task.contextId !== dependent.task.contextId) continue;
    if (execution.taskStates[predecessor.task.id]?.status === "completed") {
      continue;
    }
    return refusal(
      "spec_predecessor_incomplete",
      [
        {
          code: "spec-predecessor-incomplete",
          message: `Complete ${predecessor.handle} before ${dependent.handle}; both tasks are in context "${dependent.task.contextId}".`,
          taskId,
          contextId: dependent.task.contextId,
        },
      ],
      `Complete ${predecessor.handle} before retrying ${dependent.handle}.`,
    );
  }
  return { ok: true };
}

function deriveSpecContextAcceptanceCriteria(
  definition: GraphExecutionContractDefinition,
): GraphExecutionContractDerivation {
  if (!isSpecExecution(definition)) {
    return { ok: true, acceptanceCriteriaByContextId: {} };
  }
  const indexed = compiledTaskIndex(definition);
  if (!indexed.ok) {
    return refusal(
      "spec_context_contract_invalid",
      [indexed.issue],
      "Restore the compiled task metadata before regrouping spec tasks.",
    );
  }
  const acceptanceCriteriaByContextId: Record<string, string> = {};
  for (const context of definition.executionContexts) {
    const members = indexed.value.tasks
      .filter((candidate) => candidate.task.contextId === context.id)
      .sort(
        (left, right) =>
          left.task.order - right.task.order ||
          left.task.id.localeCompare(right.task.id),
      );
    const briefs: string[] = [];
    const seenCriteria = new Set<string>();
    for (const member of members) {
      const criterionIds = stringArrayMetadata(
        member.task,
        metadataKeys.criterionElementIds,
      );
      if (!criterionIds.ok) {
        return refusal(
          "spec_context_contract_invalid",
          [criterionIds.issue],
          "Restore the compiled criterion metadata before regrouping spec tasks.",
        );
      }
      const criterionBriefs = stringRecordMetadata(
        member.task,
        metadataKeys.criterionBriefs,
      );
      if (!criterionBriefs.ok) {
        return refusal(
          "spec_context_contract_invalid",
          [criterionBriefs.issue],
          "Restore the compiled criterion metadata before regrouping spec tasks.",
        );
      }
      for (const criterionId of criterionIds.value) {
        if (seenCriteria.has(criterionId)) continue;
        seenCriteria.add(criterionId);
        const brief = criterionBriefs.value[criterionId];
        if (brief !== undefined) briefs.push(brief);
      }
    }
    acceptanceCriteriaByContextId[context.id] =
      briefs.length === 0
        ? GROUP_ACCEPTANCE_CRITERIA
        : [GROUP_ACCEPTANCE_CRITERIA, "", ...briefs].join("\n");
  }
  return { ok: true, acceptanceCriteriaByContextId };
}

export function createSpecExecutionContract(): GraphExecutionContract {
  return {
    validateDefinition: validateSpecDependencyEmbedding,
    validateLiveEdit: validateSpecLiveEdit,
    validateTaskCompletion: validateSpecTaskCompletion,
    deriveContextAcceptanceCriteria: deriveSpecContextAcceptanceCriteria,
  };
}
