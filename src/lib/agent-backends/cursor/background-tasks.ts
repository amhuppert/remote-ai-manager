import { z } from "zod";
import { conversationBackgroundTaskViewSchema } from "@/lib/conversations/schemas";
import type { ConversationBackgroundActivity } from "../conversation";

export const cursorTaskRecordSchema =
  conversationBackgroundTaskViewSchema.extend({
    runId: z.string(),
    callId: z.string(),
    status: z.enum(["running", "background", "completed", "failed", "lost"]),
  });
export const cursorTaskStateSchema = z.array(cursorTaskRecordSchema);
export type CursorTaskState = z.infer<typeof cursorTaskStateSchema>;
export interface CursorTaskStore {
  load(): Promise<CursorTaskState>;
  save(tasks: CursorTaskState): Promise<void>;
}
const toolEventSchema = z.object({
  type: z.literal("tool_call"),
  call_id: z.string().min(1),
  name: z.literal("task"),
  status: z.enum(["running", "completed", "error"]),
  args: z
    .object({
      description: z.string().optional(),
      subagentType: z.object({ kind: z.string() }).optional(),
    })
    .optional(),
  result: z
    .object({
      status: z.string(),
      value: z.object({ isBackground: z.boolean() }).optional(),
    })
    .optional(),
});
const deltaSchema = z.object({
  type: z.literal("cursor_task_delta"),
  update: z.object({
    type: z.literal("tool-call-delta"),
    callId: z.string(),
    taskUpdate: z.object({
      type: z.string(),
      toolCall: z.object({ type: z.string() }).optional(),
    }),
  }),
});
export function isCursorTaskRunning(task: CursorTaskState[number]): boolean {
  return task.status === "running" || task.status === "background";
}
export function applyCursorTaskEvent(
  state: CursorTaskState,
  event: unknown,
  runId: string,
  at: string,
): CursorTaskState {
  const delta = deltaSchema.safeParse(event);
  if (delta.success) {
    const { callId, taskUpdate } = delta.data.update;
    if (
      !["tool-call-started", "tool-call-completed", "step-completed"].includes(
        taskUpdate.type,
      )
    )
      return state;
    return state.map((task) =>
      task.runId === runId &&
      task.callId === callId &&
      isCursorTaskRunning(task)
        ? {
            ...task,
            lastActivityAt: at,
            lastToolName: taskUpdate.toolCall?.type ?? task.lastToolName,
          }
        : task,
    );
  }
  const parsed = toolEventSchema.safeParse(event);
  if (!parsed.success) return state;
  const source = parsed.data;
  const previous = state.find(
    (task) => task.runId === runId && task.callId === source.call_id,
  );
  if (previous && !isCursorTaskRunning(previous)) return state;
  if (previous && source.status === "running") return state;
  const status =
    source.status === "error" || source.result?.status === "error"
      ? "failed"
      : source.status === "completed" &&
          source.result?.status === "success" &&
          source.result.value
        ? source.result.value.isBackground
          ? "background"
          : "completed"
        : (previous?.status ?? "running");
  const task: CursorTaskState[number] = {
    taskId: `cursor:${runId}:${source.call_id}`,
    runId,
    callId: source.call_id,
    status,
    description: source.args?.description ?? previous?.description ?? null,
    taskType: status === "background" ? "background subagent" : "subagent",
    workflowName: null,
    subagentType: source.args?.subagentType?.kind ?? null,
    lastToolName: previous?.lastToolName ?? null,
    totalTokens: null,
    toolUses: null,
    startedAt: previous?.startedAt ?? at,
    lastActivityAt: at,
  };
  return previous
    ? state.map((current) => (current === previous ? task : current))
    : [...state, task];
}
export function cursorTaskActivity(
  state: CursorTaskState,
  at: string,
): ConversationBackgroundActivity | null {
  const tasks = state
    .filter(isCursorTaskRunning)
    .map((task) => conversationBackgroundTaskViewSchema.parse(task));
  return tasks.length ? { tasks, updatedAt: at } : null;
}

export const CURSOR_BACKGROUND_INSTRUCTIONS =
  "Cursor provider tasks: run subagents and shell commands to completion within this turn, and act on their results before ending. The SDK has no supported completion subscription after a run ends. Do not detach shell work with nohup, &, or disown and do not end a turn expecting a background notification. A task handle returned as background is not proof of completion; report any unobserved outcome. These are instructions, not enforced isolation.";
export const CURSOR_BACKGROUND_WARNING =
  "Provider tasks continue within the current turn. Background completion after a turn ends is unavailable; interrupted task outcomes are unknown and are reported when the conversation next runs.";
