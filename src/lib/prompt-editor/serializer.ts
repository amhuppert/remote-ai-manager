import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { ImageAttachment } from "@/hooks/use-image-attachments";
import type { ImagePayload, ImageMediaType } from "@/lib/images/schemas";
import { renderSkillReference } from "@/lib/commands/skill-reference";
import { buildNotepadImageToken } from "./notepad-image-token";
import { getReferenceByNodeName } from "./reference-registry";
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
 * Walks the doc's top-level blocks, joining them with `\n`. Within each
 * paragraph, plain text and `hardBreak` nodes contribute their text/newline,
 * `imageMarker` atomic inline nodes are rendered as the literal string
 * `[Image #N]`, `slashCommandMarker` chips emit their full name (e.g.
 * `/spec-init` or `$skill`), with an explicit file link for a selected Codex
 * skill, and `fileMention` chips emit `@<path>`.
 * Inline text carrying the `code` mark is wrapped in single backticks.
 * Top-level `codeBlock` nodes are rendered as triple-backtick fenced blocks
 * (with the `language` attribute included on the opening fence when set).
 *
 * Each `imageMarker`'s `attachmentId` is mapped to its `index`, producing
 * `inlineMarkerIndex` on the matching attachment in the output. Attachments
 * not referenced by any marker still appear in the output array (in original
 * `attachments` order) without an `inlineMarkerIndex` — these are
 * "strip-only" images that the server appends after the typed text.
 */
export function serializePromptDoc(
  args: SerializePromptDocArgs,
): SerializedPromptDoc {
  const { doc, attachments } = args;

  const blockTexts: string[] = [];
  const markerByAttachmentId = new Map<string, number>();

  doc.forEach((topLevel) => {
    if (topLevel.type.name === "codeBlock") {
      blockTexts.push(serializeCodeBlock(topLevel));
      return;
    }
    blockTexts.push(serializeInline(topLevel, markerByAttachmentId));
  });

  const prompt = blockTexts.join("\n");

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
      const text = child.text ?? "";
      const hasCodeMark = child.marks.some((m) => m.type.name === "code");
      out += hasCodeMark ? `\`${text}\`` : text;
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
    if (child.type.name === "notepadImage") {
      const imageId = child.attrs["imageId"];
      if (typeof imageId === "string" && imageId.length > 0) {
        out += buildNotepadImageToken(imageId);
      }
      return;
    }
    if (child.type.name === "slashCommandMarker") {
      const name = child.attrs["name"];
      const skillPath = child.attrs["skillPath"];
      if (typeof name === "string" && name.length > 0) {
        out +=
          name.startsWith("$") && typeof skillPath === "string" && skillPath
            ? renderSkillReference(name, skillPath)
            : name;
      }
      return;
    }
    if (child.type.name === "fileMention") {
      const path = child.attrs["path"];
      if (typeof path === "string" && path.length > 0) out += `@${path}`;
      return;
    }
    const reference = getReferenceByNodeName(child.type.name);
    if (reference) {
      out += reference.buildXml(child.attrs);
      return;
    }
    out += serializeInline(child, markerByAttachmentId);
  });
  return out;
}

function serializeCodeBlock(node: ProseMirrorNode): string {
  const rawLang = node.attrs["language"];
  const language = typeof rawLang === "string" ? rawLang : "";
  return `\`\`\`${language}\n${node.textContent}\n\`\`\``;
}
