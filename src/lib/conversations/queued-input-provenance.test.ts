import { describe, expect, it } from "vitest";
import { isQueuedUserMessage } from "./queued-input-provenance";

describe("queued input provenance", () => {
  it("recognizes ordinary user text and image messages", () => {
    expect(
      isQueuedUserMessage({
        inputOrigin: "user",
        metadata: null,
        content: [{ type: "text", text: "Continue" }],
      }),
    ).toBe(true);
    expect(
      isQueuedUserMessage({
        inputOrigin: "user",
        metadata: null,
        content: [
          { type: "image", mediaType: "image/png", base64Data: "image" },
        ],
      }),
    ).toBe(true);
  });

  it("does not infer user provenance from plain generated text", () => {
    expect(
      isQueuedUserMessage({
        metadata: null,
        content: [{ type: "text", text: "Generated alignment feedback" }],
      }),
    ).toBe(false);
  });

  it("excludes generated question-answer protocol messages", () => {
    expect(
      isQueuedUserMessage({
        inputOrigin: "user",
        metadata: { kind: "question_answers", questionBatchId: "q" },
        content: [
          {
            type: "text",
            text: "<cc-question-answers>Answer</cc-question-answers>",
          },
        ],
      }),
    ).toBe(false);
  });

  it("excludes generated review feedback even if accompanied by text", () => {
    expect(
      isQueuedUserMessage({
        inputOrigin: "user",
        metadata: null,
        content: [
          { type: "text", text: "Generated instructions" },
          { type: "document_feedback", items: [] },
        ],
      }),
    ).toBe(false);
    expect(
      isQueuedUserMessage({
        inputOrigin: "user",
        metadata: null,
        content: [
          {
            type: "notepad_feedback",
            notepadId: "n",
            notepadName: "Notes",
            notepadRefXml: "<notepad-ref />",
            items: [],
          },
        ],
      }),
    ).toBe(false);
  });
});
