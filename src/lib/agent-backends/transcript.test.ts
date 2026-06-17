import { describe, expect, it } from "vitest";
import { toRawTranscriptEntries } from "./transcript";

describe("toRawTranscriptEntries", () => {
  it("wraps each codex item in a lossless envelope, preserving order and raw payload", () => {
    const items = [
      { type: "reasoning", text: "thinking about the AC" },
      { type: "command_execution", command: "npm run verify", exitCode: 0 },
      { type: "agent_message", text: "GO" },
    ];

    const entries = toRawTranscriptEntries("codex", items);

    expect(entries).toEqual([
      { seq: 0, backend: "codex", type: "reasoning", raw: items[0] },
      { seq: 1, backend: "codex", type: "command_execution", raw: items[1] },
      { seq: 2, backend: "codex", type: "agent_message", raw: items[2] },
    ]);
    // raw must be the exact same reference — no copy, no loss.
    expect(entries[1]!.raw).toBe(items[1]);
  });

  it("wraps claude SDK messages with their message type", () => {
    const messages = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
    ];

    const entries = toRawTranscriptEntries("claude", messages);

    expect(
      entries.map((e) => ({ seq: e.seq, backend: e.backend, type: e.type })),
    ).toEqual([
      { seq: 0, backend: "claude", type: "assistant" },
      { seq: 1, backend: "claude", type: "user" },
    ]);
  });

  it("returns an empty array for no items", () => {
    expect(toRawTranscriptEntries("codex", [])).toEqual([]);
  });

  it('falls back to type "unknown" when an item has no string type', () => {
    const items = [{ noType: true }, "bare-string", 42, null];

    const entries = toRawTranscriptEntries("codex", items);

    expect(entries.map((e) => e.type)).toEqual([
      "unknown",
      "unknown",
      "unknown",
      "unknown",
    ]);
    expect(entries[0]!.raw).toBe(items[0]);
    expect(entries[3]!.raw).toBeNull();
  });
});
