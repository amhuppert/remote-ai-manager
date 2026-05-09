import { describe, it, expect } from "vitest";
import type { MessageContentBlock } from "@/types";
import { extractCopyText } from "./copy-message-text";

describe("extractCopyText", () => {
  it("returns the text from a single text block", () => {
    const blocks: MessageContentBlock[] = [{ type: "text", text: "hello" }];
    expect(extractCopyText(blocks)).toBe("hello");
  });

  it("joins multiple text blocks with a blank line", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ];
    expect(extractCopyText(blocks)).toBe("first\n\nsecond");
  });

  it("ignores tool_use and tool_result blocks", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "before" },
      { type: "tool_use", name: "Read", input: { file: "x" } },
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      { type: "text", text: "after" },
    ];
    expect(extractCopyText(blocks)).toBe("before\n\nafter");
  });

  it("ignores image and image_ref blocks", () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "look" },
      { type: "image", mediaType: "image/png", base64Data: "abc" },
      { type: "image_ref", mediaType: "image/png", imagePath: "/x.png" },
    ];
    expect(extractCopyText(blocks)).toBe("look");
  });

  it("formats command blocks as slash commands with args", () => {
    const blocks: MessageContentBlock[] = [
      { type: "command", name: "/kiro:spec-status", args: "auth-flow" },
    ];
    expect(extractCopyText(blocks)).toBe("/kiro:spec-status auth-flow");
  });

  it("formats command blocks without args as just the slash name", () => {
    const blocks: MessageContentBlock[] = [
      { type: "command", name: "/compact", args: null },
    ];
    expect(extractCopyText(blocks)).toBe("/compact");
  });

  it("preserves multi-line args verbatim", () => {
    const blocks: MessageContentBlock[] = [
      {
        type: "command",
        name: "/collab",
        args: "I want to change a couple of things.\n\n**Change 1:** do X.\n**Change 2:** do Y.",
      },
    ];
    expect(extractCopyText(blocks)).toBe(
      "/collab I want to change a couple of things.\n\n**Change 1:** do X.\n**Change 2:** do Y.",
    );
  });

  it("returns an empty string when no copyable blocks are present", () => {
    const blocks: MessageContentBlock[] = [
      { type: "tool_use", name: "Read", input: {} },
    ];
    expect(extractCopyText(blocks)).toBe("");
  });
});
