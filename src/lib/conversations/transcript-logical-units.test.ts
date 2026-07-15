import { describe, expect, it } from "vitest";
import {
  commandBlockForEntry,
  startsNewLogicalUnit,
  iterateLineClassifications,
  groupLogicalUnits,
  type LogicalUnitEntry,
} from "./transcript-logical-units";
import type { MessageContentBlock } from "@/lib/conversations/schemas";

const text = (t: string): MessageContentBlock => ({ type: "text", text: t });

function msg(
  seq: number,
  role: "user" | "assistant" | "notice",
  content: MessageContentBlock[],
  extra: Partial<LogicalUnitEntry> = {},
): LogicalUnitEntry {
  return {
    seq,
    kind: "message",
    role,
    content,
    entryId: null,
    timestamp: null,
    ...extra,
  };
}

function tool(seq: number, content: MessageContentBlock[]): LogicalUnitEntry {
  return {
    seq,
    kind: "tool_result",
    entryId: null,
    timestamp: null,
    content,
  };
}

describe("commandBlockForEntry", () => {
  it("parses a single-text-block user slash command", () => {
    const block = commandBlockForEntry("user", [text("/commit now")]);
    expect(block).toEqual({ type: "command", name: "/commit", args: "now" });
  });

  it("returns null for plain user text", () => {
    expect(commandBlockForEntry("user", [text("hello")])).toBeNull();
  });

  it("returns null for assistant entries even if the text starts with a slash", () => {
    expect(commandBlockForEntry("assistant", [text("/commit")])).toBeNull();
  });

  it("returns null for a multi-block user entry", () => {
    expect(
      commandBlockForEntry("user", [text("/commit"), text("more")]),
    ).toBeNull();
  });
});

describe("startsNewLogicalUnit", () => {
  it("opens the first unit when none is open", () => {
    expect(
      startsNewLogicalUnit({
        openRole: null,
        entryRole: "user",
        isCommand: false,
      }),
    ).toBe(true);
  });

  it("merges a same-role entry into the open unit", () => {
    expect(
      startsNewLogicalUnit({
        openRole: "assistant",
        entryRole: "assistant",
        isCommand: false,
      }),
    ).toBe(false);
  });

  it("breaks on a role transition", () => {
    expect(
      startsNewLogicalUnit({
        openRole: "user",
        entryRole: "assistant",
        isCommand: false,
      }),
    ).toBe(true);
  });

  it("breaks on a slash command even when the role is unchanged", () => {
    expect(
      startsNewLogicalUnit({
        openRole: "user",
        entryRole: "user",
        isCommand: true,
      }),
    ).toBe(true);
  });
});

describe("iterateLineClassifications", () => {
  it("advances the merged index only on unit boundaries and skips non-visible lines", () => {
    const entries: LogicalUnitEntry[] = [
      msg(0, "user", [text("hi")]),
      // A non-visible line between two visible entries — keeps its raw seq but
      // never opens a unit and inherits the currently-open merged index.
      { seq: 1, kind: "nonvisible" },
      msg(2, "assistant", [text("part one")], { uuid: "a1" }),
      msg(3, "assistant", [text("part two")], { uuid: "a2" }),
      msg(4, "user", [text("/commit now")]),
      msg(5, "user", [text("follow-up")]),
    ];

    const rows = [...iterateLineClassifications(entries)];
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(rows.map((r) => r.visible)).toEqual([
      true,
      false,
      true,
      true,
      true,
      true,
    ]);
    expect(rows.map((r) => r.opensUnit)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(rows.map((r) => r.mergedIndex)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      null,
      "assistant",
      "assistant",
      "user",
      "user",
    ]);
    expect(rows.map((r) => r.uuid ?? null)).toEqual([
      null,
      null,
      "a1",
      "a2",
      null,
      null,
    ]);
  });

  it("does not count tool_result lines as unit boundaries", () => {
    const rows = [
      ...iterateLineClassifications([
        msg(0, "assistant", [text("thinking")]),
        tool(1, [text("result")]),
        msg(2, "assistant", [text("done")]),
      ]),
    ];
    expect(rows.map((r) => r.visible)).toEqual([true, false, true]);
    expect(rows.map((r) => r.mergedIndex)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.opensUnit)).toEqual([true, false, false]);
  });
});

describe("groupLogicalUnits", () => {
  it("merges consecutive same-role entries and folds tool_result parts", () => {
    const units = groupLogicalUnits([
      msg(0, "user", [text("run it")], { entryId: "u0" }),
      msg(1, "assistant", [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ]),
      tool(2, [text("file-a")]),
      msg(3, "assistant", [text("done")]),
    ]);

    expect(units).toHaveLength(2);
    expect(units[0]!.messageIndex).toBe(0);
    expect(units[0]!.role).toBe("user");
    expect(units[0]!.messageId).toBe("u0");
    expect(units[0]!.parts.map((p) => p.seq)).toEqual([0]);

    expect(units[1]!.messageIndex).toBe(1);
    expect(units[1]!.role).toBe("assistant");
    // tool_result line 2 folds into the open assistant unit, keeping its seq.
    expect(units[1]!.parts.map((p) => p.seq)).toEqual([1, 2, 3]);
  });

  it("carries the parsed command block as the command unit's content", () => {
    const units = groupLogicalUnits([
      msg(0, "user", [text("hi")]),
      msg(1, "user", [text("/commit now")]),
      msg(2, "user", [text("follow-up")]),
    ]);

    expect(units).toHaveLength(2);
    expect(units[1]!.parts.map((p) => p.seq)).toEqual([1, 2]);
    expect(units[1]!.parts[0]!.content).toEqual([
      { type: "command", name: "/commit", args: "now" },
    ]);
  });

  it("drops a tool_result with no open unit", () => {
    const units = groupLogicalUnits([
      tool(0, [text("orphan")]),
      msg(1, "user", [text("hello")]),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]!.role).toBe("user");
    expect(units[0]!.messageIndex).toBe(0);
  });
});
