import { describe, it, expect } from "vitest";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import {
  resolveTurnPromptText,
  composeUserTranscriptBlocks,
} from "./document-feedback";

const feedback: DocumentFeedbackPayload = {
  items: [
    {
      docPath: "docs/plan.md",
      path: "docs/plan.md",
      headingLabel: "Overview",
      line: 12,
      quote: "the quoted passage",
      note: "please fix this",
    },
  ],
};

describe("resolveTurnPromptText", () => {
  it("leaves a non-feedback turn unchanged", () => {
    expect(
      resolveTurnPromptText({
        promptText: "hello",
        documentFeedback: undefined,
        isQueuedDelivery: false,
      }),
    ).toEqual({ effectivePromptText: "hello", isDrainedFeedbackBatch: false });
  });

  it("derives the feedback prose when immediate feedback carries no explicit text", () => {
    const result = resolveTurnPromptText({
      promptText: "",
      documentFeedback: feedback,
      isQueuedDelivery: false,
    });
    expect(result.isDrainedFeedbackBatch).toBe(false);
    expect(result.effectivePromptText).toContain("Document feedback:");
    expect(result.effectivePromptText).toContain("please fix this");
  });

  it("keeps the caller-supplied prose for immediate feedback with explicit text", () => {
    const result = resolveTurnPromptText({
      promptText: "already formatted prose",
      documentFeedback: feedback,
      isQueuedDelivery: false,
    });
    expect(result.effectivePromptText).toBe("already formatted prose");
    expect(result.isDrainedFeedbackBatch).toBe(false);
  });

  it("appends derived prose to the user's own text for a drained mixed batch", () => {
    const result = resolveTurnPromptText({
      promptText: "my own message",
      documentFeedback: feedback,
      isQueuedDelivery: true,
    });
    expect(result.isDrainedFeedbackBatch).toBe(true);
    expect(result.effectivePromptText).toMatch(
      /^my own message\n\nDocument feedback:/,
    );
  });

  it("uses derived prose alone for a drained feedback-only batch", () => {
    const result = resolveTurnPromptText({
      promptText: "  ",
      documentFeedback: feedback,
      isQueuedDelivery: true,
    });
    expect(result.isDrainedFeedbackBatch).toBe(true);
    expect(result.effectivePromptText).toMatch(/^Document feedback:/);
  });
});

describe("composeUserTranscriptBlocks", () => {
  const noImages: ConversationImageRef[] = [];

  it("records the feedback card alone (no prose) for an immediate feedback turn", () => {
    const blocks = composeUserTranscriptBlocks({
      promptText: "",
      effectivePromptText: "Document feedback:\n\n...",
      rewrittenPromptText: "Document feedback:\n\n...",
      isDrainedFeedbackBatch: false,
      documentFeedback: feedback,
      imageRefs: noImages,
    });
    expect(blocks).toEqual([
      { type: "document_feedback", items: feedback.items },
    ]);
  });

  it("preserves the user's own text before the card for a drained mixed batch", () => {
    const blocks = composeUserTranscriptBlocks({
      promptText: "my own message",
      effectivePromptText: "my own message\n\nDocument feedback: ...",
      rewrittenPromptText: "my own message\n\nDocument feedback: ...",
      isDrainedFeedbackBatch: true,
      documentFeedback: feedback,
      imageRefs: noImages,
    });
    expect(blocks).toEqual([
      { type: "text", text: "my own message" },
      { type: "document_feedback", items: feedback.items },
    ]);
  });

  it("records a single text block for a plain text turn", () => {
    const blocks = composeUserTranscriptBlocks({
      promptText: "hello",
      effectivePromptText: "hello",
      rewrittenPromptText: "hello",
      isDrainedFeedbackBatch: false,
      documentFeedback: undefined,
      imageRefs: noImages,
    });
    expect(blocks).toEqual([{ type: "text", text: "hello" }]);
  });

  it("records nothing for an empty non-feedback turn", () => {
    expect(
      composeUserTranscriptBlocks({
        promptText: "",
        effectivePromptText: "",
        rewrittenPromptText: "",
        isDrainedFeedbackBatch: false,
        documentFeedback: undefined,
        imageRefs: noImages,
      }),
    ).toEqual([]);
  });

  it("interleaves image markers from the rewritten prompt for an image turn", () => {
    const imageRefs: ConversationImageRef[] = [
      {
        index: 1,
        mediaType: "image/png",
        path: "/persisted/1.png",
        base64Data: "AAA",
      },
    ];
    const blocks = composeUserTranscriptBlocks({
      promptText: "look [Image #1] here",
      effectivePromptText: "look [Image #1] here",
      rewrittenPromptText: "look [Image #1] here",
      isDrainedFeedbackBatch: false,
      documentFeedback: undefined,
      imageRefs,
    });
    expect(blocks).toEqual([
      { type: "text", text: "look " },
      {
        type: "image_marker",
        index: 1,
        mediaType: "image/png",
        imagePath: "/persisted/1.png",
      },
      {
        type: "image_ref",
        mediaType: "image/png",
        imagePath: "/persisted/1.png",
      },
      { type: "text", text: " here" },
    ]);
  });
});
