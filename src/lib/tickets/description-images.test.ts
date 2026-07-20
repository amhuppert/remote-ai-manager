import { describe, expect, it } from "vitest";

import type { TicketAttachment } from "./schemas";
import {
  collectDescriptionImageRefs,
  parsePastedImageIndex,
  pastedImageDescription,
  pastedImageFileName,
  planDescriptionImageSync,
} from "./description-images";

function fileAttachment(input: {
  id: string;
  description: string;
  fileName?: string;
  mediaType?: string | null;
}): TicketAttachment {
  return {
    id: input.id,
    ticketId: "ticket-1",
    description: input.description,
    payload: {
      kind: "file",
      fileName: input.fileName ?? "pasted-image-1.png",
      snapshotKey: `snap-${input.id}`,
      mediaType: input.mediaType === undefined ? "image/png" : input.mediaType,
      sizeBytes: 10,
      sha256: "abc",
    },
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

describe("pastedImageDescription", () => {
  it("round-trips the indexed description through the parser", () => {
    const description = pastedImageDescription(3);
    expect(parsePastedImageIndex(description)).toBe(3);
  });

  it("produces a non-indexed description that does not parse as indexed", () => {
    const description = pastedImageDescription(null);
    expect(description.length).toBeGreaterThan(0);
    expect(parsePastedImageIndex(description)).toBeNull();
  });

  it("rejects unrelated descriptions", () => {
    expect(parsePastedImageIndex("full CI log of the flaky run")).toBeNull();
    expect(parsePastedImageIndex("appears as [Image #2]")).toBeNull();
  });
});

describe("pastedImageFileName", () => {
  it("derives extension from the media type", () => {
    expect(pastedImageFileName(1, "image/png")).toBe("pasted-image-1.png");
    expect(pastedImageFileName(2, "image/jpeg")).toBe("pasted-image-2.jpg");
    expect(pastedImageFileName(3, "image/gif")).toBe("pasted-image-3.gif");
    expect(pastedImageFileName(4, "image/webp")).toBe("pasted-image-4.webp");
  });

  it("omits the index when the image has no inline reference", () => {
    expect(pastedImageFileName(null, "image/png")).toBe("pasted-image.png");
  });
});

describe("collectDescriptionImageRefs", () => {
  it("returns file attachments whose description carries an inline index", () => {
    const attachments = [
      fileAttachment({ id: "a1", description: pastedImageDescription(2) }),
      fileAttachment({ id: "a2", description: "unrelated file" }),
      fileAttachment({ id: "a3", description: pastedImageDescription(null) }),
      {
        ...fileAttachment({ id: "a4", description: pastedImageDescription(1) }),
        payload: { kind: "note" as const, markdown: "not a file" },
      },
    ];
    expect(collectDescriptionImageRefs(attachments)).toEqual([
      { attachmentId: "a1", index: 2, fileName: "pasted-image-1.png" },
    ]);
  });

  it("skips image attachments with a non-image media type", () => {
    const attachments = [
      fileAttachment({
        id: "a1",
        description: pastedImageDescription(1),
        mediaType: "application/pdf",
      }),
      fileAttachment({
        id: "a2",
        description: pastedImageDescription(2),
        mediaType: null,
      }),
    ];
    expect(collectDescriptionImageRefs(attachments)).toEqual([]);
  });
});

describe("planDescriptionImageSync", () => {
  const pastedPng = { mediaType: "image/png" as const, base64Data: "Zm9v" };

  it("uploads a newly pasted inline image with its indexed description", () => {
    const plan = planDescriptionImageSync({
      editorImages: [{ id: "img-1", inlineMarkerIndex: 1, ...pastedPng }],
      existing: [],
    });
    expect(plan).toEqual({
      uploads: [
        {
          imageId: "img-1",
          mediaType: "image/png",
          base64Data: "Zm9v",
          fileName: "pasted-image-1.png",
          description: pastedImageDescription(1),
        },
      ],
      descriptionSyncs: [],
      deletions: [],
    });
  });

  it("uploads a never-inlined image with the non-indexed description", () => {
    const plan = planDescriptionImageSync({
      editorImages: [{ id: "img-1", ...pastedPng }],
      existing: [],
    });
    expect(plan.uploads).toEqual([
      {
        imageId: "img-1",
        mediaType: "image/png",
        base64Data: "Zm9v",
        fileName: "pasted-image.png",
        description: pastedImageDescription(null),
      },
    ]);
  });

  it("re-syncs an existing attachment whose inline index moved", () => {
    const plan = planDescriptionImageSync({
      editorImages: [{ id: "a1", inlineMarkerIndex: 1, ...pastedPng }],
      existing: [{ attachmentId: "a1", index: 2, fileName: "f.png" }],
    });
    expect(plan.uploads).toEqual([]);
    expect(plan.deletions).toEqual([]);
    expect(plan.descriptionSyncs).toEqual([
      { attachmentId: "a1", description: pastedImageDescription(1) },
    ]);
  });

  it("leaves an unchanged existing attachment alone", () => {
    const plan = planDescriptionImageSync({
      editorImages: [{ id: "a1", inlineMarkerIndex: 2, ...pastedPng }],
      existing: [{ attachmentId: "a1", index: 2, fileName: "f.png" }],
    });
    expect(plan).toEqual({ uploads: [], descriptionSyncs: [], deletions: [] });
  });

  it("demotes an existing attachment that lost its chip but stayed attached", () => {
    const plan = planDescriptionImageSync({
      editorImages: [{ id: "a1", ...pastedPng }],
      existing: [{ attachmentId: "a1", index: 1, fileName: "f.png" }],
    });
    expect(plan.descriptionSyncs).toEqual([
      { attachmentId: "a1", description: pastedImageDescription(null) },
    ]);
    expect(plan.deletions).toEqual([]);
  });

  it("deletes an existing attachment removed from the editor entirely", () => {
    const plan = planDescriptionImageSync({
      editorImages: [],
      existing: [{ attachmentId: "a1", index: 1, fileName: "f.png" }],
    });
    expect(plan).toEqual({
      uploads: [],
      descriptionSyncs: [],
      deletions: ["a1"],
    });
  });

  it("handles a combined edit: renumber survivor, upload newcomer, delete removed", () => {
    const plan = planDescriptionImageSync({
      editorImages: [
        { id: "img-1", inlineMarkerIndex: 1, ...pastedPng },
        { id: "a2", inlineMarkerIndex: 2, ...pastedPng },
      ],
      existing: [
        { attachmentId: "a1", index: 1, fileName: "a.png" },
        { attachmentId: "a2", index: 3, fileName: "b.png" },
      ],
    });
    expect(plan.uploads).toEqual([
      {
        imageId: "img-1",
        mediaType: "image/png",
        base64Data: "Zm9v",
        fileName: "pasted-image-1.png",
        description: pastedImageDescription(1),
      },
    ]);
    expect(plan.descriptionSyncs).toEqual([
      { attachmentId: "a2", description: pastedImageDescription(2) },
    ]);
    expect(plan.deletions).toEqual(["a1"]);
  });
});
