import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { isWorkflowConversationLive } from "./inspector/conversation-history";

export interface ResolvedViewingTask {
  conversationId: string;
  contextTitle: string;
  taskTitle: string;
  isLive: boolean;
}

/**
 * Resolve the transcript viewer props for a given task.
 *
 * Backend-agnostic: takes the task's `lastConversationId` as-is (a normal CC
 * conversation ID, whether the context ran on Claude or Codex) and pairs it
 * with the context/task metadata needed by `WorkflowConversationViewer`.
 *
 * Returns `null` when the task has no conversation yet or the task is unknown.
 *
 * `isLive` is the CONVERSATION's, which is what the Log header's pill claims —
 * not the task's. A lane runs task after task in one conversation, so a
 * completed task leaves its transcript open, and a halted run that no longer
 * holds the execution lease leaves it closed however its lanes still read.
 */
export function resolveViewingTask(
  execution: GraphWorkflowExecution,
  taskId: string,
): ResolvedViewingTask | null {
  const taskDef = execution.workingDefinition.tasks.find(
    (t) => t.id === taskId,
  );
  const taskState = execution.taskStates[taskId];
  if (!taskDef || !taskState?.lastConversationId) return null;

  const context = execution.workingDefinition.executionContexts.find(
    (ctx) => ctx.id === taskDef.contextId,
  );

  return {
    conversationId: taskState.lastConversationId,
    contextTitle: context?.title ?? taskDef.contextId,
    taskTitle: taskDef.title,
    isLive: isWorkflowConversationLive(
      execution,
      taskDef.contextId,
      taskState.lastConversationId,
    ),
  };
}
