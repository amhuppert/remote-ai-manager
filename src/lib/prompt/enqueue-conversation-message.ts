import { readConfig as defaultReadConfig } from "@/lib/config/loader";
import { getConversation as defaultGetConversation } from "@/lib/state-store";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

import { queueMessage as defaultQueueMessage } from "./queue";

export interface EnqueueConversationMessageInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  message: string;
  modelSelection?: BackendModelSelection;
  /** Prevent this generated message from steering an in-progress agent turn. */
  deliveryPolicy?: "next_turn";
}

export interface EnqueueConversationMessageDeps {
  getConversation(
    ...args: Parameters<typeof defaultGetConversation>
  ): ReturnType<typeof defaultGetConversation>;
  readConfig(): ReturnType<typeof defaultReadConfig>;
  queueMessage(
    ...args: Parameters<typeof defaultQueueMessage>
  ): ReturnType<typeof defaultQueueMessage>;
  /**
   * Start (or reuse) the conversation actor and drain its pending queue, which
   * is what actually delivers this turn to the agent when no turn is currently
   * running.
   */
  ensureConversationActorAndDrain(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<void>;
}

const defaultDeps: EnqueueConversationMessageDeps = {
  getConversation: defaultGetConversation,
  readConfig: defaultReadConfig,
  queueMessage: defaultQueueMessage,
  async ensureConversationActorAndDrain(
    projectPath,
    sessionName,
    conversationId,
  ) {
    // Dynamic import keeps the conversation-actor machinery off the static
    // import graph of the alignment/command callers (mirrors dispatch.ts).
    const { ensureConversationActorAndDrain } =
      await import("@/lib/workflows/conversation/manager");
    await ensureConversationActorAndDrain(
      projectPath,
      sessionName,
      conversationId,
    );
  },
};

/**
 * Enqueue a plain message turn into a conversation, resolving the delivery
 * backend from the conversation (falling back to the configured default), then
 * ensure the conversation actor is running so its idle-entry queue drain
 * delivers the turn to the agent — used to route alignment
 * authoring/incorporation/feedback turns back into the session.
 */
export async function enqueueConversationMessage(
  input: EnqueueConversationMessageInput,
  depsOverride?: Partial<EnqueueConversationMessageDeps>,
): Promise<void> {
  const deps = { ...defaultDeps, ...depsOverride };
  const {
    projectPath,
    sessionName,
    conversationId,
    message,
    modelSelection,
    deliveryPolicy,
  } = input;
  const conversation = await deps.getConversation(
    projectPath,
    sessionName,
    conversationId,
  );
  const backend =
    conversation?.agentBackend ?? (await deps.readConfig()).defaultAgentBackend;
  await deps.queueMessage({
    projectPath,
    sessionName,
    conversationId,
    text: message,
    backend,
    ...(modelSelection !== undefined ? { modelSelection } : {}),
    ...(deliveryPolicy ? { deliveryPolicy } : {}),
  });

  // Enqueue alone leaves the row pending: in-turn delivery has no live runtime
  // when no turn is running, and the next-turn drain only fires on a live
  // actor's idle entry. Ensuring + draining the actor delivers this turn — the
  // path that runs the agent for /align on an otherwise-idle conversation.
  await deps.ensureConversationActorAndDrain(
    projectPath,
    sessionName,
    conversationId,
  );
}
