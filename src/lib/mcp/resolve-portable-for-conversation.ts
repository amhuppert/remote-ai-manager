import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type { AgentBackendId } from "@/lib/shared/schemas";
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
  getConversationTooling(input: {
    projectPath: string;
    target: ConversationTarget;
  }): ConversationToolingOverrides | undefined;
}

export function createResolvePortableForConversation(
  deps: ResolvePortableForConversationDeps,
): (input: {
  projectPath: string;
  target: ConversationTarget;
  backend: AgentBackendId;
}) => Promise<ResolvedPortableForConversation> {
  return async (input) => {
    const sessionWorktreePath =
      input.target.scope === "session"
        ? await deps.getSessionWorktreePath(
            input.projectPath,
            input.target.sessionName,
          )
        : undefined;
    const worktreePath = sessionWorktreePath ?? input.projectPath;
    const tooling = deps.getConversationTooling({
      projectPath: input.projectPath,
      target: input.target,
    });
    const transientPortableMcp = tooling?.portableMcp;
    const composeArgs: ComposePortableMcpArgs = {
      backend: input.backend,
      projectPath: input.projectPath,
      target: input.target,
      worktreePath,
      ...(transientPortableMcp !== undefined ? { transientPortableMcp } : {}),
    };
    const portable = await deps.composePortableForConversation(composeArgs);
    return { portable };
  };
}
