import { describe, it, expect } from "vitest";
import {
  classifyScrollPosition,
  computeCurrentMessageIndex,
  estimateVirtualRowSize,
  findTopmostVisibleItem,
  getNextMessageIndex,
  getPrevMessageIndex,
} from "./conversation-nav";
import type { TranscriptMessage } from "@/types";

describe("classifyScrollPosition", () => {
  it("returns 'top' when scrolled to absolute top", () => {
    expect(
      classifyScrollPosition({
        scrollTop: 0,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe("top");
  });

  it("returns 'top' when within the edge tolerance of top", () => {
    expect(
      classifyScrollPosition({
        scrollTop: 3,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe("top");
  });

  it("returns 'bottom' when scrolled to absolute bottom", () => {
    expect(
      classifyScrollPosition({
        scrollTop: 600,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe("bottom");
  });

  it("returns 'bottom' when within the edge tolerance of bottom", () => {
    expect(
      classifyScrollPosition({
        scrollTop: 597,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe("bottom");
  });

  it("returns 'middle' when between top and bottom", () => {
    expect(
      classifyScrollPosition({
        scrollTop: 200,
        scrollHeight: 1000,
        clientHeight: 400,
      }),
    ).toBe("middle");
  });

  it("returns 'middle' when content fits the viewport (no scrolling possible)", () => {
    expect(
      classifyScrollPosition({
        scrollTop: 0,
        scrollHeight: 300,
        clientHeight: 400,
      }),
    ).toBe("middle");
  });
});

describe("findTopmostVisibleItem", () => {
  const items = [
    { index: 0, start: 0, size: 100 },
    { index: 1, start: 124, size: 80 },
    { index: 2, start: 228, size: 200 },
    { index: 3, start: 452, size: 50 },
  ];

  it("returns first item when scrolled to top", () => {
    expect(findTopmostVisibleItem(items, 0)?.index).toBe(0);
  });

  it("returns the item that is partially scrolled but still visible at top", () => {
    expect(findTopmostVisibleItem(items, 50)?.index).toBe(0);
  });

  it("advances to next item once previous one has fully scrolled out of view", () => {
    expect(findTopmostVisibleItem(items, 110)?.index).toBe(1);
  });

  it("returns the item containing the scroll position when inside one", () => {
    expect(findTopmostVisibleItem(items, 300)?.index).toBe(2);
  });

  it("returns the last item when scrolled past everything", () => {
    expect(findTopmostVisibleItem(items, 600)?.index).toBe(3);
  });

  it("returns undefined for an empty list", () => {
    expect(findTopmostVisibleItem([], 0)).toBeUndefined();
  });
});

describe("computeCurrentMessageIndex", () => {
  it("returns the last message whenever scroll is at bottom — even when topmost-visible would resolve to an earlier message", () => {
    expect(
      computeCurrentMessageIndex({
        topmostMessageIndex: 5,
        edgePosition: "bottom",
        totalMessages: 12,
      }),
    ).toBe(11);
  });

  it("returns the first message whenever scroll is at top — even when topmost-visible would resolve to a later message", () => {
    expect(
      computeCurrentMessageIndex({
        topmostMessageIndex: 5,
        edgePosition: "top",
        totalMessages: 12,
      }),
    ).toBe(0);
  });

  it("returns the topmost visible message when scrolled in the middle", () => {
    expect(
      computeCurrentMessageIndex({
        topmostMessageIndex: 7,
        edgePosition: "middle",
        totalMessages: 12,
      }),
    ).toBe(7);
  });

  it("returns 0 when there are no messages", () => {
    expect(
      computeCurrentMessageIndex({
        topmostMessageIndex: 0,
        edgePosition: "middle",
        totalMessages: 0,
      }),
    ).toBe(0);
  });

  it("clamps topmost message index to last message when out of bounds", () => {
    expect(
      computeCurrentMessageIndex({
        topmostMessageIndex: 99,
        edgePosition: "middle",
        totalMessages: 12,
      }),
    ).toBe(11);
  });

  it("clamps negative topmost message index to 0", () => {
    expect(
      computeCurrentMessageIndex({
        topmostMessageIndex: -1,
        edgePosition: "middle",
        totalMessages: 12,
      }),
    ).toBe(0);
  });
});

describe("getNextMessageIndex / getPrevMessageIndex", () => {
  it("getNextMessageIndex returns currentIndex + 1 in the middle of the list", () => {
    expect(getNextMessageIndex({ currentIndex: 3, totalMessages: 10 })).toBe(4);
  });

  it("getNextMessageIndex returns null at the last message", () => {
    expect(
      getNextMessageIndex({ currentIndex: 9, totalMessages: 10 }),
    ).toBeNull();
  });

  it("getNextMessageIndex returns null when there are no messages", () => {
    expect(
      getNextMessageIndex({ currentIndex: 0, totalMessages: 0 }),
    ).toBeNull();
  });

  it("getPrevMessageIndex returns currentIndex - 1 in the middle of the list", () => {
    expect(getPrevMessageIndex({ currentIndex: 3 })).toBe(2);
  });

  it("getPrevMessageIndex returns null at the first message", () => {
    expect(getPrevMessageIndex({ currentIndex: 0 })).toBeNull();
  });
});

describe("estimateVirtualRowSize", () => {
  function msg(
    role: "user" | "assistant",
    content: TranscriptMessage["content"],
  ): TranscriptMessage {
    return { role, content, timestamp: null };
  }

  it("returns the collab-row constant for kind 'collab'", () => {
    expect(estimateVirtualRowSize({ kind: "collab" })).toBe(220);
  });

  it("clamps a tiny user message to the floor", () => {
    expect(
      estimateVirtualRowSize({
        kind: "message",
        message: msg("user", [{ type: "text", text: "hi" }]),
      }),
    ).toBe(96);
  });

  it("clamps a huge text block to the ceiling", () => {
    const huge = "x".repeat(10_000) + "\n".repeat(200);
    expect(
      estimateVirtualRowSize({
        kind: "message",
        message: msg("assistant", [{ type: "text", text: huge }]),
      }),
    ).toBe(800);
  });

  it("grows with newline count and character count for text blocks", () => {
    const small = estimateVirtualRowSize({
      kind: "message",
      message: msg("assistant", [{ type: "text", text: "one line" }]),
    });
    const big = estimateVirtualRowSize({
      kind: "message",
      message: msg("assistant", [
        {
          type: "text",
          text: "line\nline\nline\nline\nline\nline\nline\nline",
        },
      ]),
    });
    expect(big).toBeGreaterThan(small);
  });

  it("adds height for tool_use blocks", () => {
    const base = estimateVirtualRowSize({
      kind: "message",
      message: msg("assistant", [{ type: "text", text: "hi" }]),
    });
    const withTool = estimateVirtualRowSize({
      kind: "message",
      message: msg("assistant", [
        { type: "text", text: "hi" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
      ]),
    });
    expect(withTool).toBeGreaterThan(base);
  });

  it("adds height for tool_result blocks based on content length", () => {
    const short = estimateVirtualRowSize({
      kind: "message",
      message: msg("user", [
        { type: "tool_result", tool_use_id: "t", content: "ok" },
      ]),
    });
    const long = estimateVirtualRowSize({
      kind: "message",
      message: msg("user", [
        {
          type: "tool_result",
          tool_use_id: "t",
          content: "x\n".repeat(50),
        },
      ]),
    });
    expect(long).toBeGreaterThan(short);
  });

  it("adds height for image blocks", () => {
    const base = estimateVirtualRowSize({
      kind: "message",
      message: msg("user", [{ type: "text", text: "see attached" }]),
    });
    const withImage = estimateVirtualRowSize({
      kind: "message",
      message: msg("user", [
        { type: "text", text: "see attached" },
        { type: "image", mediaType: "image/png", base64Data: "..." },
      ]),
    });
    expect(withImage).toBeGreaterThan(base);
  });

  it("falls back to a role-based estimate when content is empty", () => {
    const userEmpty = estimateVirtualRowSize({
      kind: "message",
      message: msg("user", []),
    });
    const assistantEmpty = estimateVirtualRowSize({
      kind: "message",
      message: msg("assistant", []),
    });
    expect(userEmpty).toBeGreaterThanOrEqual(96);
    expect(assistantEmpty).toBeGreaterThanOrEqual(96);
  });
});
