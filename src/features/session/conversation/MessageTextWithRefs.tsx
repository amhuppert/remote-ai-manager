"use client";

// A ref splits the surrounding markdown — block-level markdown spanning the
// ref boundary is broken on render. Acceptable v1 limitation.

import type {
  ConversationRefAttrs,
  MessageRefAttrs,
} from "@/lib/conversations/schemas";
import { segmentTextByRefs } from "@/lib/conversations/ref-segments";
import DefaultMarkdownContent from "@/components/LazyMarkdownContent";
import DefaultConversationLinkChip from "./ConversationLinkChip";
import DefaultMessageRefLinkChip from "./MessageRefLinkChip";

export interface MessageTextWithRefsDeps {
  MarkdownContent: React.ComponentType<{ content: string }>;
  ConversationLinkChip: React.ComponentType<{ attrs: ConversationRefAttrs }>;
  MessageRefChip: React.ComponentType<{ attrs: MessageRefAttrs }>;
}

interface MessageTextWithRefsProps {
  text: string;
}

export function createMessageTextWithRefs(
  deps: MessageTextWithRefsDeps,
): React.FC<MessageTextWithRefsProps> {
  return function MessageTextWithRefs({
    text,
  }: MessageTextWithRefsProps): React.JSX.Element {
    const segments = segmentTextByRefs(text);
    if (!segments.some((segment) => segment.type !== "text")) {
      return <deps.MarkdownContent content={text} />;
    }

    return (
      <>
        {segments.map((segment, index) => {
          if (segment.type === "conversation-ref") {
            return (
              <deps.ConversationLinkChip key={index} attrs={segment.attrs} />
            );
          }
          if (segment.type === "message-ref") {
            return <deps.MessageRefChip key={index} attrs={segment.attrs} />;
          }
          return <deps.MarkdownContent key={index} content={segment.text} />;
        })}
      </>
    );
  };
}

export const MessageTextWithRefs = createMessageTextWithRefs({
  MarkdownContent: DefaultMarkdownContent,
  ConversationLinkChip: DefaultConversationLinkChip,
  MessageRefChip: DefaultMessageRefLinkChip,
});

export default MessageTextWithRefs;
