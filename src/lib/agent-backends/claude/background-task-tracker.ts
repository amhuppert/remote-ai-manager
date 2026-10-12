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
 * A task the SDK marks `ambient` (every `skip_transcript` task and every
 * live-update watcher) is excluded too: it is not activity, so nothing may
 * wait on it or stay alive for it.
 *
 * A second path into `excluded` exists after classification: a waitable task
 * that survives a full settlement-wait timeout has empirically proven it is
 * not going to settle on its own (a dev server, a watcher), so the caller
 * demotes it via `demoteTasksToExcluded` and it stops holding future
 * settlement barriers open.
 *
 * No I/O, no timers, no logging side effects. The input state is never mutated.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ConversationBackgroundActivity } from "@/lib/conversations/schemas";

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
  /** `opts.nowMs` when the task entered the set. */
  startedAtMs: number;
  /** `opts.nowMs` at the most recent task-scoped message — the liveness proof. */
  lastActivityAtMs: number;
  /** Ambient/housekeeping task the SDK asks consumers to hide inline. */
  skipTranscript: boolean;
  /**
   * Known to run in the background rather than block a tool call. Only a
   * background task's end makes the CLI start a continuation; a foreground
   * task's output returns inside the turn that ran it.
   */
  backgrounded: boolean;
  taskType: string | null;
  /** Workflow script `meta.name`; set only for `local_workflow` tasks. */
  workflowName: string | null;
  subagentType: string | null;
  lastToolName: string | null;
  totalTokens: number | null;
  toolUses: number | null;
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
  /**
   * Wall clock the reducer stamps onto the record's activity timestamps. Passed
   * in rather than read here so the reducer stays pure and unit-testable;
   * defaults to 0 so a caller that does not care about liveness (and every
   * pre-existing test) behaves exactly as before.
   */
  nowMs?: number;
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

  const nowMs = opts?.nowMs ?? 0;

  switch (message.subtype) {
    case "task_started": {
      const toolName = message.tool_use_id
        ? opts?.toolNamesById?.get(message.tool_use_id)
        : undefined;
      return addTask(state, {
        taskId: message.task_id,
        toolUseId: message.tool_use_id ?? null,
        classification:
          message.ambient === true ? "excluded" : classifyByToolName(toolName),
        description: message.description ?? null,
        nowMs,
        skipTranscript: message.skip_transcript ?? false,
        backgrounded: message.is_backgrounded === true,
        taskType: message.task_type ?? null,
        workflowName: message.workflow_name ?? null,
        subagentType: message.subagent_type ?? null,
      });
    }
    case "task_notification":
      return settleTask(state, message.task_id, message.status, nowMs);
    case "task_updated": {
      const next = message.patch.status;
      if (next === "completed" || next === "failed" || next === "killed") {
        return settleTask(state, message.task_id, next, nowMs);
      }
      // A non-terminal patch (`paused`, `running`, a description edit) is still
      // proof the task exists and the harness is talking about it.
      return touchTask(
        state,
        message.task_id,
        nowMs,
        message.patch.is_backgrounded === true,
      );
    }
    case "task_progress": {
      const existing = state.tasks.get(message.task_id);
      if (existing === undefined) {
        // Progress without a `task_started` bookend proves the task exists;
        // adopt it rather than losing the liveness signal entirely.
        return addTask(state, {
          taskId: message.task_id,
          toolUseId: message.tool_use_id ?? null,
          classification: "waitable",
          description: message.description ?? null,
          nowMs,
          skipTranscript: false,
          backgrounded: false,
          taskType: null,
          workflowName: null,
          subagentType: message.subagent_type ?? null,
        });
      }
      if (existing.status !== "running") return state;
      return replaceTask(state, {
        ...existing,
        description: message.description ?? existing.description,
        subagentType: message.subagent_type ?? existing.subagentType,
        lastToolName: message.last_tool_name ?? existing.lastToolName,
        totalTokens: message.usage.total_tokens,
        toolUses: message.usage.tool_uses,
        lastActivityAtMs: nowMs,
      });
    }
    case "background_tasks_changed":
      return reconcileWithLevelSignal(state, message.tasks, nowMs);
    default:
      return state;
  }
}

/**
 * Apply the SDK's `background_tasks_changed` level signal, which carries the
 * full live set with REPLACE semantics. Reconciliation is deliberately
 * monotone-safe in one direction only: a running task the payload omits is
 * settled (neutrally, as `completed` — the edge bookend that may still arrive
 * is then a no-op), and a payload task we have never seen is adopted, but a
 * task we already settled is never resurrected. Ordering between this level
 * signal and the edge bookends for the same transition is unspecified, so any
 * rule that could move a task backwards would race. The payload lists only
 * background tasks, so membership proves a task is backgrounded; an `ambient`
 * flag excludes the task and is never cleared again.
 */
function reconcileWithLevelSignal(
  state: BackgroundTaskState,
  payload: readonly {
    task_id: string;
    task_type: string;
    description: string;
    ambient?: boolean;
  }[],
  nowMs: number,
): BackgroundTaskState {
  const live = new Map(payload.map((t) => [t.task_id, t]));
  let tasks: Map<string, BackgroundTaskRecord> | null = null;
  const mutable = (): Map<string, BackgroundTaskRecord> =>
    (tasks ??= new Map(state.tasks));

  for (const record of state.tasks.values()) {
    if (record.status !== "running") continue;
    const entry = live.get(record.taskId);
    if (entry !== undefined) {
      mutable().set(record.taskId, {
        ...record,
        backgrounded: true,
        classification:
          entry.ambient === true ? "excluded" : record.classification,
        lastActivityAtMs: nowMs,
      });
      continue;
    }
    mutable().set(record.taskId, {
      ...record,
      status: "completed",
      lastActivityAtMs: nowMs,
    });
  }

  for (const task of payload) {
    if (state.tasks.has(task.task_id)) continue;
    mutable().set(task.task_id, {
      taskId: task.task_id,
      toolUseId: null,
      classification: task.ambient === true ? "excluded" : "waitable",
      status: "running",
      description: task.description,
      startedAtMs: nowMs,
      lastActivityAtMs: nowMs,
      skipTranscript: false,
      backgrounded: true,
      taskType: task.task_type,
      workflowName: null,
      subagentType: null,
      lastToolName: null,
      totalTokens: null,
      toolUses: null,
    });
  }

  return tasks === null ? state : { tasks };
}

/**
 * Project the tracker state onto the conversation-visible activity snapshot:
 * the waitable, running, non-`skip_transcript` tasks only. Excluded watches,
 * wait-timeout demotions, settled tasks, and ambient housekeeping tasks never
 * reach the UI. Returns null when nothing qualifies, so absence has exactly one
 * representation on the wire and in the row field.
 */
export function snapshotBackgroundActivity(
  state: BackgroundTaskState,
  nowMs: number,
): ConversationBackgroundActivity | null {
  const tasks = [...state.tasks.values()]
    .filter(isVisibleWaitableTask)
    .map((record) => ({
      taskId: record.taskId,
      description: record.description,
      taskType: record.taskType,
      workflowName: record.workflowName,
      subagentType: record.subagentType,
      lastToolName: record.lastToolName,
      totalTokens: record.totalTokens,
      toolUses: record.toolUses,
      startedAt: new Date(record.startedAtMs).toISOString(),
      lastActivityAt: new Date(record.lastActivityAtMs).toISOString(),
    }));

  if (tasks.length === 0) return null;
  return { tasks, updatedAt: new Date(nowMs).toISOString() };
}

/** Whether a task the conversation can see is still running. */
export function hasVisibleTaskInFlight(state: BackgroundTaskState): boolean {
  for (const record of state.tasks.values()) {
    if (isVisibleWaitableTask(record)) return true;
  }
  return false;
}

/**
 * Tasks whose end, between `before` and `after`, the CLI will answer with a
 * continuation turn: visible waitable background tasks that just left
 * `running`. Each task ends once, so whichever frame ends it (the level
 * signal, a terminal `task_updated` or the notification) reports it and the
 * later frames for the same task report nothing.
 */
export function continuationDebtCreated(
  before: BackgroundTaskState,
  after: BackgroundTaskState,
): string[] {
  if (before === after) return [];
  const ended: string[] = [];
  for (const record of after.tasks.values()) {
    const prior = before.tasks.get(record.taskId);
    if (prior === undefined || !isVisibleWaitableTask(prior)) continue;
    if (record.status === "running" || !record.backgrounded) continue;
    ended.push(record.taskId);
  }
  return ended;
}

function isVisibleWaitableTask(record: BackgroundTaskRecord): boolean {
  return (
    record.classification === "waitable" &&
    record.status === "running" &&
    !record.skipTranscript
  );
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
 * Reclassify the given running tasks as `excluded` so they leave the waitable
 * set. Used when a task survives a full settlement-wait timeout: it will not
 * settle on its own, so it must not hold later barriers open. Unknown or
 * already-settled ids are no-ops; the input state is never mutated.
 */
export function demoteTasksToExcluded(
  state: BackgroundTaskState,
  taskIds: string[],
): BackgroundTaskState {
  let tasks: Map<string, BackgroundTaskRecord> | null = null;
  for (const taskId of taskIds) {
    const existing = state.tasks.get(taskId);
    if (existing === undefined || existing.status !== "running") continue;
    if (existing.classification === "excluded") continue;
    tasks ??= new Map(state.tasks);
    tasks.set(taskId, { ...existing, classification: "excluded" });
  }
  return tasks === null ? state : { tasks };
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
    nowMs: number;
    skipTranscript: boolean;
    backgrounded: boolean;
    taskType: string | null;
    workflowName: string | null;
    subagentType: string | null;
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
    startedAtMs: input.nowMs,
    lastActivityAtMs: input.nowMs,
    skipTranscript: input.skipTranscript,
    backgrounded: input.backgrounded,
    taskType: input.taskType,
    workflowName: input.workflowName,
    subagentType: input.subagentType,
    lastToolName: null,
    totalTokens: null,
    toolUses: null,
  };

  return replaceTask(state, record);
}

function replaceTask(
  state: BackgroundTaskState,
  record: BackgroundTaskRecord,
): BackgroundTaskState {
  const tasks = new Map(state.tasks);
  tasks.set(record.taskId, record);
  return { tasks };
}

function settleTask(
  state: BackgroundTaskState,
  taskId: string,
  status: BackgroundTaskStatus,
  nowMs: number,
): BackgroundTaskState {
  const existing = state.tasks.get(taskId);
  if (existing === undefined || existing.status !== "running") {
    return state;
  }

  return replaceTask(state, { ...existing, status, lastActivityAtMs: nowMs });
}

/**
 * Record liveness for a running task without changing set membership, and
 * whether the task has moved to the background.
 */
function touchTask(
  state: BackgroundTaskState,
  taskId: string,
  nowMs: number,
  movedToBackground: boolean,
): BackgroundTaskState {
  const existing = state.tasks.get(taskId);
  if (existing === undefined || existing.status !== "running") {
    return state;
  }
  return replaceTask(state, {
    ...existing,
    backgrounded: existing.backgrounded || movedToBackground,
    lastActivityAtMs: nowMs,
  });
}
