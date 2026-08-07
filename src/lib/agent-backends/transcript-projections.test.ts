import { describe, expect, it } from "vitest";
import {
  projectStoredToolResultBlocks,
  projectTranscriptUsage,
} from "./transcript-projections";

/** The exact JSONL frame shape processMessage persists for SDK tool results. */
function storedToolResultFrame(
  toolUseId: string,
  content: unknown,
  isError?: boolean,
): { type: string; raw: unknown } {
  return {
    type: "tool_result",
    raw: {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            tool_use_id: toolUseId,
            type: "tool_result",
            content,
            ...(isError !== undefined ? { is_error: isError } : {}),
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: "sess-1",
      uuid: "uuid-1",
    },
  };
}

const NO_TOOLS: ReadonlyMap<string, string> = new Map();

describe("projectStoredToolResultBlocks", () => {
  it("decodes the production Claude frame shape and recovers metrics via the tool_use pairing", () => {
    const blocks = projectStoredToolResultBlocks(
      storedToolResultFrame("t1", "     1\tconst a = 1;\n     2\tconst b = 2;"),
      new Map([["t1", "Read"]]),
    );
    expect(blocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "     1\tconst a = 1;\n     2\tconst b = 2;",
        metrics: { lineCount: 2 },
      },
    ]);
  });

  it("maps is_error and array-form content (text blocks joined, tool_reference ignored)", () => {
    const blocks = projectStoredToolResultBlocks(
      storedToolResultFrame(
        "t9",
        [
          { type: "text", text: "command failed" },
          { type: "tool_reference", id: "ref-1" },
          { type: "text", text: "exit status 1" },
        ],
        true,
      ),
      NO_TOOLS,
    );
    expect(blocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t9",
        content: "command failed\nexit status 1",
        isError: true,
      },
    ]);
  });

  it("omits the content field for empty-string content", () => {
    const blocks = projectStoredToolResultBlocks(
      storedToolResultFrame("t2", ""),
      NO_TOOLS,
    );
    expect(blocks).toEqual([{ type: "tool_result", tool_use_id: "t2" }]);
  });

  it("decodes the legacy bare-block raw shape", () => {
    const blocks = projectStoredToolResultBlocks(
      { raw: { tool_use_id: "abc" } },
      NO_TOOLS,
    );
    expect(blocks).toEqual([{ type: "tool_result", tool_use_id: "abc" }]);
  });

  it("decodes a top-level content array without a message wrapper", () => {
    const blocks = projectStoredToolResultBlocks(
      {
        raw: {
          content: [
            { type: "tool_result", tool_use_id: "top-1", content: "ok" },
          ],
        },
      },
      NO_TOOLS,
    );
    expect(blocks).toEqual([
      { type: "tool_result", tool_use_id: "top-1", content: "ok" },
    ]);
  });

  it("returns a generic block for unrecognizable payloads instead of throwing", () => {
    const generic = [
      {
        type: "tool_result",
        tool_use_id: "",
        content: "[unrecognized tool_result payload]",
      },
    ];
    expect(
      projectStoredToolResultBlocks({ raw: "not an object" }, NO_TOOLS),
    ).toEqual(generic);
    expect(projectStoredToolResultBlocks({}, NO_TOOLS)).toEqual(generic);
    expect(
      projectStoredToolResultBlocks(
        { raw: { message: { content: [{ type: "unrelated" }] } } },
        NO_TOOLS,
      ),
    ).toEqual(generic);
  });
});

describe("projectTranscriptUsage", () => {
  it("projects a Claude result frame's cumulative lineage counters", () => {
    const usage = projectTranscriptUsage({
      raw: {
        type: "result",
        session_id: "lineage-a",
        total_cost_usd: 23.5,
        num_turns: 41,
      },
    });
    expect(usage).toEqual({
      lineageId: "lineage-a",
      cumulativeCostUsd: 23.5,
      numTurns: 41,
    });
  });

  it("defaults a missing session id to the unknown lineage and a missing num_turns to null", () => {
    const usage = projectTranscriptUsage({
      raw: { total_cost_usd: 1.25 },
    });
    expect(usage).toEqual({
      lineageId: "unknown",
      cumulativeCostUsd: 1.25,
      numTurns: null,
    });
  });

  it("returns null for frames without a numeric cumulative cost", () => {
    expect(
      projectTranscriptUsage({ raw: { total_cost_usd: "1.25" } }),
    ).toBeNull();
    expect(projectTranscriptUsage({ raw: { type: "system" } })).toBeNull();
    expect(projectTranscriptUsage({ raw: [1, 2] })).toBeNull();
    expect(projectTranscriptUsage({ raw: null })).toBeNull();
    expect(projectTranscriptUsage({})).toBeNull();
  });

  it("projects a Codex result frame's thread-cumulative counters", () => {
    // The exact raw shape codexConversationTranscriptProjection persists.
    const usage = projectTranscriptUsage({
      raw: {
        backend: "codex",
        backendRef: { backend: "codex", ref: "thread-abc" },
        durationMs: 568715,
        numTurns: 1,
        contextTokens: 5854973,
        contextWindowMax: null,
        costUsd: 4.373131,
        aborted: false,
        error: null,
      },
    });
    expect(usage).toEqual({
      lineageId: "thread-abc",
      cumulativeCostUsd: 4.373131,
      numTurns: 1,
    });
  });

  it("declines Codex frames without a thread ref or numeric cost", () => {
    expect(
      projectTranscriptUsage({
        raw: { backend: "codex", backendRef: null, costUsd: 1.5 },
      }),
    ).toBeNull();
    expect(
      projectTranscriptUsage({
        raw: {
          backend: "codex",
          backendRef: { backend: "codex", ref: "thread-abc" },
          costUsd: null,
        },
      }),
    ).toBeNull();
    expect(
      projectTranscriptUsage({
        raw: {
          subtype: "init",
          backend: "codex",
          thread_id: "thread-abc",
        },
      }),
    ).toBeNull();
  });
});
