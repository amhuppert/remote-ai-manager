import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { injectClaudeTerminalOverflow } from "./claude-terminal-overflow";

describe("explicit terminal overflow fault", () => {
  it("preserves the actual success frame and appends only enough whitespace for 6145 UTF-8 bytes", () => {
    const original = {
      type: "result",
      subtype: "success",
      result: '{"plan":["再開🚧"]}',
      session_id: "original-provider-ref",
      user_message_uuid: "original-correlation",
      total_cost_usd: 0.123,
      modelUsage: { original: { inputTokens: 19 } },
    };
    const before = structuredClone(original);
    const output = injectClaudeTerminalOverflow(original, {
      capture: true,
      armed: true,
      limitBytes: 6144,
    });
    expect(Buffer.byteLength(output.message.result, "utf8")).toBe(6145);
    expect(output.message.result.slice(original.result.length)).toMatch(/^ +$/);
    expect(JSON.parse(output.message.result)).toEqual(
      JSON.parse(original.result),
    );
    expect(original).toEqual(before);
    expect(output.message).toMatchObject({
      session_id: before.session_id,
      user_message_uuid: before.user_message_uuid,
      total_cost_usd: before.total_cost_usd,
      modelUsage: before.modelUsage,
      type: before.type,
      subtype: before.subtype,
    });
    expect(output.message).toMatchObject({
      cc_probe_fault: {
        source: "explicit-probe-fault",
        kind: "raw-terminal-output-overflow",
        providerAuthoredOversize: false,
      },
    });
    expect(JSON.parse(output.originalFrameJson ?? "null")).toEqual(before);
    expect(output.marker).toMatchObject({
      limitBytes: 6144,
      originalResultBytes: Buffer.byteLength(original.result, "utf8"),
      forwardedResultBytes: 6145,
      originalResultSha256: createHash("sha256")
        .update(original.result)
        .digest("hex"),
    });
  });
  it("does not transform unarmed, ordinary, non-success, or already oversized frames", () => {
    for (const [message, context] of [
      [
        { type: "result", subtype: "success", result: "ok" },
        { capture: false, armed: true, limitBytes: 6144 },
      ],
      [
        { type: "result", subtype: "success", result: "ok" },
        { capture: true, armed: false, limitBytes: 6144 },
      ],
      [
        { type: "result", subtype: "error_during_execution", result: "error" },
        { capture: true, armed: true, limitBytes: 6144 },
      ],
      [
        { type: "assistant", result: "text" },
        { capture: true, armed: true, limitBytes: 6144 },
      ],
      [
        { type: "result", subtype: "success", result: "x".repeat(6145) },
        { capture: true, armed: true, limitBytes: 6144 },
      ],
    ] as const) {
      const output = injectClaudeTerminalOverflow(message, context);
      expect(output.message).toBe(message);
      expect(output.marker).toBeNull();
      expect(output.originalFrameJson).toBeNull();
    }
  });
});
