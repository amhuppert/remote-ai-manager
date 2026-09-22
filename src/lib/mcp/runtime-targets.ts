import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { AgentBackendId } from "@/lib/shared/schemas";

export interface RuntimeTargetConversation {
  projectPath: string;
  target: ConversationTarget;
}

export interface RuntimeTarget extends RuntimeTargetConversation {
  backend: AgentBackendId;
}

export function collectRuntimeTargets(input: {
  conversations: readonly RuntimeTargetConversation[];
  getRuntime(
    conversationId: string,
  ): { status: "alive" | "dead"; backend: AgentBackendId } | undefined;
}): RuntimeTarget[] {
  return input.conversations.flatMap((conversation) => {
    const runtime = input.getRuntime(conversation.target.conversationId);
    return runtime?.status === "alive"
      ? [{ ...conversation, backend: runtime.backend }]
      : [];
  });
}
