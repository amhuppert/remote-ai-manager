import { describe, expect, it } from "vitest";
import { buildQueueContent, queueContentOfTurnInput } from "./queue-content";
import { queuedBatchToSubmitPrompt } from "./message-queue-drain";
import type { ImagePayload } from "@/lib/images/schemas";

function makeImage(overrides: Partial<ImagePayload> = {}): ImagePayload {
  return {
    attachmentId: "att-1",
    mediaType: "image/png",
    base64Data: "AAAA",
    ...overrides,
  };
}

describe("buildQueueContent", () => {
  it("builds a single text block from text only", () => {
    expect(buildQueueContent({ text: "hello world" })).toEqual([
      { type: "text", text: "hello world" },
    ]);
  });

  it("builds image blocks from images only (no text block)", () => {
    const images: ImagePayload[] = [
      makeImage({
        attachmentId: "a",
        mediaType: "image/png",
        base64Data: "X1",
      }),
      makeImage({
        attachmentId: "b",
        mediaType: "image/jpeg",
        base64Data: "X2",
      }),
    ];
    expect(buildQueueContent({ images })).toEqual([
      { type: "image", mediaType: "image/png", base64Data: "X1" },
      { type: "image", mediaType: "image/jpeg", base64Data: "X2" },
    ]);
  });

  it("builds text block(s) before image blocks for text+images", () => {
    const images: ImagePayload[] = [
      makeImage({
        attachmentId: "a",
        mediaType: "image/gif",
        base64Data: "G1",
      }),
    ];
    expect(buildQueueContent({ text: "caption", images })).toEqual([
      { type: "text", text: "caption" },
      { type: "image", mediaType: "image/gif", base64Data: "G1" },
    ]);
  });

  it("omits an empty text block", () => {
    expect(buildQueueContent({ text: "" })).toEqual([]);
    expect(buildQueueContent({})).toEqual([]);
  });

  it("appends a document_feedback block after text/image blocks", () => {
    const documentFeedback = {
      items: [
        {
          docPath: "design.md",
          path: "design.md",
          headingLabel: "Intro",
          line: 4,
          quote: "the passage",
          note: "reconsider",
        },
      ],
    };
    expect(buildQueueContent({ documentFeedback })).toEqual([
      { type: "document_feedback", items: documentFeedback.items },
    ]);
  });
});

describe("queueContentOfTurnInput", () => {
  it("keeps turn input that never ran as content the drain reads back to the same input", () => {
    const image = {
      attachmentId: "img-1",
      mediaType: "image/png" as const,
      base64Data: "aGk=",
    };
    expect(
      queuedBatchToSubmitPrompt(
        queueContentOfTurnInput({ text: "Look at this", images: [image] }),
      ),
    ).toEqual({
      promptText: "Look at this",
      images: [{ ...image, attachmentId: "queued-0" }],
    });

    const documentFeedback = {
      items: [
        {
          docPath: "docs/plan.md",
          path: "docs/plan.md",
          headingLabel: "Rollout",
          line: 12,
          quote: "Ship it",
          note: "Too early",
        },
      ],
    };
    const notepadFeedback = [
      {
        notepadId: "n-1",
        notepadName: "Plan",
        notepadRefXml: "<notepad/>",
        items: [],
      },
    ];
    expect(
      queuedBatchToSubmitPrompt(
        queueContentOfTurnInput({
          text: "Feedback prose the turn derives again",
          documentFeedback,
          notepadFeedback,
        }),
      ),
    ).toEqual({
      promptText: "",
      images: [],
      documentFeedback,
      notepadFeedback,
    });
  });
});

// ===========================================================================
// queueMessage — next_turn (durable enqueue, no live delivery)
// ===========================================================================
