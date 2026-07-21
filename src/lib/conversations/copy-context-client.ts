import { apiFetch } from "@/lib/api/fetcher";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { graphWorkflowExecutionFullResponseSchema } from "@/lib/workflow-graph/schemas";
import { buildConversationContext } from "./copy-context";

/**
 * Fetch the owning session (plus its decoupled graph-workflow execution) and
 * copy the conversation's `<conversation-context>` XML to the clipboard —
 * the context-menu "Copy context" action, shared by the sidebar rows and the
 * conversation tab strip.
 */
export async function copyConversationContextToClipboard(target: {
  projectName: string;
  sessionName: string;
  conversationId: string;
}): Promise<void> {
  const [session, executionResponse] = await Promise.all([
    apiFetch(
      `/api/projects/${encodeURIComponent(target.projectName)}/sessions/${encodeURIComponent(target.sessionName)}`,
      sessionStateSchema,
    ),
    // The execution no longer rides the session payload (decoupled table),
    // so fetch it separately to keep the workflow block in the copy.
    apiFetch(
      `/api/projects/${encodeURIComponent(target.projectName)}/sessions/${encodeURIComponent(target.sessionName)}/graph-workflow/execution`,
      graphWorkflowExecutionFullResponseSchema,
    ),
  ]);
  const text = buildConversationContext({
    projectName: target.projectName,
    sessionName: target.sessionName,
    session,
    conversationId: target.conversationId,
    graphWorkflowExecution: executionResponse.execution,
  });
  await navigator.clipboard.writeText(text);
}
