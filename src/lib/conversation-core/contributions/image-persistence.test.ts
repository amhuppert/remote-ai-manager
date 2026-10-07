import { describe, it, expect, vi } from "vitest";
import type { ImagePayload } from "@/lib/images/schemas";
import { persistTurnImages } from "./image-persistence";

function image(
  attachmentId: string,
  base64Data: string,
  inlineMarkerIndex: number,
): ImagePayload {
  return {
    attachmentId,
    mediaType: "image/png",
    base64Data,
    inlineMarkerIndex,
  };
}

describe("persistTurnImages", () => {
  it("assigns server indices from the transcript's cumulative count and persists each image by index", async () => {
    const saved: Array<{ index: number; data: string }> = [];
    const deps = {
      getNextImageIndex: vi.fn(async () => 3),
      saveTranscriptImage: vi.fn(
        async (
          _id: string,
          index: number,
          mediaType: string,
          base64Data: string,
        ) => {
          saved.push({ index, data: base64Data });
          return `/persisted/${index}.${mediaType.split("/")[1]}`;
        },
      ),
    };

    const result = await persistTurnImages(deps, {
      conversationId: "conv-1",
      promptText: "look [Image #1] and [Image #2]",
      images: [image("a", "AAA", 1), image("b", "BBB", 2)],
    });

    expect(saved).toEqual([
      { index: 3, data: "AAA" },
      { index: 4, data: "BBB" },
    ]);
    expect(result.imageRefs).toEqual([
      {
        index: 3,
        mediaType: "image/png",
        path: "/persisted/3.png",
        base64Data: "AAA",
      },
      {
        index: 4,
        mediaType: "image/png",
        path: "/persisted/4.png",
        base64Data: "BBB",
      },
    ]);
    expect(result.assembled.rewrittenPromptText).toBe(
      "look [Image #3] and [Image #4]",
    );
  });

  it("does not read the next image index for a turn without images", async () => {
    const deps = {
      getNextImageIndex: vi.fn(async () => 99),
      saveTranscriptImage: vi.fn(async () => "/never"),
    };

    const result = await persistTurnImages(deps, {
      conversationId: "conv-1",
      promptText: "no images here",
      images: [],
    });

    expect(deps.getNextImageIndex).not.toHaveBeenCalled();
    expect(deps.saveTranscriptImage).not.toHaveBeenCalled();
    expect(result.imageRefs).toEqual([]);
    expect(result.assembled.rewrittenPromptText).toBe("no images here");
  });
});
