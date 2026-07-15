import { describe, expect, it } from "vitest";
import {
  conversationTranscriptFrame,
  toRawTranscriptEntries,
} from "./transcript";

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

describe("conversationTranscriptFrame", () => {
  it("returns a frame-shaped payload as the SAME object (byte-exact passthrough)", () => {
    const frame = {
      timestamp: "2026-07-12T10:00:00.000Z",
      type: "assistant",
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "hello" }],
      uuid: "u1",
      raw: { anything: true },
    };

    const resolved = conversationTranscriptFrame({
      seq: 0,
      backend: "claude",
      type: "assistant",
      raw: frame,
    });

    expect(resolved).toBe(frame);
  });

  it("accepts a minimal forensic frame ({timestamp, type, raw})", () => {
    const frame = {
      timestamp: "2026-07-12T10:00:00.000Z",
      type: "result",
      raw: { type: "result", subtype: "success" },
    };

    expect(
      conversationTranscriptFrame({
        seq: 3,
        backend: "claude",
        type: "result",
        raw: frame,
      }),
    ).toBe(frame);
  });

  it("wraps a non-frame payload generically, keeping the payload untouched", () => {
    const alien = { type: "testfake_frame", marker: "m-1" };

    const resolved = conversationTranscriptFrame({
      seq: 0,
      backend: "codex",
      type: "testfake_frame",
      raw: alien,
    });

    expect(resolved.type).toBe("testfake_frame");
    expect(typeof resolved.timestamp).toBe("string");
    expect(resolved.raw).toBe(alien);
  });

  it("rejects a payload whose content blocks are malformed (falls back to the generic wrap)", () => {
    const invalid = {
      timestamp: "2026-07-12T10:00:00.000Z",
      type: "assistant",
      role: "assistant",
      content: [{ bogus: true }],
    };

    const resolved = conversationTranscriptFrame({
      seq: 0,
      backend: "claude",
      type: "assistant",
      raw: invalid,
    });

    expect(resolved).not.toBe(invalid);
    expect(resolved.raw).toBe(invalid);
  });
});
