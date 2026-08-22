/**
 * A drill control's DOM id is derived from the screen it opens, which makes it
 * stable across the parent's unmount while a child screen is shown — that is
 * what lets a back step return focus to the row the reader drilled from.
 */
export function navigationTriggerId(screenId: string): string {
  return `cfgnav-${screenId}`;
}

/**
 * The parametric screen id one task drills to. Built here rather than spelled
 * `task:${id}` at each site so the list, the registry prefix and the panel's
 * navigation stack cannot disagree about the separator.
 */
export const TASK_SCREEN_PREFIX = "task:";

export function taskScreenId(taskId: string): string {
  return `${TASK_SCREEN_PREFIX}${taskId}`;
}

/** The same arrangement for one validator seat, keyed by its assignment id. */
export const SEAT_SCREEN_PREFIX = "seat:";

export function seatScreenId(assignmentId: string): string {
  return `${SEAT_SCREEN_PREFIX}${assignmentId}`;
}
