import type { JSONContent } from "@tiptap/core";
import {
  segmentTextByRefs,
  type RefSegment,
} from "@/lib/conversations/ref-segments";
import { findNotepadImageTokens } from "./notepad-image-token";
import { getReferenceByXmlTag } from "./reference-registry";
import type { SerializedPromptDoc } from "./serializer";

interface InlineTextSegment {
  type: "text";
  text: string;
}

type ReferenceSegment = Exclude<RefSegment, { type: "text" }>;
type InlineToken = InlineTextSegment | ReferenceSegment | { type: "delimiter" };

export interface DeserializePromptDocOptions {
  /**
   * Rebuild `notepadImage` nodes from id-addressed `[Image: <id>]` tokens.
   * Only notepad editors register that node, so prompt input leaves the
   * option off and the token stays literal text there.
   */
  notepadImages?: boolean;
}

/** Rebuild the editor document represented by canonical prompt markup. */
export function deserializePromptDoc(
  document: SerializedPromptDoc,
  options: DeserializePromptDocOptions = {},
): JSONContent {
  const inlineImages = new Map(
    document.images.flatMap((image, imageIndex) =>
      image.inlineMarkerIndex === undefined
        ? []
        : [[image.inlineMarkerIndex, { image, imageIndex }] as const],
    ),
  );
  const blocks: JSONContent[] = [];
  const lines = document.prompt.replace(/\r\n?/g, "\n").split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const language = parseFenceLanguage(lines[lineIndex]!);
    const closingFenceIndex =
      language === null ? -1 : findClosingFence(lines, lineIndex + 1);

    if (closingFenceIndex !== -1) {
      const code = lines.slice(lineIndex + 1, closingFenceIndex).join("\n");
      blocks.push({
        type: "codeBlock",
        attrs: { language: language || null },
        ...(code ? { content: [{ type: "text", text: code }] } : {}),
      });
      lineIndex = closingFenceIndex;
      continue;
    }

    const content: JSONContent[] = [];
    const pushText = (text: string, code = false) => {
      if (!text) return;
      const previous = content.at(-1);
      const previousIsCode =
        previous?.type === "text" &&
        previous.marks?.some((mark) => mark.type === "code") === true;
      if (previous?.type === "text" && previousIsCode === code) {
        previous.text = `${previous.text ?? ""}${text}`;
        return;
      }
      content.push({
        type: "text",
        text,
        ...(code ? { marks: [{ type: "code" }] } : {}),
      });
    };
    const pushTextAndImages = (text: string) => {
      const imagePattern = /\[Image #(\d+)\]/g;
      let cursor = 0;
      for (const match of text.matchAll(imagePattern)) {
        const start = match.index;
        pushText(text.slice(cursor, start));
        const index = Number.parseInt(match[1] ?? "", 10);
        const inline = inlineImages.get(index);
        if (!inline) {
          pushText(match[0]);
        } else {
          const { image, imageIndex } = inline;
          content.push({
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
        cursor = start + match[0].length;
      }
      pushText(text.slice(cursor));
    };
    const pushInline = (text: string) => {
      if (!options.notepadImages) {
        pushTextAndImages(text);
        return;
      }
      let cursor = 0;
      for (const token of findNotepadImageTokens(text)) {
        pushTextAndImages(text.slice(cursor, token.start));
        content.push({
          type: "notepadImage",
          attrs: { imageId: token.imageId, fileName: "" },
        });
        cursor = token.end;
      }
      pushTextAndImages(text.slice(cursor));
    };

    const tokens = tokenizeInlineContent(lines[lineIndex]!);
    const delimiterCount = tokens.filter(
      (token) => token.type === "delimiter",
    ).length;
    const pairedDelimiterCount = delimiterCount - (delimiterCount % 2);
    let delimiterIndex = 0;
    let code = false;

    for (const token of tokens) {
      if (token.type === "delimiter") {
        if (delimiterIndex < pairedDelimiterCount) {
          code = !code;
        } else {
          pushText("`");
        }
        delimiterIndex += 1;
        continue;
      }

      if (token.type === "text") {
        if (code) {
          pushText(token.text, true);
        } else {
          pushInline(token.text);
        }
        continue;
      }

      if (code) {
        pushText(token.raw, true);
        continue;
      }
      // Reference tokens map through the registry so every ref kind
      // (conversation/message/ticket plus the spec element family) rebuilds
      // its mention node from one source of truth.
      const reference = getReferenceByXmlTag(token.type);
      if (!reference) continue;
      content.push({
        type: reference.nodeName,
        attrs: reference.parseAttrs(token.attrs),
      });
    }

    blocks.push(
      content.length ? { type: "paragraph", content } : { type: "paragraph" },
    );
  }

  return { type: "doc", content: blocks };
}

function parseFenceLanguage(line: string): string | null {
  if (!line.startsWith("```") || line.slice(3).includes("`")) return null;
  return line.slice(3).trim();
}

function findClosingFence(lines: string[], fromIndex: number): number {
  for (let lineIndex = fromIndex; lineIndex < lines.length; lineIndex += 1) {
    if (lines[lineIndex] === "```") return lineIndex;
  }
  return -1;
}

function tokenizeInlineContent(text: string): InlineToken[] {
  return segmentTextByRefs(text).flatMap((segment) => {
    if (segment.type !== "text") return [segment];

    const tokens: InlineToken[] = [];
    let cursor = 0;
    while (cursor < segment.text.length) {
      const backtick = findSingleBacktick(segment.text, cursor);
      if (backtick === -1) break;
      if (backtick > cursor) {
        tokens.push({
          type: "text",
          text: segment.text.slice(cursor, backtick),
        });
      }
      tokens.push({ type: "delimiter" });
      cursor = backtick + 1;
    }
    if (cursor < segment.text.length) {
      tokens.push({ type: "text", text: segment.text.slice(cursor) });
    }
    return tokens;
  });
}

function findSingleBacktick(text: string, fromIndex: number): number {
  for (let index = fromIndex; index < text.length; index += 1) {
    if (text[index] !== "`") continue;
    if (text[index - 1] === "`" || text[index + 1] === "`") continue;
    return index;
  }
  return -1;
}
