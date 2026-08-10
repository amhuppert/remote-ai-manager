import { z } from "zod";

import {
  specCriterionDispositionSchema,
  type SpecCriterionDisposition,
} from "./schemas";

export type ExclusionDisposition = Exclude<
  SpecCriterionDisposition,
  "in_scope"
>;

export interface ScopeTask {
  id: string;
  handle: string;
  dependsOnTaskIds: string[];
  coveredCriterionIds: string[];
}

export interface ScopeCriterion {
  id: string;
  handle: string;
}

export interface ScopePlan {
  tasks: ScopeTask[];
  criteria: ScopeCriterion[];
}

export interface CriterionExclusion {
  criterionId: string;
  disposition: ExclusionDisposition;
}

export interface ExecutionScope {
  selectedTaskIds: string[];
  selectedCriterionIds: string[];
  exclusionDispositions: CriterionExclusion[];
}

/**
 * Parsing canonicalizes duplicate ids to their first occurrence. Legacy plan
 * import/preview and every read of a persisted `scope_json` parse through this
 * schema, so a duplicated id can neither enter an imported attempt nor reach a
 * projection: without this, a persisted `["criterion-1","criterion-1"]` scope
 * renders impossible counters like "2/1 proof recorded" (the projection
 * iterates the raw list while Studio derives its denominator from a Set).
 * Duplicate exclusion dispositions collapse to the first entry for the same
 * reason.
 */
export const executionScopeSchema: z.ZodType<ExecutionScope> = z
  .object({
    selectedTaskIds: z.array(z.string().min(1)),
    selectedCriterionIds: z.array(z.string().min(1)),
    exclusionDispositions: z.array(
      z
        .object({
          criterionId: z.string().min(1),
          disposition: specCriterionDispositionSchema.exclude(["in_scope"]),
        })
        .strict(),
    ),
  })
  .strict()
  .transform((scope): ExecutionScope => {
    const seenExclusionCriterionIds = new Set<string>();
    return {
      selectedTaskIds: [...new Set(scope.selectedTaskIds)],
      selectedCriterionIds: [...new Set(scope.selectedCriterionIds)],
      exclusionDispositions: scope.exclusionDispositions.filter((exclusion) => {
        if (seenExclusionCriterionIds.has(exclusion.criterionId)) {
          return false;
        }
        seenExclusionCriterionIds.add(exclusion.criterionId);
        return true;
      }),
    };
  });

export interface MissingTaskDependencyDefect {
  kind: "missing_task_dependency";
  taskId: string;
  taskHandle: string;
  dependencyTaskId: string;
  dependencyTaskHandle: string;
  message: string;
}

export interface UncoveredSelectedCriterionDefect {
  kind: "uncovered_selected_criterion";
  criterionId: string;
  criterionHandle: string;
  message: string;
}

export interface MissingExclusionDispositionDefect {
  kind: "missing_exclusion_disposition";
  criterionId: string;
  criterionHandle: string;
  message: string;
}

export interface UnknownSelectedTaskDefect {
  kind: "unknown_selected_task";
  taskId: string;
  message: string;
}

export interface UnknownSelectedCriterionDefect {
  kind: "unknown_selected_criterion";
  criterionId: string;
  message: string;
}

export interface EmptySelectedCriteriaDefect {
  kind: "empty_selected_criteria";
  message: string;
}

export type ScopeDefect =
  | UnknownSelectedTaskDefect
  | UnknownSelectedCriterionDefect
  | EmptySelectedCriteriaDefect
  | MissingTaskDependencyDefect
  | UncoveredSelectedCriterionDefect
  | MissingExclusionDispositionDefect;

export type ScopeValidationResult =
  | { valid: true; defects: [] }
  | {
      valid: false;
      reason: "invalid_smaller_unit";
      defects: ScopeDefect[];
    };

const DEFECT_ORDER: Record<ScopeDefect["kind"], number> = {
  unknown_selected_task: 0,
  unknown_selected_criterion: 1,
  empty_selected_criteria: 2,
  missing_task_dependency: 3,
  uncovered_selected_criterion: 4,
  missing_exclusion_disposition: 5,
};

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function defectHandle(defect: ScopeDefect): string {
  switch (defect.kind) {
    case "unknown_selected_task":
      return defect.taskId;
    case "unknown_selected_criterion":
      return defect.criterionId;
    case "empty_selected_criteria":
      return "";
    case "missing_task_dependency":
      return defect.taskHandle;
    case "uncovered_selected_criterion":
    case "missing_exclusion_disposition":
      return defect.criterionHandle;
  }
}

function sortDefects(defects: ScopeDefect[]): ScopeDefect[] {
  return defects.sort(
    (left, right) =>
      DEFECT_ORDER[left.kind] - DEFECT_ORDER[right.kind] ||
      compareText(defectHandle(left), defectHandle(right)) ||
      compareText(left.message, right.message),
  );
}

export function validateExecutionScope(
  plan: ScopePlan,
  scope: ExecutionScope,
): ScopeValidationResult {
  const defects: ScopeDefect[] = [];
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  const criterionIds = new Set(plan.criteria.map((criterion) => criterion.id));
  const selectedTaskIds = new Set(scope.selectedTaskIds);
  const selectedCriterionIds = new Set(scope.selectedCriterionIds);
  const dispositionCriterionIds = new Set(
    scope.exclusionDispositions.map((exclusion) => exclusion.criterionId),
  );

  for (const taskId of selectedTaskIds) {
    if (!tasksById.has(taskId)) {
      defects.push({
        kind: "unknown_selected_task",
        taskId,
        message: `Selected task ${taskId} is not in the approved plan.`,
      });
    }
  }

  for (const criterionId of selectedCriterionIds) {
    if (!criterionIds.has(criterionId)) {
      defects.push({
        kind: "unknown_selected_criterion",
        criterionId,
        message: `Selected criterion ${criterionId} is not in the approved plan.`,
      });
    }
  }

  if (selectedCriterionIds.size === 0) {
    defects.push({
      kind: "empty_selected_criteria",
      message: "Execution scope selects no criteria to deliver.",
    });
  }

  for (const taskId of selectedTaskIds) {
    const task = tasksById.get(taskId);
    if (!task) {
      continue;
    }

    for (const dependencyTaskId of task.dependsOnTaskIds) {
      if (selectedTaskIds.has(dependencyTaskId)) {
        continue;
      }
      const dependency = tasksById.get(dependencyTaskId);
      const dependencyHandle = dependency?.handle ?? dependencyTaskId;
      defects.push({
        kind: "missing_task_dependency",
        taskId: task.id,
        taskHandle: task.handle,
        dependencyTaskId,
        dependencyTaskHandle: dependencyHandle,
        message: `${task.handle} requires selected dependency ${dependencyHandle}.`,
      });
    }
  }

  for (const criterion of plan.criteria) {
    if (!selectedCriterionIds.has(criterion.id)) {
      continue;
    }
    const isCovered = scope.selectedTaskIds.some((taskId) =>
      tasksById.get(taskId)?.coveredCriterionIds.includes(criterion.id),
    );
    if (!isCovered) {
      defects.push({
        kind: "uncovered_selected_criterion",
        criterionId: criterion.id,
        criterionHandle: criterion.handle,
        message: `Selected criterion ${criterion.handle} has no selected covering task.`,
      });
    }
  }

  for (const criterion of plan.criteria) {
    if (
      selectedCriterionIds.has(criterion.id) ||
      dispositionCriterionIds.has(criterion.id)
    ) {
      continue;
    }
    defects.push({
      kind: "missing_exclusion_disposition",
      criterionId: criterion.id,
      criterionHandle: criterion.handle,
      message: `Excluded criterion ${criterion.handle} needs a deferred, delivered_elsewhere, or waived disposition.`,
    });
  }

  if (defects.length === 0) {
    return { valid: true, defects: [] };
  }

  return {
    valid: false,
    reason: "invalid_smaller_unit",
    defects: sortDefects(defects),
  };
}
