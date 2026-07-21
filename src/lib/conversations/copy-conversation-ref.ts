import { apiFetchOptional } from "@/lib/api/fetcher";
import { buildConversationRefXmlFromListItem } from "./conversation-ref";
import { conversationListItemSchema } from "./schemas";

/**
 * Copy the canonical `<conversation-ref ... />` tag for a conversation to the
 * clipboard. Resolves the full addressable-conversation projection first so
 * the ref carries backend/compaction metadata the sidebar row doesn't hold.
 * Returns false when the conversation cannot be resolved (lookup 404).
 */
export async function copyConversationRefToClipboard(
  conversationId: string,
): Promise<boolean> {
  const item = await apiFetchOptional(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    conversationListItemSchema,
  );
  if (item === null) return false;
  await navigator.clipboard.writeText(
    buildConversationRefXmlFromListItem(item),
  );
  return true;
}
