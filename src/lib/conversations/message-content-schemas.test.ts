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
