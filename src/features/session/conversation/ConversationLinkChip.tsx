"use client";

import type { ConversationRefAttrs } from "@/lib/conversations/schemas";
import { buildConversationRefXml } from "@/lib/conversations/conversation-ref";
import { conversationRefAttrsToMentionAttrs } from "@/lib/prompt-editor/conversation-mention-node";
import { LiveReferenceChip } from "@/components/references/LiveReferenceChip";

export default function ConversationLinkChip({
  attrs,
}: {
  attrs: ConversationRefAttrs;
}): React.JSX.Element {
  return (
    <LiveReferenceChip
      target={{
        kind: "conversation",
        projectName: attrs["project-name"],
        id: attrs["conversation-id"],
      }}
      title={attrs["conversation-name"]}
      identity={attrs["conversation-id"]}
      reference={buildConversationRefXml(
        conversationRefAttrsToMentionAttrs(attrs),
      )}
    />
  );
}
