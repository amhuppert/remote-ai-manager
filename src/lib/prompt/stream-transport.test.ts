import { describe, expect, it, vi } from "vitest";

import {
  consumePromptStream,
  type PromptStreamEvent,
} from "@/lib/prompt/stream-transport";

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect(
  body: ReadableStream<Uint8Array> | null,
): Promise<PromptStreamEvent[]> {
  const events: PromptStreamEvent[] = [];
  await consumePromptStream(body, (event) => events.push(event));
  return events;
}

describe("consumePromptStream", () => {
  it("surfaces the full prompt-stream vocabulary: content, ask-question, error, aborted, done", async () => {
    const question = {
      id: "q1",
      question: "Which?",
      options: [{ label: "A", recommended: false }],
      multiSelect: false,
      required: true,
      allowNote: true,
    };
    const events = await collect(
      streamOf(
        sseFrame("content", { type: "text", text: "hello" }),
        sseFrame("ask-question", { questionId: "qid", questions: [question] }),
        sseFrame("error", { message: "boom", code: "BACKEND_MISMATCH" }),
        sseFrame("done", {}),
      ),
    );

    expect(events).toEqual([
      { type: "content", block: { type: "text", text: "hello" } },
      {
        type: "ask-question",
        questionId: "qid",
        questions: [question],
      },
      { type: "error", message: "boom", code: "BACKEND_MISMATCH" },
      { type: "done" },
    ]);
  });

  it("surfaces aborted and stops consuming afterwards", async () => {
    const events = await collect(
      streamOf(
        sseFrame("aborted", {}),
        sseFrame("content", { type: "text", text: "late" }),
      ),
    );
    expect(events).toEqual([{ type: "aborted" }]);
  });

  it("stops consuming after done even when more frames follow in the same chunk", async () => {
    const events = await collect(
      streamOf(sseFrame("done", {}) + sseFrame("error", { message: "late" })),
    );
    expect(events).toEqual([{ type: "done" }]);
  });

  it("reassembles frames split across chunk boundaries", async () => {
    const frame = sseFrame("content", { type: "text", text: "split" });
    const events = await collect(
      streamOf(frame.slice(0, 20), frame.slice(20), sseFrame("done", {})),
    );
    expect(events).toEqual([
      { type: "content", block: { type: "text", text: "split" } },
      { type: "done" },
    ]);
  });

  it("skips malformed content and ask-question payloads but keeps the stream alive", async () => {
    const events = await collect(
      streamOf(
        "event: content\ndata: {not json\n\n",
        sseFrame("content", { type: "unknown-block-kind" }),
        "event: ask-question\ndata: 42\n\n",
        sseFrame("content", { type: "text", text: "ok" }),
        sseFrame("done", {}),
      ),
    );
    expect(events).toEqual([
      { type: "content", block: { type: "text", text: "ok" } },
      { type: "done" },
    ]);
  });

  it("still surfaces an error event when the error payload is malformed", async () => {
    const events = await collect(
      streamOf("event: error\ndata: {not json\n\n", sseFrame("done", {})),
    );
    expect(events).toEqual([{ type: "error" }, { type: "done" }]);
  });

  it("ignores event names outside the vocabulary", async () => {
    const events = await collect(
      streamOf(
        sseFrame("collab-started", { conversationIds: [] }),
        sseFrame("done", {}),
      ),
    );
    expect(events).toEqual([{ type: "done" }]);
  });

  it("resolves without events for a null body", async () => {
    const onEvent = vi.fn();
    await consumePromptStream(null, onEvent);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("propagates reader failures to the caller", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("gone", "AbortError"));
      },
    });
    await expect(consumePromptStream(body, () => {})).rejects.toThrow("gone");
  });
});
