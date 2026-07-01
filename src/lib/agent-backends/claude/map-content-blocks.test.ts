import { describe, it, expect } from "vitest";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { mapAssistantContentBlocks } from "./map-content-blocks";

type SdkContent = SDKAssistantMessage["message"]["content"];

// The SDK content array is typed as Anthropic's block union; tests construct
// minimal literals and cast to that shape (mirrors query-session.test.ts).
function content(blocks: unknown[]): SdkContent {
  return blocks as SdkContent;
}

describe("mapAssistantContentBlocks", () => {
  it("maps a text block", () => {
    expect(
      mapAssistantContentBlocks(content([{ type: "text", text: "Hello!" }])),
    ).toEqual([{ type: "text", text: "Hello!" }]);
  });

  it("maps a tool_use block, preserving id, name, and input", () => {
    expect(
      mapAssistantContentBlocks(
        content([
          {
            type: "tool_use",
            id: "toolu_1",
            name: "ReadFile",
            input: { path: "/foo" },
          },
        ]),
      ),
    ).toEqual([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "ReadFile",
        input: { path: "/foo" },
      },
    ]);
  });

  it("maps a thinking block into a thinking content block carrying the summary", () => {
    expect(
      mapAssistantContentBlocks(
        content([
          {
            type: "thinking",
            thinking: "Two candidates: a regression, or a stale selector.",
            signature: "sig-abc",
          },
        ]),
      ),
    ).toEqual([
      {
        type: "thinking",
        text: "Two candidates: a regression, or a stale selector.",
      },
    ]);
  });

  it("maps redacted_thinking into an empty, redacted thinking block", () => {
    expect(
      mapAssistantContentBlocks(
        content([{ type: "redacted_thinking", data: "encrypted-blob" }]),
      ),
    ).toEqual([{ type: "thinking", text: "", redacted: true }]);
  });

  it("preserves order across a mixed reasoning-then-answer message", () => {
    const result = mapAssistantContentBlocks(
      content([
        {
          type: "thinking",
          thinking: "Let me check the selector.",
          signature: "s",
        },
        { type: "redacted_thinking", data: "blob" },
        { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } },
        { type: "text", text: "Done." },
      ]),
    );

    expect(result).toEqual([
      { type: "thinking", text: "Let me check the selector." },
      { type: "thinking", text: "", redacted: true },
      { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x" } },
      { type: "text", text: "Done." },
    ]);
  });

  it("skips block types it does not recognize", () => {
    const result = mapAssistantContentBlocks(
      content([
        { type: "some_future_block", payload: { a: 1 } },
        { type: "text", text: "kept" },
      ]),
    );

    expect(result).toEqual([{ type: "text", text: "kept" }]);
  });
});
