import { describe, expect, it } from "vitest";
import {
  documentFeedbackItemSchema,
  documentFeedbackPayloadSchema,
  messageContentBlockSchema,
} from "./message-content-schemas";

describe("documentFeedbackItemSchema", () => {
  const item = {
    docPath: ".kiro/specs/x/design.md",
    path: ".kiro/specs/x/design.md",
    headingLabel: "Prompt pipeline extension",
    line: 12,
    quote: "the exact quoted passage",
    note: "please reconsider this",
  };

  it("parses a maximal item", () => {
    expect(documentFeedbackItemSchema.parse(item)).toEqual(item);
  });

  it("rejects a non-positive line", () => {
    expect(
      documentFeedbackItemSchema.safeParse({ ...item, line: 0 }).success,
    ).toBe(false);
  });

  it("parses a payload of items", () => {
    expect(documentFeedbackPayloadSchema.parse({ items: [item] })).toEqual({
      items: [item],
    });
  });
});

describe("messageContentBlockSchema thinking variant", () => {
  it("parses a thinking block carrying summary text", () => {
    const block = { type: "thinking", text: "Considering two candidates." };
    expect(messageContentBlockSchema.parse(block)).toEqual(block);
  });

  it("parses a redacted thinking block with empty text", () => {
    const block = { type: "thinking", text: "", redacted: true };
    expect(messageContentBlockSchema.parse(block)).toEqual(block);
  });

  it("rejects a thinking block without text", () => {
    expect(
      messageContentBlockSchema.safeParse({ type: "thinking" }).success,
    ).toBe(false);
  });
});

describe("messageContentBlockSchema document_feedback variant", () => {
  const item = {
    docPath: "README.md",
    path: "README.md",
    headingLabel: "Intro",
    line: 3,
    quote: "hello",
    note: "fix this",
  };

  it("parses a document_feedback block carrying items", () => {
    const block = { type: "document_feedback", items: [item] };
    expect(messageContentBlockSchema.parse(block)).toEqual(block);
  });

  it("rejects a document_feedback block whose items are malformed", () => {
    const block = { type: "document_feedback", items: [{ ...item, line: -1 }] };
    expect(messageContentBlockSchema.safeParse(block).success).toBe(false);
  });
});

describe("messageContentBlockSchema notepad_feedback variant", () => {
  const block = {
    type: "notepad_feedback",
    notepadId: "np-1",
    notepadName: "Release plan",
    notepadRefXml: '<notepad-ref notepad-id="np-1" name="Release plan" />',
    items: [
      {
        commentId: "c-1",
        location: "§ Rollout · L12",
        quote: "ship on Friday",
        body: "deploys are frozen on Friday",
      },
    ],
  };

  it("parses a notepad_feedback block carrying notepad and comment identity", () => {
    expect(messageContentBlockSchema.parse(block)).toEqual(block);
  });

  it("rejects a notepad_feedback block missing the notepad id", () => {
    const { notepadId: _dropped, ...withoutId } = block;
    expect(messageContentBlockSchema.safeParse(withoutId).success).toBe(false);
  });

  it("rejects a notepad_feedback item missing its comment id", () => {
    const malformed = {
      ...block,
      items: [{ location: "L1", quote: "q", body: "b" }],
    };
    expect(messageContentBlockSchema.safeParse(malformed).success).toBe(false);
  });
});
