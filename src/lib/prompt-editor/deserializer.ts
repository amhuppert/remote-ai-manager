import type { JSONContent } from "@tiptap/core";
import { segmentTextByRefs } from "@/lib/conversations/ref-segments";
import { conversationRefAttrsToMentionAttrs } from "./conversation-mention-node";
import { messageRefAttrsToMentionAttrs } from "./message-mention-node";
import { ticketRefAttrsToMentionAttrs } from "./ticket-mention-node";
import type { SerializedPromptDoc } from "./serializer";

/** Rebuild the editor document represented by canonical prompt markup. */
export function deserializePromptDoc(
  document: SerializedPromptDoc,
): JSONContent {
  const inlineImages = new Map(
    document.images.flatMap((image, imageIndex) =>
      image.inlineMarkerIndex === undefined
        ? []
        : [[image.inlineMarkerIndex, { image, imageIndex }] as const],
    ),
  );
  const paragraphs: JSONContent[] = [{ type: "paragraph", content: [] }];
  const currentContent = () => paragraphs.at(-1)!.content!;
  const pushText = (text: string) => {
    if (!text) return;
    currentContent().push({ type: "text", text });
  };
  const pushPlainText = (text: string) => {
    const tokenPattern = /\n|\[Image #(\d+)\]/g;
    let cursor = 0;
    for (const match of text.matchAll(tokenPattern)) {
      const start = match.index;
      pushText(text.slice(cursor, start));
      if (match[0] === "\n") {
        paragraphs.push({ type: "paragraph", content: [] });
      } else {
        const index = Number.parseInt(match[1] ?? "", 10);
        const inline = inlineImages.get(index);
        if (!inline) {
          pushText(match[0]);
        } else {
          const { image, imageIndex } = inline;
          currentContent().push({
            type: "imageMarker",
            attrs: {
              index,
              attachmentId: image.attachmentId,
              mediaType: image.mediaType,
              thumbnailUrl: `data:${image.mediaType};base64,${image.base64Data}`,
              fileName: `image-${imageIndex + 1}`,
            },
          });
        }
      }
      cursor = start + match[0].length;
    }
    pushText(text.slice(cursor));
  };

  for (const segment of segmentTextByRefs(document.prompt)) {
    if (segment.type === "text") {
      pushPlainText(segment.text);
      continue;
    }
    if (segment.type === "conversation-ref") {
      currentContent().push({
        type: "conversationMention",
        attrs: conversationRefAttrsToMentionAttrs(segment.attrs),
      });
      continue;
    }
    if (segment.type === "message-ref") {
      currentContent().push({
        type: "messageMention",
        attrs: messageRefAttrsToMentionAttrs(segment.attrs),
      });
      continue;
    }
    currentContent().push({
      type: "ticketMention",
      attrs: ticketRefAttrsToMentionAttrs(segment.attrs),
    });
  }

  return {
    type: "doc",
    content: paragraphs.map((paragraph) =>
      paragraph.content?.length ? paragraph : { type: "paragraph" },
    ),
  };
}
