import { describe, it, expect } from "vitest";
import type { ConversationImageRef, MessageContentBlock } from "@/types";
import { buildClaudePromptBlocks } from "./build-prompt-blocks";

function ref(
  index: number,
  options: { mediaType?: string; path?: string; base64Data?: string } = {},
): ConversationImageRef {
  return {
    index,
    mediaType: options.mediaType ?? "image/png",
    path: options.path ?? `/img/${index}.png`,
    base64Data: options.base64Data ?? `DATA-${index}`,
  };
}

describe("buildClaudePromptBlocks", () => {
  it("returns a single text block when prompt is plain text and no images", () => {
    const blocks = buildClaudePromptBlocks({
      promptText: "hello world",
      imageRefs: [],
    });

    expect(blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "hello world" },
    ]);
  });

  it("interleaves a single inline image at its marker position with source-text annotation", () => {
    const blocks = buildClaudePromptBlocks({
      promptText: "before [Image #5] after",
      imageRefs: [ref(5, { path: "/p/5.png" })],
    });

    expect(blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "before " },
      { type: "text", text: "[Image #5 source: /p/5.png]" },
      { type: "image", mediaType: "image/png", base64Data: "DATA-5" },
      { type: "text", text: " after" },
    ]);
  });

  it("appends strip-only image refs at the end with source-text annotations", () => {
    const blocks = buildClaudePromptBlocks({
      promptText: "look at these",
      imageRefs: [
        ref(1, { path: "/p/1.png", mediaType: "image/jpeg" }),
        ref(2, { path: "/p/2.png" }),
      ],
    });

    expect(blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "look at these" },
      { type: "text", text: "[Image #1 source: /p/1.png]" },
      { type: "image", mediaType: "image/jpeg", base64Data: "DATA-1" },
      { type: "text", text: "[Image #2 source: /p/2.png]" },
      { type: "image", mediaType: "image/png", base64Data: "DATA-2" },
    ]);
  });

  it("places inline refs at marker positions and appends strips at the end", () => {
    const blocks = buildClaudePromptBlocks({
      promptText: "see [Image #3] please",
      imageRefs: [
        ref(3, { path: "/p/3.png" }),
        ref(4, { path: "/p/4.png", mediaType: "image/webp" }),
      ],
    });

    expect(blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "see " },
      { type: "text", text: "[Image #3 source: /p/3.png]" },
      { type: "image", mediaType: "image/png", base64Data: "DATA-3" },
      { type: "text", text: " please" },
      { type: "text", text: "[Image #4 source: /p/4.png]" },
      { type: "image", mediaType: "image/webp", base64Data: "DATA-4" },
    ]);
  });

  it("leaves orphan markers (no matching ref) as literal text", () => {
    const blocks = buildClaudePromptBlocks({
      promptText: "stale [Image #99] reference",
      imageRefs: [],
    });

    expect(blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "stale [Image #99] reference" },
    ]);
  });

  it("emits no text block when prompt is empty and no images", () => {
    const blocks = buildClaudePromptBlocks({
      promptText: "",
      imageRefs: [],
    });

    expect(blocks).toEqual([]);
  });

  it("prepends syntheticForkSeed text when present", () => {
    const blocks = buildClaudePromptBlocks({
      promptText: "the prompt",
      imageRefs: [],
      syntheticForkSeed: "<fork-seed/>",
    });

    expect(blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "<fork-seed/>" },
      { type: "text", text: "the prompt" },
    ]);
  });

  it("preserves marker order in promptText regardless of imageRefs array order", () => {
    const blocks = buildClaudePromptBlocks({
      promptText: "[Image #11] mid [Image #10]",
      imageRefs: [
        ref(10, { path: "/p/10.png", base64Data: "TEN" }),
        ref(11, { path: "/p/11.png", base64Data: "ELEVEN" }),
      ],
    });

    expect(blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "[Image #11 source: /p/11.png]" },
      { type: "image", mediaType: "image/png", base64Data: "ELEVEN" },
      { type: "text", text: " mid " },
      { type: "text", text: "[Image #10 source: /p/10.png]" },
      { type: "image", mediaType: "image/png", base64Data: "TEN" },
    ]);
  });
});
