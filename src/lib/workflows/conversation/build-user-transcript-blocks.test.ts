import { describe, expect, it } from "vitest";
import { buildUserTranscriptBlocks } from "./build-user-transcript-blocks";
import type { ConversationImageRef } from "@/types";

function ref(
  index: number,
  path: string,
  mediaType: ConversationImageRef["mediaType"] = "image/png",
): ConversationImageRef {
  return { index, mediaType, path, base64Data: "BASE64" };
}

describe("buildUserTranscriptBlocks", () => {
  it("emits a single text block when there are no images", () => {
    const blocks = buildUserTranscriptBlocks({
      rewrittenPromptText: "hello world",
      imageRefs: [],
    });
    expect(blocks).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("emits no blocks for empty prompt with no refs", () => {
    const blocks = buildUserTranscriptBlocks({
      rewrittenPromptText: "",
      imageRefs: [],
    });
    expect(blocks).toEqual([]);
  });

  it("interleaves marker + ref pairs at marker positions", () => {
    const r1 = ref(3, "/imgs/3.png");
    const blocks = buildUserTranscriptBlocks({
      rewrittenPromptText: "look at [Image #3] please",
      imageRefs: [r1],
    });
    expect(blocks).toEqual([
      { type: "text", text: "look at " },
      {
        type: "image_marker",
        index: 3,
        mediaType: "image/png",
        imagePath: "/imgs/3.png",
      },
      { type: "image_ref", mediaType: "image/png", imagePath: "/imgs/3.png" },
      { type: "text", text: " please" },
    ]);
  });

  it("appends marker + ref pairs at end for strip-only refs (not present in prompt)", () => {
    const r2 = ref(2, "/imgs/2.jpg", "image/jpeg");
    const blocks = buildUserTranscriptBlocks({
      rewrittenPromptText: "compare these",
      imageRefs: [r2],
    });
    expect(blocks).toEqual([
      { type: "text", text: "compare these" },
      {
        type: "image_marker",
        index: 2,
        mediaType: "image/jpeg",
        imagePath: "/imgs/2.jpg",
      },
      { type: "image_ref", mediaType: "image/jpeg", imagePath: "/imgs/2.jpg" },
    ]);
  });

  it("handles mix of inline + strip refs (inline interleaved, strip appended)", () => {
    const r5 = ref(5, "/imgs/5.png");
    const r6 = ref(6, "/imgs/6.png");
    const blocks = buildUserTranscriptBlocks({
      rewrittenPromptText: "see [Image #5] now",
      imageRefs: [r5, r6],
    });
    expect(blocks).toEqual([
      { type: "text", text: "see " },
      {
        type: "image_marker",
        index: 5,
        mediaType: "image/png",
        imagePath: "/imgs/5.png",
      },
      { type: "image_ref", mediaType: "image/png", imagePath: "/imgs/5.png" },
      { type: "text", text: " now" },
      {
        type: "image_marker",
        index: 6,
        mediaType: "image/png",
        imagePath: "/imgs/6.png",
      },
      { type: "image_ref", mediaType: "image/png", imagePath: "/imgs/6.png" },
    ]);
  });

  it("preserves orphan markers (no matching ref) as literal text", () => {
    const r3 = ref(3, "/imgs/3.png");
    const blocks = buildUserTranscriptBlocks({
      rewrittenPromptText: "look at [Image #99] then [Image #3]",
      imageRefs: [r3],
    });
    expect(blocks).toEqual([
      { type: "text", text: "look at [Image #99] then " },
      {
        type: "image_marker",
        index: 3,
        mediaType: "image/png",
        imagePath: "/imgs/3.png",
      },
      { type: "image_ref", mediaType: "image/png", imagePath: "/imgs/3.png" },
    ]);
  });

  it("emits trailing text after the final inline marker", () => {
    const r4 = ref(4, "/imgs/4.png");
    const blocks = buildUserTranscriptBlocks({
      rewrittenPromptText: "[Image #4] is the result",
      imageRefs: [r4],
    });
    expect(blocks).toEqual([
      {
        type: "image_marker",
        index: 4,
        mediaType: "image/png",
        imagePath: "/imgs/4.png",
      },
      { type: "image_ref", mediaType: "image/png", imagePath: "/imgs/4.png" },
      { type: "text", text: " is the result" },
    ]);
  });

  it("orders strip refs by their position in imageRefs", () => {
    const r1 = ref(1, "/imgs/1.png");
    const r2 = ref(2, "/imgs/2.png");
    const r3 = ref(3, "/imgs/3.png");
    const blocks = buildUserTranscriptBlocks({
      rewrittenPromptText: "all attached:",
      imageRefs: [r3, r1, r2],
    });
    expect(blocks).toEqual([
      { type: "text", text: "all attached:" },
      {
        type: "image_marker",
        index: 3,
        mediaType: "image/png",
        imagePath: "/imgs/3.png",
      },
      { type: "image_ref", mediaType: "image/png", imagePath: "/imgs/3.png" },
      {
        type: "image_marker",
        index: 1,
        mediaType: "image/png",
        imagePath: "/imgs/1.png",
      },
      { type: "image_ref", mediaType: "image/png", imagePath: "/imgs/1.png" },
      {
        type: "image_marker",
        index: 2,
        mediaType: "image/png",
        imagePath: "/imgs/2.png",
      },
      { type: "image_ref", mediaType: "image/png", imagePath: "/imgs/2.png" },
    ]);
  });
});
