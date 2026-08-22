import type { GraphWorkflowTaskState } from "@/lib/workflow-graph/schemas";

/**
 * One task's own history (§11: *Tasks and task history → Tasks tab → Tasks*).
 *
 * The execution already records everything this needs — when the task started,
 * when it finished, and every validator send-back in `failureHistory` — but the
 * rail only ever showed the newest failure, so a task that had been rejected
 * three times looked exactly like one rejected once. Reading the recorded
 * history here keeps the count and the wording derived from the run.
 */

export interface TaskHistoryEntry {
  kind: "started" | "rejected" | "completed";
  at: string;
  /** The validator's reason, for a send-back; the other kinds state themselves. */
  detail: string | null;
}

export interface TaskHistoryView {
  entries: readonly TaskHistoryEntry[];
  /** How many times a validation round sent this task back. */
  reopenedCount: number;
  hasHistory: boolean;
}

export function deriveTaskHistory(
  state: GraphWorkflowTaskState | undefined,
): TaskHistoryView {
  if (state === undefined) {
    return { entries: [], reopenedCount: 0, hasHistory: false };
  }

  const entries: TaskHistoryEntry[] = [];
  if (state.startedAt !== null) {
    entries.push({ kind: "started", at: state.startedAt, detail: null });
  }
  for (const failure of state.failureHistory) {
    entries.push({
      kind: "rejected",
      at: failure.timestamp,
      detail: failure.message,
    });
  }
  if (state.completedAt !== null) {
    entries.push({ kind: "completed", at: state.completedAt, detail: null });
  }
  entries.sort((a, b) => a.at.localeCompare(b.at));

  return {
    entries,
    reopenedCount: state.failureHistory.length,
    hasHistory: entries.length > 0,
  };
}
