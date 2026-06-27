import { readConfig } from "@/lib/config/loader";
import { getConversation } from "@/lib/state-store";

import { queueMessage } from "./queue";

export interface EnqueueConversationMessageInput {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  message: string;
}

/**
 * Enqueue a plain message turn into a conversation, resolving the delivery
 * backend from the conversation (falling back to the configured default). The
 * next queue drain delivers it to the agent as an ordinary user turn — used to
 * route alignment authoring/incorporation/feedback turns back into the session.
 */
export async function enqueueConversationMessage(
  input: EnqueueConversationMessageInput,
): Promise<void> {
  const { projectPath, sessionName, conversationId, message } = input;
  const conversation = await getConversation(
    projectPath,
    sessionName,
    conversationId,
  );
  const backend =
    conversation?.agentBackend ?? (await readConfig()).defaultAgentBackend;
  await queueMessage({
    projectPath,
    sessionName,
    conversationId,
    text: message,
    backend,
  });
}
