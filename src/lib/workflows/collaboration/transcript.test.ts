import { describe, expect, it } from "vitest";

import { buildCollaborationUserTranscriptEntry } from "./transcript";

describe("buildCollaborationUserTranscriptEntry", () => {
  it("preserves rewritten prompt text and ordered image references", () => {
    expect(
      buildCollaborationUserTranscriptEntry({
        timestamp: "2026-07-13T12:00:00.000Z",
        brief: "compare [Image #0]",
        imageRefs: [
          {
            index: 0,
            mediaType: "image/jpeg",
            path: "/images/0.jpg",
            base64Data: "inline",
          },
          {
            index: 1,
            mediaType: "image/png",
            path: "/images/1.png",
            base64Data: "strip",
          },
        ],
        modelSelection: {
          modelId: "gpt-5.6",
          parameters: { reasoning: "xhigh", fast: "true" },
        },
      }),
    ).toEqual({
      timestamp: "2026-07-13T12:00:00.000Z",
      type: "user",
      role: "user",
      content: [
        { type: "text", text: "/collab compare [Image #0]" },
        {
          type: "image_ref",
          mediaType: "image/jpeg",
          imagePath: "/images/0.jpg",
        },
        {
          type: "image_ref",
          mediaType: "image/png",
          imagePath: "/images/1.png",
        },
      ],
      modelSelection: {
        modelId: "gpt-5.6",
        parameters: { reasoning: "xhigh", fast: "true" },
      },
    });
  });
});
