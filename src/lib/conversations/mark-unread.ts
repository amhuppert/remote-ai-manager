/**
 * Mark a conversation as unread after a turn-finalize transition.
 *
 * Invoked from the conversation machine's `finalizingTurn` state whenever
 * an agent returns control to the user (running → awaiting). Pinned to a
 * pure function with injected deps so the role filter and event shape can
 * be tested without booting the state store or the SSE bus.
 *
 * Roles `iteration` and `validator` are workflow-managed and never appear
 * in the Active Conversations sidebar, so we skip both the DB write and
 * the SSE broadcast for them.
 */
import type {
  ConversationRole,
  ConversationState,
  ConversationUnreadEvent,
} from "./schemas";
import { conversationEventScopeFields } from "./project-conversation-scope";

export interface MarkUnreadOnFinishDeps {
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void | Promise<void>,
  ): Promise<void>;
  publishSessionStatus(event: ConversationUnreadEvent): {
    delivered: boolean;
  };
}

export interface MarkUnreadOnFinishContext {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  role: ConversationRole;
}

export async function markUnreadOnFinish(
  ctx: MarkUnreadOnFinishContext,
  deps: MarkUnreadOnFinishDeps,
): Promise<void> {
  if (ctx.role === "iteration" || ctx.role === "validator") return;

  await deps.mutateConversation(
    ctx.projectPath,
    ctx.sessionName,
    ctx.conversationId,
    "conversation.mark-unread-on-finish",
    (c) => {
      c.unread = true;
    },
  );

  deps.publishSessionStatus({
    type: "conversation-unread",
    ...conversationEventScopeFields(
      ctx.projectName,
      ctx.sessionName,
      ctx.conversationId,
    ),
    unread: true,
  });
}

export type WorkflowResultUnreadContext = Omit<
  MarkUnreadOnFinishContext,
  "role"
>;

export async function markWorkflowResultUnread(
  ctx: WorkflowResultUnreadContext,
  deps: MarkUnreadOnFinishDeps,
): Promise<void> {
  await deps.mutateConversation(
    ctx.projectPath,
    ctx.sessionName,
    ctx.conversationId,
    "conversation.mark-workflow-result-unread",
    (conversation) => {
      conversation.unread = true;
    },
  );

  deps.publishSessionStatus({
    type: "conversation-unread",
    ...conversationEventScopeFields(
      ctx.projectName,
      ctx.sessionName,
      ctx.conversationId,
    ),
    unread: true,
  });
}

/**
 * Clear `unread` at the start of a user-initiated turn (prompt submit or
 * question answer). Symmetric with markUnreadOnFinish — workflow-managed
 * roles are skipped because they never set `unread` in the first place.
 */
export async function markReadOnUserTurnStart(
  ctx: MarkUnreadOnFinishContext,
  deps: MarkUnreadOnFinishDeps,
): Promise<void> {
  if (ctx.role === "iteration" || ctx.role === "validator") return;

  await deps.mutateConversation(
    ctx.projectPath,
    ctx.sessionName,
    ctx.conversationId,
    "conversation.mark-read-on-user-turn-start",
    (c) => {
      c.unread = false;
    },
  );

  deps.publishSessionStatus({
    type: "conversation-unread",
    ...conversationEventScopeFields(
      ctx.projectName,
      ctx.sessionName,
      ctx.conversationId,
    ),
    unread: false,
  });
}
