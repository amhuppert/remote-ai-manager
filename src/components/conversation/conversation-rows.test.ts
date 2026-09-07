import { describe, expect, it } from "vitest";

/** Every message in these fixtures has one text block, so one part. */
const SINGLE_PART = { index: 0, count: 1, start: 0, end: 1 };
import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
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
  it("does not allocate virtual rows for standalone results or blank text", () => {
    const msg: TranscriptMessage = {
      role: "assistant",
      timestamp: null,
      content: [
        { type: "text", text: "Before" },
        { type: "tool_result", tool_use_id: "earlier-tool" },
        { type: "text", text: " \n\t" },
        { type: "text", text: "After" },
      ],
    };

    const rows = buildConversationRows([msg], undefined);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.kind === "message" && row.part)).toEqual([
      { index: 0, count: 2, start: 0, end: 1 },
      { index: 1, count: 2, start: 1, end: 2 },
    ]);
    expect(rows.every((row) => row.kind === "message" && row.msg === msg)).toBe(
      true,
    );
  });

  it("keeps message chrome when every block is non-rendering", () => {
    const msg: TranscriptMessage = {
      role: "assistant",
      timestamp: null,
      content: [
        { type: "tool_result", tool_use_id: "earlier-tool" },
        { type: "text", text: "" },
      ],
    };

    expect(buildConversationRows([msg], undefined)).toMatchObject([
      { kind: "message", msg, part: { index: 0, count: 1, start: 0, end: 0 } },
    ]);
  });

  it("builds an empty row list for empty messages without collab", () => {
    expect(buildConversationRows([], undefined)).toEqual([]);
  });

  it("returns one message row per message when collab is absent", () => {
    const messages = [message("user", "hello"), message("assistant", "hi")];

    expect(buildConversationRows(messages, undefined)).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0], part: SINGLE_PART },
      { kind: "message", messageIndex: 1, msg: messages[1], part: SINGLE_PART },
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
      { kind: "message", messageIndex: 0, msg: messages[0], part: SINGLE_PART },
      { kind: "message", messageIndex: 1, msg: messages[1], part: SINGLE_PART },
      { kind: "message", messageIndex: 2, msg: messages[2], part: SINGLE_PART },
      { kind: "collab", workflowId: "wf-1" },
      { kind: "message", messageIndex: 3, msg: messages[3], part: SINGLE_PART },
    ]);
  });

  it("appends the collab row when no /collab user message exists", () => {
    const messages = [message("user", "hello")];

    expect(findCollabAnchorIndex(messages)).toBe(-1);
    expect(buildConversationRows(messages, { workflowId: "wf-2" })).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0], part: SINGLE_PART },
      { kind: "collab", workflowId: "wf-2" },
    ]);
  });

  it("uses message index to keep identical timestamps distinct", () => {
    const first = message("assistant", "one", "same");
    const second = message("assistant", "two", "same");

    expect(
      computeRowKey({
        kind: "message",
        messageIndex: 0,
        msg: first,
        part: SINGLE_PART,
      }),
    ).toBe("0:0:assistant:same");
    expect(
      computeRowKey({
        kind: "message",
        messageIndex: 1,
        msg: second,
        part: SINGLE_PART,
      }),
    ).toBe("1:0:assistant:same");
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
    const row = {
      kind: "message" as const,
      messageIndex: 4,
      msg,
      part: SINGLE_PART,
    };

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
      { kind: "message", messageIndex: 0, msg: messages[0], part: SINGLE_PART },
      { kind: "message", messageIndex: 1, msg: messages[1], part: SINGLE_PART },
      { kind: "message", messageIndex: 3, msg: messages[3], part: SINGLE_PART },
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
      { kind: "message", messageIndex: 0, msg: messages[0], part: SINGLE_PART },
      { kind: "collab", workflowId: "wf-hide" },
      { kind: "message", messageIndex: 2, msg: messages[2], part: SINGLE_PART },
    ]);
  });

  it("ignores hiddenMessageIndex when null", () => {
    const messages = [message("user", "hi"), message("assistant", "hey")];

    expect(buildConversationRows(messages, undefined, null)).toEqual([
      { kind: "message", messageIndex: 0, msg: messages[0], part: SINGLE_PART },
      { kind: "message", messageIndex: 1, msg: messages[1], part: SINGLE_PART },
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
      { kind: "message", messageIndex: 0, msg: messages[0], part: SINGLE_PART },
      { kind: "extension", ext: ext("card-1", 0) },
      { kind: "message", messageIndex: 1, msg: messages[1], part: SINGLE_PART },
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
      { kind: "message", messageIndex: 0, msg: messages[0], part: SINGLE_PART },
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

describe("buildConversationRows — block-granular parts", () => {
  function toolUse(id: string): MessageContentBlock {
    return { type: "tool_use", id, name: "Bash", input: {} };
  }
  function thinking(text: string): MessageContentBlock {
    return { type: "thinking", text, redacted: false };
  }
  function assistantWith(content: MessageContentBlock[]): TranscriptMessage {
    return { role: "assistant", content, timestamp: "2024-06-15T10:00:00Z" };
  }

  it("emits one row per grouped content item so a long turn is not one row", () => {
    // A turn with three separately-renderable units: text, a tool group, then
    // more text. Today this is a single row that mounts all of them at once.
    const msg = assistantWith([
      { type: "text", text: "first" },
      toolUse("t1"),
      { type: "text", text: "second" },
    ]);

    const rows = buildConversationRows([msg], undefined);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.kind === "message" && row.part.index)).toEqual(
      [0, 1, 2],
    );
    expect(
      rows.every((row) => row.kind === "message" && row.part.count === 3),
    ).toBe(true);
  });

  it("gives every part the same message index so navigation still resolves", () => {
    const rows = buildConversationRows(
      [
        message("user", "hi"),
        assistantWith([thinking("a"), { type: "text", text: "b" }]),
      ],
      undefined,
    );

    expect(
      rows.map((row) => (row.kind === "message" ? row.messageIndex : null)),
    ).toEqual([0, 1, 1]);
    // Scroll-to-message takes the first matching row: part 0 of the message.
    expect(
      rows.findIndex((r) => r.kind === "message" && r.messageIndex === 1),
    ).toBe(1);
  });

  it("gives each part a disjoint grouped-item slice covering the whole message", () => {
    const msg = assistantWith([
      { type: "text", text: "a" },
      toolUse("t1"),
      { type: "text", text: "b" },
    ]);

    const rows = buildConversationRows([msg], undefined);
    const ranges = rows.map((row) =>
      row.kind === "message" ? [row.part.start, row.part.end] : null,
    );

    expect(ranges).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("still emits one row for a message with no renderable content", () => {
    const rows = buildConversationRows([assistantWith([])], undefined);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "message",
      part: { index: 0, count: 1, start: 0, end: 0 },
    });
  });

  it("keys each part distinctly so Virtuoso does not collapse them", () => {
    const msg = assistantWith([{ type: "text", text: "a" }, toolUse("t1")]);

    const keys = buildConversationRows([msg], undefined).map(computeRowKey);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("applies the content transform before splitting, so hidden blocks do not create empty rows", () => {
    const msg = assistantWith([
      { type: "text", text: "kept" },
      { type: "text", text: "hidden" },
    ]);

    const rows = buildConversationRows([msg], undefined, null, [], (content) =>
      content.filter(
        (block) => block.type !== "text" || block.text !== "hidden",
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "message", part: { count: 1 } });
  });

  it("drops a message the transform empties entirely", () => {
    const rows = buildConversationRows(
      [
        message("user", "keep"),
        assistantWith([{ type: "text", text: "drop" }]),
      ],
      undefined,
      null,
      [],
      (_content, messageIndex) => (messageIndex === 1 ? [] : _content),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "message", messageIndex: 0 });
  });
});
