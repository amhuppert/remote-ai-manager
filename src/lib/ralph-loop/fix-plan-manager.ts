import { randomUUID } from "node:crypto";
import type { FixPlanTask, UpdateFixPlanInput } from "@/types";

/** Create a new task with generated ID. */
export function createTask(params: {
  description: string;
  group: number;
  addedByIteration?: number | null;
}): FixPlanTask {
  return {
    id: randomUUID(),
    description: params.description,
    group: params.group,
    status: "pending",
    createdAt: new Date().toISOString(),
    completedAt: null,
    skipReason: null,
    addedByIteration: params.addedByIteration ?? null,
  };
}

/** Mark tasks as completed by IDs. Returns the mutated plan and list of completed IDs. */
export function completeTasks(
  plan: FixPlanTask[],
  taskIds: string[],
): { plan: FixPlanTask[]; completedIds: string[]; notFound: string[] } {
  const now = new Date().toISOString();
  const notFound: string[] = [];
  const completedIds: string[] = [];

  const updated = plan.map((task) => {
    if (taskIds.includes(task.id)) {
      completedIds.push(task.id);
      return { ...task, status: "completed" as const, completedAt: now };
    }
    return task;
  });

  for (const id of taskIds) {
    if (!completedIds.includes(id)) {
      notFound.push(id);
    }
  }

  return { plan: updated, completedIds, notFound };
}

/** Mark tasks as skipped by IDs with reasons. */
export function skipTasks(
  plan: FixPlanTask[],
  skips: Array<{ taskId: string; reason: string }>,
): { plan: FixPlanTask[]; skippedIds: string[]; notFound: string[] } {
  const now = new Date().toISOString();
  const skipMap = new Map(skips.map((s) => [s.taskId, s.reason]));
  const skippedIds: string[] = [];
  const notFound: string[] = [];

  const updated = plan.map((task) => {
    if (skipMap.has(task.id)) {
      skippedIds.push(task.id);
      return {
        ...task,
        status: "skipped" as const,
        completedAt: now,
        skipReason: skipMap.get(task.id)!,
      };
    }
    return task;
  });

  for (const { taskId } of skips) {
    if (!skippedIds.includes(taskId)) {
      notFound.push(taskId);
    }
  }

  return { plan: updated, skippedIds, notFound };
}

/** Add newly discovered tasks to the plan. Returns the mutated plan and added task IDs. */
export function addTasks(
  plan: FixPlanTask[],
  newTasks: Array<{ description: string; group: number }>,
  iterationNumber: number,
): { plan: FixPlanTask[]; addedIds: string[] } {
  const added = newTasks.map((t) =>
    createTask({
      description: t.description,
      group: t.group,
      addedByIteration: iterationNumber,
    }),
  );

  return {
    plan: [...plan, ...added],
    addedIds: added.map((t) => t.id),
  };
}

/**
 * Apply a full update_fix_plan tool input to the plan.
 * Returns the updated plan and mutation summary.
 */
export function applyFixPlanUpdate(
  plan: FixPlanTask[],
  input: UpdateFixPlanInput,
  iterationNumber: number,
): {
  plan: FixPlanTask[];
  completedIds: string[];
  skippedIds: string[];
  addedIds: string[];
  notFoundIds: string[];
} {
  let current = plan;
  const allNotFound: string[] = [];
  let completedIds: string[] = [];
  let skippedIds: string[] = [];
  let addedIds: string[] = [];

  if (input.completedTaskIds?.length) {
    const result = completeTasks(current, input.completedTaskIds);
    current = result.plan;
    completedIds = result.completedIds;
    allNotFound.push(...result.notFound);
  }

  if (input.skippedTasks?.length) {
    const result = skipTasks(current, input.skippedTasks);
    current = result.plan;
    skippedIds = result.skippedIds;
    allNotFound.push(...result.notFound);
  }

  if (input.newTasks?.length) {
    const result = addTasks(current, input.newTasks, iterationNumber);
    current = result.plan;
    addedIds = result.addedIds;
  }

  return {
    plan: current,
    completedIds,
    skippedIds,
    addedIds,
    notFoundIds: allNotFound,
  };
}

/** Check if all tasks are resolved (completed or skipped). */
export function isAllResolved(plan: FixPlanTask[]): boolean {
  if (plan.length === 0) return false;
  return plan.every(
    (task) => task.status === "completed" || task.status === "skipped",
  );
}

/** Get pending and in-progress tasks organized by group number (ascending). */
export function getActiveTasksByGroup(
  plan: FixPlanTask[],
): Map<number, FixPlanTask[]> {
  const grouped = new Map<number, FixPlanTask[]>();
  for (const task of plan) {
    if (task.status === "pending" || task.status === "in_progress") {
      const list = grouped.get(task.group) ?? [];
      list.push(task);
      grouped.set(task.group, list);
    }
  }
  return new Map([...grouped.entries()].sort(([a], [b]) => a - b));
}

/** Get the current (lowest-numbered) active group, or null if all resolved. */
export function getCurrentGroup(plan: FixPlanTask[]): number | null {
  const groups = getActiveTasksByGroup(plan);
  const first = groups.keys().next();
  return first.done ? null : first.value;
}

/** Compute task progress summary. */
export function getTaskProgress(plan: FixPlanTask[]): {
  total: number;
  completed: number;
  skipped: number;
  pending: number;
  inProgress: number;
} {
  const completed = plan.filter((t) => t.status === "completed").length;
  const skipped = plan.filter((t) => t.status === "skipped").length;
  const inProgress = plan.filter((t) => t.status === "in_progress").length;
  return {
    total: plan.length,
    completed,
    skipped,
    pending: plan.length - completed - skipped - inProgress,
    inProgress,
  };
}
