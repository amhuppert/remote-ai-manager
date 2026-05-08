import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type { AgentBackendId } from "@/lib/schemas";

import type { ComposePortableMcpArgs } from "./compose-for-conversation";
import type { ResolvedPortableForConversation } from "./runtime-apply";

export interface ResolvePortableForConversationDeps {
  composePortableForConversation(
    args: ComposePortableMcpArgs,
  ): Promise<PortableMcpConfig>;
  getSessionWorktreePath(
    projectPath: string,
    sessionName: string,
  ): Promise<string | undefined>;
  getProjectDisplayName(projectPath: string): string;
  getConversationTooling(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): ConversationToolingOverrides | undefined;
}

export function createResolvePortableForConversation(
  deps: ResolvePortableForConversationDeps,
): (input: {
  projectPath: string;
  sessionName: string;
  conversationId: string;
  backend: AgentBackendId;
}) => Promise<ResolvedPortableForConversation> {
  return async (input) => {
    const sessionWorktreePath = await deps.getSessionWorktreePath(
      input.projectPath,
      input.sessionName,
    );
    const worktreePath = sessionWorktreePath ?? input.projectPath;
    const projectName = deps.getProjectDisplayName(input.projectPath);
    const tooling = deps.getConversationTooling({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
    });
    const transientPortableMcp = tooling?.portableMcp;
    const composeArgs: ComposePortableMcpArgs = {
      backend: input.backend,
      projectPath: input.projectPath,
      projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      worktreePath,
      ...(transientPortableMcp !== undefined ? { transientPortableMcp } : {}),
    };
    const portable = await deps.composePortableForConversation(composeArgs);
    return { portable };
  };
}
