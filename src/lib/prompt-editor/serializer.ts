import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import type { ImagePayload, ImageMediaType } from "@/types";

export interface SerializePromptDocArgs {
  doc: ProseMirrorNode;
  attachments: ImageAttachment[];
}

export interface SerializedPromptDoc {
  prompt: string;
  images: ImagePayload[];
}

/**
 * Convert a ProseMirror prompt document and its associated image attachments
 * into a wire payload `{ prompt, images }` consumable by the run-prompt API.
 *
 * Walks the doc's top-level paragraphs, joining them with `\n`. Within each
 * paragraph, plain text and `hardBreak` nodes contribute their text/newline,
 * and `imageMarker` atomic inline nodes are rendered as the literal string
 * `[Image #N]`. Each marker's `attachmentId` is mapped to its `index`,
 * producing `inlineMarkerIndex` on the matching attachment in the output.
 *
 * Attachments not referenced by any marker still appear in the output array
 * (in original `attachments` order) without an `inlineMarkerIndex` — these
 * are "strip-only" images that the server appends after the typed text.
 */
export function serializePromptDoc(
  args: SerializePromptDocArgs,
): SerializedPromptDoc {
  const { doc, attachments } = args;

  const paragraphTexts: string[] = [];
  const markerByAttachmentId = new Map<string, number>();

  doc.forEach((topLevel) => {
    if (topLevel.type.name !== "paragraph") {
      paragraphTexts.push(serializeInline(topLevel, markerByAttachmentId));
      return;
    }
    paragraphTexts.push(serializeInline(topLevel, markerByAttachmentId));
  });

  const prompt = paragraphTexts.join("\n");

  const images: ImagePayload[] = attachments.map((att) => {
    const inlineMarkerIndex = markerByAttachmentId.get(att.id);
    const payload: ImagePayload = {
      attachmentId: att.id,
      mediaType: att.mediaType as ImageMediaType,
      base64Data: att.base64Data,
    };
    if (inlineMarkerIndex !== undefined) {
      payload.inlineMarkerIndex = inlineMarkerIndex;
    }
    return payload;
  });

  return { prompt, images };
}

function serializeInline(
  parent: ProseMirrorNode,
  markerByAttachmentId: Map<string, number>,
): string {
  let out = "";
  parent.forEach((child) => {
    if (child.isText) {
      out += child.text ?? "";
      return;
    }
    if (child.type.name === "hardBreak") {
      out += "\n";
      return;
    }
    if (child.type.name === "imageMarker") {
      const index = child.attrs["index"] as number;
      const attachmentId = child.attrs["attachmentId"] as string;
      out += `[Image #${index}]`;
      if (typeof attachmentId === "string" && attachmentId.length > 0) {
        markerByAttachmentId.set(attachmentId, index);
      }
      return;
    }
    out += serializeInline(child, markerByAttachmentId);
  });
  return out;
}
