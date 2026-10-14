import type {
  DocumentFeedbackPayload,
  MessageContentBlock,
  NotepadFeedbackPayload,
} from "./message-content-schemas";
import type { ImagePayload } from "@/lib/images/schemas";

/**
 * Build the content blocks from raw `{ text, images, feedback }`. Text (when
 * non-empty) becomes a single `text` block first, then each image becomes an
 * inline base64 `image` block, then the review-feedback blocks (when present)
 * are appended. This is the format the next-turn drain coalesces, so the
 * live-delivery path keeps it consistent.
 *
 * NOTE: neither a `document_feedback` nor a `notepad_feedback` block is a valid
 * backend (SDK) content block — callers that deliver content to the backend
 * (`queueUserInput`) must omit them and carry the derived prose as a `text`
 * block instead.
 */
export function buildQueueContent(args: {
  text?: string;
  images?: readonly ImagePayload[];
  documentFeedback?: DocumentFeedbackPayload;
  notepadFeedback?: NotepadFeedbackPayload;
}): MessageContentBlock[] {
  const content: MessageContentBlock[] = [];
  if (args.text && args.text.length > 0) {
    content.push({ type: "text", text: args.text });
  }
  for (const image of args.images ?? []) {
    content.push({
      type: "image",
      mediaType: image.mediaType,
      base64Data: image.base64Data,
    });
  }
  if (args.documentFeedback) {
    content.push({
      type: "document_feedback",
      items: args.documentFeedback.items,
    });
  }
  if (args.notepadFeedback) {
    content.push({
      type: "notepad_feedback",
      notepadId: args.notepadFeedback.notepadId,
      notepadName: args.notepadFeedback.notepadName,
      notepadRefXml: args.notepadFeedback.notepadRefXml,
      items: args.notepadFeedback.items,
    });
  }
  return content;
}

/**
 * Turn input that never ran (a message a restart withdrew before it started),
 * as the queue keeps it for review: content the next-turn drain reads back
 * into the same input. Feedback keeps its structured blocks, from which the
 * turn derives its prose again.
 */
export function queueContentOfTurnInput(input: {
  text: string;
  images?: readonly ImagePayload[];
  documentFeedback?: DocumentFeedbackPayload;
  notepadFeedback?: readonly NotepadFeedbackPayload[];
}): MessageContentBlock[] {
  const feedback =
    input.documentFeedback !== undefined || input.notepadFeedback !== undefined;
  return [
    ...buildQueueContent({
      ...(feedback ? {} : { text: input.text }),
      ...(input.images !== undefined ? { images: input.images } : {}),
      ...(input.documentFeedback !== undefined
        ? { documentFeedback: input.documentFeedback }
        : {}),
    }),
    ...(input.notepadFeedback ?? []).flatMap((notepadFeedback) =>
      buildQueueContent({ notepadFeedback }),
    ),
  ];
}
