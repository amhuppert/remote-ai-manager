import { describe, it, expect } from "vitest";

import type { MessageContentBlock } from "@/lib/conversations/schemas";
import {
  MESSAGE_COMPACTION_TEXT_BYTES_THRESHOLD,
  shouldOfferMessageCompaction,
} from "./message-gating";

function text(t: string): MessageContentBlock {
  return { type: "text", text: t };
}

function toolUse(name = "Bash"): MessageContentBlock {
  return { type: "tool_use", name };
}

const OVER = "a".repeat(MESSAGE_COMPACTION_TEXT_BYTES_THRESHOLD + 1);
const EXACT = "a".repeat(MESSAGE_COMPACTION_TEXT_BYTES_THRESHOLD);

describe("shouldOfferMessageCompaction", () => {
  const cases: Array<{
    name: string;
    role: "user" | "assistant" | "notice" | undefined;
    content: MessageContentBlock[];
    expected: boolean;
  }> = [
    {
      name: "assistant with one tool_use block",
      role: "assistant",
      content: [text("ran a command"), toolUse()],
      expected: true,
    },
    {
      name: "assistant with text over the byte threshold",
      role: "assistant",
      content: [text(OVER)],
      expected: true,
    },
    {
      name: "assistant with text exactly at the threshold (strictly greater required)",
      role: "assistant",
      content: [text(EXACT)],
      expected: false,
    },
    {
      name: "assistant with short text and no tools",
      role: "assistant",
      content: [text("short answer")],
      expected: false,
    },
    {
      name: "assistant with empty content",
      role: "assistant",
      content: [],
      expected: false,
    },
    {
      name: "text size sums across multiple text blocks",
      role: "assistant",
      content: [text(EXACT), text("b")],
      expected: true,
    },
    {
      name: "multi-byte characters count as UTF-8 bytes, not chars",
      role: "assistant",
      // 1025 two-byte chars = 2050 bytes > 2048 while only 1025 chars long
      content: [text("é".repeat(1025))],
      expected: true,
    },
    {
      name: "thinking blocks do not count toward the text size",
      role: "assistant",
      content: [{ type: "thinking", text: OVER }],
      expected: false,
    },
    {
      name: "tool_result blocks do not count toward the text size",
      role: "assistant",
      content: [{ type: "tool_result", tool_use_id: "t1", content: OVER }],
      expected: false,
    },
    {
      name: "user message with a tool_use block",
      role: "user",
      content: [toolUse()],
      expected: false,
    },
    {
      name: "user message with huge text",
      role: "user",
      content: [text(OVER)],
      expected: false,
    },
    {
      name: "notice message",
      role: "notice",
      content: [text(OVER), toolUse()],
      expected: false,
    },
    {
      name: "undefined role (host did not thread it)",
      role: undefined,
      content: [text(OVER), toolUse()],
      expected: false,
    },
  ];

  it.each(cases)("$name -> $expected", ({ role, content, expected }) => {
    expect(shouldOfferMessageCompaction(role, content)).toBe(expected);
  });

  it("exports the threshold constant at 2048 bytes", () => {
    expect(MESSAGE_COMPACTION_TEXT_BYTES_THRESHOLD).toBe(2048);
  });
});
