import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import {
  buildConversationRows,
  computeRowKey,
  findCollabAnchorIndex,
  topmostMessageIndexForRange,
} from "@/components/conversation/conversation-rows";

function message(
  role: "user" | "assistant",
  text: string,
  timestamp: string | null = "2024-06-15T10:00:00Z",
): TranscriptMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  };
}

describe("conversation rows", () => {
  it("builds an empty row list for empty messages without collab", () => {
    expect(buildConversationRows([], undefined)).toEqual([]);
  });

  it("returns one message row per message when collab is absent", () => {
    const messages = [message("user", "hello"), message("assistant", "hi")];

    expect(buildConversationRows(messages, undefined)).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0] },
      { kind: "message", messageIndex: 1, msg: messages[1] },
    ]);
  });

  it("inserts the collab row after the latest /collab user message", () => {
    const messages = [
      message("user", "/collab older"),
      message("assistant", "working"),
      message("user", "/collab latest"),
      message("assistant", "done"),
    ];

    expect(findCollabAnchorIndex(messages)).toBe(2);
    expect(buildConversationRows(messages, { workflowId: "wf-1" })).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0] },
      { kind: "message", messageIndex: 1, msg: messages[1] },
      { kind: "message", messageIndex: 2, msg: messages[2] },
      { kind: "collab", workflowId: "wf-1" },
      { kind: "message", messageIndex: 3, msg: messages[3] },
    ]);
  });

  it("appends the collab row when no /collab user message exists", () => {
    const messages = [message("user", "hello")];

    expect(findCollabAnchorIndex(messages)).toBe(-1);
    expect(buildConversationRows(messages, { workflowId: "wf-2" })).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0] },
      { kind: "collab", workflowId: "wf-2" },
    ]);
  });

  it("uses message index to keep identical timestamps distinct", () => {
    const first = message("assistant", "one", "same");
    const second = message("assistant", "two", "same");

    expect(
      computeRowKey({ kind: "message", messageIndex: 0, msg: first }),
    ).toBe("0:assistant:same");
    expect(
      computeRowKey({ kind: "message", messageIndex: 1, msg: second }),
    ).toBe("1:assistant:same");
  });

  it("computes collab keys with a fallback for empty workflow IDs", () => {
    expect(computeRowKey({ kind: "collab", workflowId: "wf-3" })).toBe(
      "collab:wf-3",
    );
    expect(computeRowKey({ kind: "collab", workflowId: "" })).toBe(
      "collab-row",
    );
  });

  it("walks down from a collab row to find the topmost message index", () => {
    const messages = [
      message("user", "/collab start"),
      message("assistant", "after"),
    ];
    const rows = buildConversationRows(messages, { workflowId: "wf-4" });

    expect(topmostMessageIndexForRange(rows, 1)).toBe(1);
  });

  it("walks up when the range starts beyond the last message", () => {
    const messages = [message("user", "first"), message("assistant", "last")];
    const rows = buildConversationRows(messages, { workflowId: "wf-5" });

    expect(topmostMessageIndexForRange(rows, rows.length - 1)).toBe(1);
  });

  it("keeps row keys stable for the same logical row", () => {
    const msg = message("user", "stable", null);
    const row = { kind: "message" as const, messageIndex: 4, msg };

    expect(computeRowKey(row)).toBe(computeRowKey({ ...row }));
  });

  it("skips the row at hiddenMessageIndex but preserves original indices for the rest", () => {
    const messages = [
      message("user", "/collab brief"),
      message("assistant", "interim"),
      message("assistant", "answer text"),
      message("user", "follow-up"),
    ];

    expect(buildConversationRows(messages, undefined, 2)).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0] },
      { kind: "message", messageIndex: 1, msg: messages[1] },
      { kind: "message", messageIndex: 3, msg: messages[3] },
    ]);
  });

  it("skips the hidden row while still emitting the collab row at the anchor", () => {
    const messages = [
      message("user", "/collab brief"),
      message("assistant", "answer text"),
      message("user", "next"),
    ];

    expect(
      buildConversationRows(messages, { workflowId: "wf-hide" }, 1),
    ).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0] },
      { kind: "collab", workflowId: "wf-hide" },
      { kind: "message", messageIndex: 2, msg: messages[2] },
    ]);
  });

  it("ignores hiddenMessageIndex when null", () => {
    const messages = [message("user", "hi"), message("assistant", "hey")];

    expect(buildConversationRows(messages, undefined, null)).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0] },
      { kind: "message", messageIndex: 1, msg: messages[1] },
    ]);
  });
});

describe("buildConversationRows — extension rows (spawn-card seam)", () => {
  const ext = (key: string, anchorMessageIndex: number) => ({
    key,
    anchorMessageIndex,
  });

  it("interleaves an extension row immediately after its anchor message", () => {
    const messages = [message("user", "a"), message("assistant", "b")];

    expect(
      buildConversationRows(messages, undefined, null, [ext("card-1", 0)]),
    ).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0] },
      { kind: "extension", ext: ext("card-1", 0) },
      { kind: "message", messageIndex: 1, msg: messages[1] },
    ]);
  });

  it("prepends rows anchored before the first message and appends rows anchored past the last", () => {
    const messages = [message("user", "a")];

    expect(
      buildConversationRows(messages, undefined, null, [
        ext("late", 9),
        ext("early", -1),
      ]),
    ).toEqual([
      { kind: "extension", ext: ext("early", -1) },
      { kind: "message", messageIndex: 0, msg: messages[0] },
      { kind: "extension", ext: ext("late", 9) },
    ]);
  });

  it("keeps supplied order for multiple rows at the same anchor", () => {
    const messages = [message("user", "a")];

    const rows = buildConversationRows(messages, undefined, null, [
      ext("first", 0),
      ext("second", 0),
    ]);
    expect(
      rows.map((r) => (r.kind === "extension" ? r.ext.key : r.kind)),
    ).toEqual(["message", "first", "second"]);
  });

  it("renders extension rows alone when there are no messages", () => {
    expect(
      buildConversationRows([], undefined, null, [ext("only", 0)]),
    ).toEqual([{ kind: "extension", ext: ext("only", 0) }]);
  });

  it("composes with a collab row without disturbing either anchor", () => {
    const messages = [message("user", "/collab go"), message("assistant", "b")];

    const rows = buildConversationRows(messages, { workflowId: "wf-1" }, null, [
      ext("card", 1),
    ]);
    expect(
      rows.map((r) => (r.kind === "extension" ? `ext:${r.ext.key}` : r.kind)),
    ).toEqual(["message", "collab", "message", "ext:card"]);
  });

  it("keys extension rows by their stable key", () => {
    expect(computeRowKey({ kind: "extension", ext: ext("spawn:p1", 2) })).toBe(
      "extension:spawn:p1",
    );
  });
});
