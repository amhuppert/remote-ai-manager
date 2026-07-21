import type { AgentBackendId } from "@/lib/shared/schemas";
export interface RuntimeTarget {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
  backend: AgentBackendId;
}

/**
 * Identity tuple for one conversation whose live runtime may need targeting.
 * The caller supplies these directly (identity-tier read), never a full
 * `SessionState` tree.
 */
export interface RuntimeTargetConversation {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

export function collectRuntimeTargets(input: {
  conversations: readonly RuntimeTargetConversation[];
  getProjectName(projectPath: string): string;
  getRuntime(
    conversationId: string,
  ): { status: "alive" | "dead"; backend: AgentBackendId } | undefined;
}): RuntimeTarget[] {
  const targets: RuntimeTarget[] = [];

  for (const conversation of input.conversations) {
    const runtime = input.getRuntime(conversation.conversationId);
    if (!runtime || runtime.status !== "alive") continue;
    targets.push({
      projectPath: conversation.projectPath,
      projectName: input.getProjectName(conversation.projectPath),
      sessionName: conversation.sessionName,
      conversationId: conversation.conversationId,
      backend: runtime.backend,
    });
  }

  return targets;
}
