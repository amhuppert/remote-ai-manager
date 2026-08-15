import { describe, it, expect } from "vitest";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { GraphWorkflowResultDelivery } from "@/lib/workflow-graph/schemas";
import {
  assembleUserContentBlocks,
  assembleWorkflowResultsBlock,
} from "./assemble-user-blocks";

function img(
  id: string,
  options: {
    inlineMarkerIndex?: number;
    mediaType?: ImagePayload["mediaType"];
    data?: string;
  } = {},
): ImagePayload {
  const payload: ImagePayload = {
    attachmentId: id,
    mediaType: options.mediaType ?? "image/png",
    base64Data: options.data ?? `DATA-${id}`,
  };
  if (options.inlineMarkerIndex !== undefined) {
    payload.inlineMarkerIndex = options.inlineMarkerIndex;
  }
  return payload;
}

describe("assembleUserContentBlocks", () => {
  it("returns prompt text unchanged with empty blocks when no images", () => {
    const result = assembleUserContentBlocks({
      promptText: "hello world",
      images: [],
      startIndex: 1,
    });

    expect(result.rewrittenPromptText).toBe("hello world");
    expect(result.blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "hello world" },
    ]);
  });

  it("yields no text block for empty prompt with no images", () => {
    const result = assembleUserContentBlocks({
      promptText: "",
      images: [],
      startIndex: 1,
    });

    expect(result.rewrittenPromptText).toBe("");
    expect(result.blocks).toEqual([]);
  });

  it("interleaves a single inline image at its marker position", () => {
    const result = assembleUserContentBlocks({
      promptText: "before [Image #1] after",
      images: [img("a", { inlineMarkerIndex: 1 })],
      startIndex: 1,
    });

    expect(result.rewrittenPromptText).toBe("before [Image #1] after");
    expect(result.blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "before " },
      { type: "image", mediaType: "image/png", base64Data: "DATA-a" },
      { type: "text", text: " after" },
    ]);
  });

  it("rewrites client indices to contiguous server indices starting at startIndex", () => {
    const result = assembleUserContentBlocks({
      promptText: "look [Image #7] and [Image #11]",
      images: [
        img("a", { inlineMarkerIndex: 7 }),
        img("b", { inlineMarkerIndex: 11 }),
      ],
      startIndex: 4,
    });

    expect(result.rewrittenPromptText).toBe("look [Image #4] and [Image #5]");
    expect(result.blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "look " },
      { type: "image", mediaType: "image/png", base64Data: "DATA-a" },
      { type: "text", text: " and " },
      { type: "image", mediaType: "image/png", base64Data: "DATA-b" },
    ]);
  });

  it("orders inline images by their client inlineMarkerIndex ascending, regardless of array order", () => {
    const result = assembleUserContentBlocks({
      promptText: "[Image #2] then [Image #1]",
      images: [
        img("first-in-array", { inlineMarkerIndex: 2 }),
        img("second-in-array", { inlineMarkerIndex: 1 }),
      ],
      startIndex: 10,
    });

    expect(result.rewrittenPromptText).toBe("[Image #11] then [Image #10]");
    expect(result.blocks).toEqual<MessageContentBlock[]>([
      {
        type: "image",
        mediaType: "image/png",
        base64Data: "DATA-first-in-array",
      },
      { type: "text", text: " then " },
      {
        type: "image",
        mediaType: "image/png",
        base64Data: "DATA-second-in-array",
      },
    ]);
  });

  it("appends strip-only images after the typed text in attachment order", () => {
    const result = assembleUserContentBlocks({
      promptText: "look at these",
      images: [
        img("strip-1", { mediaType: "image/jpeg", data: "JPG1" }),
        img("strip-2", { mediaType: "image/png", data: "PNG2" }),
      ],
      startIndex: 1,
    });

    expect(result.rewrittenPromptText).toBe("look at these");
    expect(result.blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "look at these" },
      { type: "image", mediaType: "image/jpeg", base64Data: "JPG1" },
      { type: "image", mediaType: "image/png", base64Data: "PNG2" },
    ]);
  });

  it("places inline images before strip-only images and assigns indices contiguously", () => {
    const result = assembleUserContentBlocks({
      promptText: "see [Image #1] please",
      images: [
        img("strip", { data: "STRIP-DATA" }),
        img("inline", { inlineMarkerIndex: 1, data: "INLINE-DATA" }),
      ],
      startIndex: 5,
    });

    expect(result.rewrittenPromptText).toBe("see [Image #5] please");
    expect(result.blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "see " },
      { type: "image", mediaType: "image/png", base64Data: "INLINE-DATA" },
      { type: "text", text: " please" },
      { type: "image", mediaType: "image/png", base64Data: "STRIP-DATA" },
    ]);
  });

  it("leaves orphan markers (no matching image) as literal text", () => {
    const result = assembleUserContentBlocks({
      promptText: "stale [Image #99] reference",
      images: [],
      startIndex: 1,
    });

    expect(result.rewrittenPromptText).toBe("stale [Image #99] reference");
    expect(result.blocks).toEqual<MessageContentBlock[]>([
      { type: "text", text: "stale [Image #99] reference" },
    ]);
  });

  it("emits image blocks for prompts that are entirely an inline marker", () => {
    const result = assembleUserContentBlocks({
      promptText: "[Image #1]",
      images: [img("a", { inlineMarkerIndex: 1 })],
      startIndex: 3,
    });

    expect(result.rewrittenPromptText).toBe("[Image #3]");
    expect(result.blocks).toEqual<MessageContentBlock[]>([
      { type: "image", mediaType: "image/png", base64Data: "DATA-a" },
    ]);
  });

  it("returns startIndex-aligned mapping (used by callers for file paths)", () => {
    const result = assembleUserContentBlocks({
      promptText: "x [Image #1] y [Image #2] z",
      images: [
        img("a", { inlineMarkerIndex: 1, mediaType: "image/png" }),
        img("b", { inlineMarkerIndex: 2, mediaType: "image/jpeg" }),
        img("strip", { mediaType: "image/webp" }),
      ],
      startIndex: 1,
    });

    expect(result.assignments).toEqual([
      { attachmentId: "a", serverIndex: 1, mediaType: "image/png" },
      { attachmentId: "b", serverIndex: 2, mediaType: "image/jpeg" },
      { attachmentId: "strip", serverIndex: 3, mediaType: "image/webp" },
    ]);
  });
});

describe("assembleWorkflowResultsBlock", () => {
  it("renders one structured block in durable boundary order with stable keys", () => {
    const deliveries: GraphWorkflowResultDelivery[] = [
      {
        executionId: "exec-zeta",
        boundarySeq: 42,
        projectPath: "/projects/repo",
        sessionName: "test-session",
        originConversationId: "conv-1",
        payload: { status: "completed", output: "second" },
        recordedAt: "2026-08-14T12:00:02.000Z",
        state: "delivering",
        attemptId: "turn-1",
        attemptCount: 1,
        deliveredAt: null,
        effectsDeliveredAt: null,
      },
      {
        executionId: "exec-alpha",
        boundarySeq: 11,
        projectPath: "/projects/repo",
        sessionName: "test-session",
        originConversationId: "conv-1",
        payload: { status: "halted", output: "first" },
        recordedAt: "2026-08-14T12:00:01.000Z",
        state: "delivering",
        attemptId: "turn-1",
        attemptCount: 1,
        deliveredAt: null,
        effectsDeliveredAt: null,
      },
    ];

    const block = assembleWorkflowResultsBlock(deliveries);
    if (block === null) throw new Error("Expected a workflow results block");

    expect(block.match(/<workflow-results>/g)).toHaveLength(1);
    expect(block.match(/<\/workflow-results>/g)).toHaveLength(1);
    expect(block.indexOf('"key":"exec-alpha:11"')).toBeLessThan(
      block.indexOf('"key":"exec-zeta:42"'),
    );
    expect(block).toContain('"executionId":"exec-alpha"');
    expect(block).toContain('"boundarySeq":42');
    expect(block).toContain('"output":"second"');
  });

  it("returns null when there are no claimed results", () => {
    expect(assembleWorkflowResultsBlock([])).toBeNull();
  });
});
