import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * Which conversation is an execution context's implementer right now.
 *
 * Pure and dependency-free on purpose: this is the freshness half of lane
 * authorization — a signed lane capability proves the caller was HANDED
 * credentials for a conversation, and this answers whether that conversation is
 * still the one driving the context. Both the lane tool-context loader (which
 * binds tool calls) and the expansion service (which re-checks the binding
 * inside its serialized mutation) read it, so it cannot live in a module that
 * drags the state store in with it.
 *
 * Resolution order: the running task's `lastConversationId` where one exists,
 * else any running task's, else the lane's `workflowConversationId`. `null` when
 * nothing in the context is live.
 */
export function resolveBoundConversationId(
  execution: GraphWorkflowExecution,
  contextId: string,
): string | null {
  for (const taskState of Object.values(execution.taskStates)) {
    if (taskState.contextId !== contextId) {
      continue;
    }
    if (taskState.status !== "running") {
      continue;
    }
    if (taskState.lastConversationId) {
      return taskState.lastConversationId;
    }
  }

  const laneByKind = execution.laneStates[contextId];
  if (laneByKind) {
    for (const lane of Object.values(laneByKind)) {
      if (lane.workflowConversationId) {
        return lane.workflowConversationId;
      }
    }
  }

  return null;
}

/**
 * The inverse: which execution context a conversation is driving right now.
 * Reads the same records as {@link resolveBoundConversationId} — a running
 * task's `lastConversationId`, else a lane record's `workflowConversationId` —
 * so the two can never disagree about a binding. The memory contribution gate
 * uses it to place a lane's writes under its context's seeded policy from the
 * execution's own state, never from an id the caller supplies. `null` when
 * nothing in the execution names the conversation.
 */
export function findLaneBindingForConversation(
  execution: GraphWorkflowExecution,
  conversationId: string,
): { executionId: string; contextId: string } | null {
  for (const taskState of Object.values(execution.taskStates)) {
    if (
      taskState.status === "running" &&
      taskState.lastConversationId === conversationId
    ) {
      return { executionId: execution.id, contextId: taskState.contextId };
    }
  }
  for (const [contextId, laneByKind] of Object.entries(execution.laneStates)) {
    for (const lane of Object.values(laneByKind)) {
      if (lane.workflowConversationId === conversationId) {
        return { executionId: execution.id, contextId };
      }
    }
  }
  return null;
}
