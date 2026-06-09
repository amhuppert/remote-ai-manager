/**
 * BackgroundTaskTracker — pure reducer over the Claude Agent SDK background-task
 * lifecycle messages (`task_started` / `task_updated` / `task_notification` /
 * `task_progress`).
 *
 * Produces an immutable in-flight set of tasks, each classified as `waitable`
 * (expected to finish on its own) or `excluded` (a long-lived watch such as a
 * persistent monitor). Classification is by the originating TOOL NAME: a task
 * started by the `Monitor` tool is a fire-and-forget streaming watch and is
 * excluded; backgrounded `Bash` shells and subagent `Task`/`Agent` runs are
 * waitable. Anything whose originating tool is unknown/unavailable defaults to
 * `waitable`; the caller relies on a bounded wait to prevent an indefinite stall.
 *
 * No I/O, no timers, no logging side effects. The input state is never mutated.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type BackgroundTaskClassification = "waitable" | "excluded";

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "killed";

export interface BackgroundTaskRecord {
  taskId: string;
  toolUseId: string | null;
  classification: BackgroundTaskClassification;
  status: BackgroundTaskStatus;
  description: string | null;
}

export interface BackgroundTaskState {
  tasks: ReadonlyMap<string, BackgroundTaskRecord>;
}

/**
 * Tool names whose background tasks are long-lived watches excluded from the
 * waitable set. The built-in `Monitor` tool streams events the agent observes
 * but never awaits, so its task never settles on its own. Exported so the set is
 * testable and extensible.
 */
export const WATCH_TOOL_NAMES: ReadonlySet<string> = new Set(["Monitor"]);

export interface ApplyTaskMessageOptions {
  /**
   * Per-turn map from `tool_use.id` to tool name, used to resolve the tool that
   * started a `task_started` task via its `tool_use_id`. Only consulted for
   * `task_started`; other message types ignore it.
   */
  toolNamesById?: ReadonlyMap<string, string>;
}

export function emptyBackgroundTaskState(): BackgroundTaskState {
  return {
    tasks: new Map(),
  };
}

export function applyTaskMessage(
  state: BackgroundTaskState,
  message: SDKMessage,
  opts?: ApplyTaskMessageOptions,
): BackgroundTaskState {
  if (message.type !== "system") {
    return state;
  }

  switch (message.subtype) {
    case "task_started": {
      const toolName = message.tool_use_id
        ? opts?.toolNamesById?.get(message.tool_use_id)
        : undefined;
      return addTask(state, {
        taskId: message.task_id,
        toolUseId: message.tool_use_id ?? null,
        classification: classifyByToolName(toolName),
        description: message.description ?? null,
      });
    }
    case "task_notification":
      return settleTask(state, message.task_id, message.status);
    case "task_updated": {
      const next = message.patch.status;
      if (next === "completed" || next === "failed" || next === "killed") {
        return settleTask(state, message.task_id, next);
      }
      return state;
    }
    default:
      return state;
  }
}

export function getWaitableInFlightTaskIds(
  state: BackgroundTaskState,
): string[] {
  const ids: string[] = [];
  for (const record of state.tasks.values()) {
    if (record.classification === "waitable" && record.status === "running") {
      ids.push(record.taskId);
    }
  }
  return ids;
}

/**
 * A task is excluded when its originating tool is a known long-lived watch;
 * otherwise (including unknown/unavailable tool name) it is waitable.
 */
function classifyByToolName(
  toolName: string | undefined,
): BackgroundTaskClassification {
  return toolName !== undefined && WATCH_TOOL_NAMES.has(toolName)
    ? "excluded"
    : "waitable";
}

function addTask(
  state: BackgroundTaskState,
  input: {
    taskId: string;
    toolUseId: string | null;
    classification: BackgroundTaskClassification;
    description: string | null;
  },
): BackgroundTaskState {
  const existing = state.tasks.get(input.taskId);
  if (existing !== undefined) {
    // Already tracked (duplicate started signal) — never resurrect a settled task.
    return state;
  }

  const record: BackgroundTaskRecord = {
    taskId: input.taskId,
    toolUseId: input.toolUseId,
    classification: input.classification,
    status: "running",
    description: input.description,
  };

  const tasks = new Map(state.tasks);
  tasks.set(record.taskId, record);
  return { tasks };
}

function settleTask(
  state: BackgroundTaskState,
  taskId: string,
  status: BackgroundTaskStatus,
): BackgroundTaskState {
  const existing = state.tasks.get(taskId);
  if (existing === undefined || existing.status !== "running") {
    return state;
  }

  const tasks = new Map(state.tasks);
  tasks.set(taskId, { ...existing, status });
  return { tasks };
}
