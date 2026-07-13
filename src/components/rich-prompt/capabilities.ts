import type { AgentBackendId } from "@/lib/shared/schemas";

interface PromptCapabilityCommon {
  projectName: string;
  backend?: AgentBackendId;
  isWorkflowManagedConversation?: boolean;
}

export type PromptCapabilityContext =
  | (PromptCapabilityCommon & {
      sessionName?: never;
      conversationId?: never;
    })
  | (PromptCapabilityCommon & {
      sessionName: string;
      conversationId: string;
    });

export type ResolvedPromptCapabilityContext = PromptCapabilityCommon & {
  scope: "project" | "conversation";
  backend: AgentBackendId | undefined;
  isWorkflowManagedConversation: boolean;
  sessionName?: string;
  conversationId?: string;
};

export function resolvePromptCapabilityContext(
  context: PromptCapabilityContext,
): ResolvedPromptCapabilityContext {
  const established =
    context.sessionName !== undefined && context.conversationId !== undefined;
  return {
    scope: established ? "conversation" : "project",
    projectName: context.projectName,
    ...(established
      ? {
          sessionName: context.sessionName,
          conversationId: context.conversationId,
        }
      : {}),
    backend: context.backend,
    isWorkflowManagedConversation:
      context.isWorkflowManagedConversation ?? false,
  };
}
