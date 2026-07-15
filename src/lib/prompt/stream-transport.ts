import { z } from "zod";
import {
  askQuestionItemSchema,
  messageContentBlockSchema,
  type AskQuestionItem,
  type MessageContentBlock,
} from "@/lib/conversations/schemas";

/**
 * Client transport for the per-request prompt SSE stream (`POST …/prompt`
 * responses). Owns the wire format (`event: <name>\ndata: <json>\n\n` frames)
 * and the event vocabulary, so every consumer sees one typed event union
 * instead of hand-parsing frames.
 *
 * Vocabulary (server emitters: prompt route handlers + conversation-manager
 * `streamEmit`): `content` (one streamed content block), `ask-question`
 * (AskUserQuestion payload), `error` (turn failure envelope), `aborted`
 * (turn cancelled), `done` (terminal — always emitted last). Event names
 * outside the vocabulary (e.g. `collab-started`) are ignored.
 */
export type PromptStreamEvent =
  | { type: "content"; block: MessageContentBlock }
  | { type: "ask-question"; questionId: string; questions: AskQuestionItem[] }
  | { type: "error"; message?: string; code?: string }
  | { type: "aborted" }
  | { type: "done" };

const askQuestionPayloadSchema = z.object({
  questionId: z.string(),
  questions: z.array(askQuestionItemSchema),
});

const errorPayloadSchema = z.object({
  message: z.string().optional(),
  code: z.string().optional(),
});

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Decode one SSE frame into a stream event. Returns `null` for frames outside
 * the vocabulary and for malformed `content`/`ask-question` payloads (the
 * stream stays alive; a dropped block is reconciled by the settle refetch). A
 * malformed `error` payload still yields an `error` event so failures are
 * never swallowed — consumers supply their own fallback message.
 */
function decodeFrame(frame: string): PromptStreamEvent | null {
  let eventName = "";
  let dataRaw = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event: ")) {
      eventName = line.slice(7);
    } else if (line.startsWith("data: ")) {
      dataRaw = line.slice(6);
    }
  }

  switch (eventName) {
    case "content": {
      const block = messageContentBlockSchema.safeParse(parseJson(dataRaw));
      return block.success ? { type: "content", block: block.data } : null;
    }
    case "ask-question": {
      const payload = askQuestionPayloadSchema.safeParse(parseJson(dataRaw));
      return payload.success
        ? {
            type: "ask-question",
            questionId: payload.data.questionId,
            questions: payload.data.questions,
          }
        : null;
    }
    case "error": {
      const payload = errorPayloadSchema.safeParse(parseJson(dataRaw));
      if (!payload.success) return { type: "error" };
      return {
        type: "error",
        ...(payload.data.message !== undefined
          ? { message: payload.data.message }
          : {}),
        ...(payload.data.code !== undefined ? { code: payload.data.code } : {}),
      };
    }
    case "aborted":
      return { type: "aborted" };
    case "done":
      return { type: "done" };
    default:
      return null;
  }
}

/**
 * Read a prompt SSE response body to completion, surfacing each decoded event.
 * Returns once the stream ends or a terminal event (`done`/`aborted`) is
 * decoded. Read failures (including aborts) propagate to the caller.
 */
export async function consumePromptStream(
  body: ReadableStream<Uint8Array> | null | undefined,
  onEvent: (event: PromptStreamEvent) => void,
): Promise<void> {
  const reader = body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      if (!frame.trim()) continue;
      const event = decodeFrame(frame);
      if (event === null) continue;
      onEvent(event);
      if (event.type === "done" || event.type === "aborted") return;
    }
  }
}
