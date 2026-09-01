import { describe, expect, it } from "vitest";
import {
  BOUNDED_DESCRIPTION_BUDGET,
  buildAttachmentIndex,
  renderAttachmentIndexLines,
} from "./attachment-index";
import type { TicketAttachment, TicketAttachmentPayload } from "./schemas";

const IDENTIFIER = "command-center#12";

let idSeq = 0;

function makeAttachment(
  payload: TicketAttachmentPayload,
  description = "a described attachment",
): TicketAttachment {
  idSeq += 1;
  return {
    id: `att-${idSeq}`,
    ticketId: "ticket-1",
    description,
    payload,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function oneOfEveryKind(): TicketAttachment[] {
  return [
    makeAttachment(
      {
        kind: "file",
        fileName: "design.md",
        snapshotKey: "ticket-1/att/design.md",
        mediaType: "text/markdown",
        sizeBytes: 10,
        sha256: "abc",
      },
      "API contract",
    ),
    makeAttachment(
      {
        kind: "conversation",
        projectPath: "/repos/command-center",
        sessionName: "feature-work",
        conversationId: "conv-1",
        snapshotKey: "ticket-1/att/compaction-conv-1.md",
        snapshotCapturedAt: "2026-07-10T00:00:00.000Z",
      },
      "Original design discussion",
    ),
    makeAttachment(
      {
        kind: "session",
        projectPath: "/repos/command-center",
        sessionName: "feature-work",
      },
      "Session where the bug reproduced",
    ),
    makeAttachment({ kind: "note", markdown: "remember this" }, "A note"),
  ];
}

describe("buildAttachmentIndex", () => {
  it("produces one typed entry per attachment for every kind, never omitting entries", () => {
    const attachments = oneOfEveryKind();
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments,
      mode: "bounded",
    });

    expect(entries).toHaveLength(attachments.length);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "file",
      "conversation",
      "session",
      "note",
    ]);
    expect(entries.map((entry) => entry.attachmentId)).toEqual(
      attachments.map((attachment) => attachment.id),
    );
  });

  it("carries the exact retrieval command on every entry", () => {
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments: oneOfEveryKind(),
      mode: "full",
    });
    for (const entry of entries) {
      expect(entry.commands[0]).toBe(
        `cctl ticket attachment get '${IDENTIFIER}' '${entry.attachmentId}'`,
      );
    }
  });

  it("returns exactly one retrieval command for every canonical attachment", () => {
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments: oneOfEveryKind(),
      mode: "full",
    });
    for (const entry of entries) {
      expect(entry.commands).toHaveLength(1);
    }
  });

  it("bounded mode truncates long descriptions at the fixed budget with an explicit ellipsis", () => {
    const longDescription = "x".repeat(BOUNDED_DESCRIPTION_BUDGET * 2);
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments: [
        makeAttachment({ kind: "note", markdown: "body" }, longDescription),
      ],
      mode: "bounded",
    });

    const entry = entries[0];
    expect(entry?.truncated).toBe(true);
    expect(entry?.description).toHaveLength(BOUNDED_DESCRIPTION_BUDGET);
    expect(entry?.description.endsWith("…")).toBe(true);
    expect(
      entry?.description.startsWith("x".repeat(BOUNDED_DESCRIPTION_BUDGET - 1)),
    ).toBe(true);
  });

  it("bounded mode leaves short descriptions intact and unmarked", () => {
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments: [
        makeAttachment({ kind: "note", markdown: "body" }, "short"),
      ],
      mode: "bounded",
    });
    expect(entries[0]?.description).toBe("short");
    expect(entries[0]?.truncated).toBe(false);
  });

  it("full mode renders complete descriptions past the bounded budget", () => {
    const longDescription = "y".repeat(BOUNDED_DESCRIPTION_BUDGET * 2);
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments: [
        makeAttachment({ kind: "note", markdown: "body" }, longDescription),
      ],
      mode: "full",
    });
    expect(entries[0]?.description).toBe(longDescription);
    expect(entries[0]?.truncated).toBe(false);
  });

  it("bounded mode never omits entries however many attachments exist", () => {
    const attachments = Array.from({ length: 40 }, (_, index) =>
      makeAttachment(
        { kind: "note", markdown: "body" },
        `note number ${index} ${"z".repeat(BOUNDED_DESCRIPTION_BUDGET)}`,
      ),
    );
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments,
      mode: "bounded",
    });
    expect(entries).toHaveLength(40);
    for (const entry of entries) {
      expect(entry.description.length).toBeLessThanOrEqual(
        BOUNDED_DESCRIPTION_BUDGET,
      );
    }
  });

  it("normalizes multi-line descriptions to single-line index text", () => {
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments: [
        makeAttachment(
          { kind: "note", markdown: "body" },
          "first line\nsecond   line\n\tthird",
        ),
      ],
      mode: "full",
    });
    expect(entries[0]?.description).toBe("first line second line third");
  });
});

describe("renderAttachmentIndexLines", () => {
  it("renders the described index line per entry with id, kind, description, and commands", () => {
    const attachments = oneOfEveryKind();
    const entries = buildAttachmentIndex({
      identifier: IDENTIFIER,
      attachments,
      mode: "bounded",
    });
    const lines = renderAttachmentIndexLines(entries);

    expect(lines).toHaveLength(attachments.length);
    const fileAttachment = attachments[0];
    expect(lines[0]).toBe(
      `- ${fileAttachment?.id} file — API contract — cctl ticket attachment get '${IDENTIFIER}' '${fileAttachment?.id}'`,
    );
    const noteAttachment = attachments[3];
    expect(lines[3]).toBe(
      `- ${noteAttachment?.id} note — A note — cctl ticket attachment get '${IDENTIFIER}' '${noteAttachment?.id}'`,
    );
  });

  it("renders no lines for an empty index", () => {
    expect(renderAttachmentIndexLines([])).toEqual([]);
  });
});
