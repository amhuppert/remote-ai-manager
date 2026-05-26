"use client";

// A ref splits the surrounding markdown — block-level markdown spanning the
// ref boundary is broken on render. Acceptable v1 limitation.

import {
  conversationRefAttrsSchema,
  type ConversationRefAttrs,
} from "@/lib/conversations/schemas";
import { findConversationRefs } from "@/lib/conversations/conversation-ref-parser";
import DefaultMarkdownContent from "@/components/LazyMarkdownContent";
import DefaultConversationLinkChip from "./ConversationLinkChip";

export interface MessageTextWithRefsDeps {
  MarkdownContent: React.ComponentType<{ content: string }>;
  ConversationLinkChip: React.ComponentType<{ attrs: ConversationRefAttrs }>;
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
    const refs = findConversationRefs(text);
    if (refs.length === 0) {
      return <deps.MarkdownContent content={text} />;
    }

    const children: React.ReactNode[] = [];
    let cursor = 0;
    let key = 0;

    for (const ref of refs) {
      if (ref.start > cursor) {
        const segment = text.slice(cursor, ref.start);
        children.push(
          <deps.MarkdownContent key={`md-${key++}`} content={segment} />,
        );
      }

      const parsed = conversationRefAttrsSchema.safeParse(ref.attrs);
      if (parsed.success) {
        children.push(
          <deps.ConversationLinkChip
            key={`chip-${key++}`}
            attrs={parsed.data}
          />,
        );
      } else {
        children.push(
          <deps.MarkdownContent key={`md-${key++}`} content={ref.raw} />,
        );
      }

      cursor = ref.end;
    }

    if (cursor < text.length) {
      const tail = text.slice(cursor);
      children.push(
        <deps.MarkdownContent key={`md-${key++}`} content={tail} />,
      );
    }

    return <>{children}</>;
  };
}

export const MessageTextWithRefs = createMessageTextWithRefs({
  MarkdownContent: DefaultMarkdownContent,
  ConversationLinkChip: DefaultConversationLinkChip,
});

export default MessageTextWithRefs;
