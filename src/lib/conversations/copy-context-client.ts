import { apiFetch } from "@/lib/api/fetcher";
import { copyContextSessionSchema } from "./copy-context-schemas";
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
  const session = await apiFetch(
    `/api/projects/${encodeURIComponent(target.projectName)}/sessions/${encodeURIComponent(target.sessionName)}`,
    copyContextSessionSchema,
  );
  const text = buildConversationContext({
    projectName: target.projectName,
    sessionName: target.sessionName,
    session,
    conversationId: target.conversationId,
  });
  await navigator.clipboard.writeText(text);
}
