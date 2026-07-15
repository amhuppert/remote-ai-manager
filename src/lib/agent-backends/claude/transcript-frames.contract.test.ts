import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import type { ConversationBackendEvent } from "../conversation";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  createClaudeMessageInterpreter,
  createClaudeExternalTurnInterpreter,
} from "./process-message";
import { conversationTranscriptFrame } from "../transcript";

/**
 * Transcript-format contract: byte-stable JSONL frames for the Claude
 * conversation transcript (consolidated plan §Phase 1.4 pin).
 *
 * Each case pins the EXACT serialized bytes of the frame appended to the
 * conversation JSONL for a given SDK message, driven through the production
 * pipeline the actor uses: interpreter → `transcript_entry` envelope →
 * `conversationTranscriptFrame`. These bytes are the on-disk contract
 * consumed by readTranscript, fork's `resumeSessionAt` (assistant `uuid`),
 * and `projectClaudeStoredToolResultBlocks` (tool_result `raw`). The
 * interpretation seam may move between modules; the frames may not change.
 */

const FIXED_TIME = "2026-07-12T10:00:00.000Z";

/** Drive SDK messages through the per-turn interpreter and materialize the
 *  frames exactly the way the actor persists them. */
async function framesFor(messages: unknown[]): Promise<TranscriptEntry[]> {
  const frames: TranscriptEntry[] = [];
  const interpreter = createClaudeMessageInterpreter({
    onEvent: (event: ConversationBackendEvent) => {
      if (event.type === "transcript_entry") {
        frames.push(conversationTranscriptFrame(event.entry));
      }
    },
  });
  for (const message of messages) {
    interpreter.handleMessage(message as never);
  }
  await interpreter.flush();
  return frames;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(FIXED_TIME));
});

afterEach(() => {
  vi.useRealTimers();
});

function expectBytes(actual: TranscriptEntry, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

describe("Claude conversation transcript frames (byte-stable pin)", () => {
  it("system init → narrowed {subtype, session_id} raw", async () => {
    const frames = await framesFor([
      { type: "system", subtype: "init", session_id: "sess-1", cwd: "/w" },
    ]);
    expect(frames).toHaveLength(1);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "system",
      raw: { subtype: "init", session_id: "sess-1" },
    });
  });

  it("non-init system message → verbatim raw", async () => {
    const msg = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 10, post_tokens: 2 },
      session_id: "sess-1",
    };
    const frames = await framesFor([msg]);
    expect(frames).toHaveLength(1);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "system",
      raw: msg,
    });
  });

  it("assistant message → one frame with ALL mapped blocks + uuid", async () => {
    const frames = await framesFor([
      {
        type: "assistant",
        uuid: "uuid-a1",
        message: {
          content: [
            {
              type: "thinking",
              thinking: "Considering options.",
              signature: "sig",
            },
            { type: "redacted_thinking", data: "blob" },
            { type: "text", text: "Answer." },
            { type: "tool_use", id: "t1", name: "Read", input: { p: 1 } },
          ],
        },
      },
    ]);
    expect(frames).toHaveLength(1);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "assistant",
      role: "assistant",
      content: [
        { type: "thinking", text: "Considering options." },
        { type: "thinking", text: "", redacted: true },
        { type: "text", text: "Answer." },
        { type: "tool_use", id: "t1", name: "Read", input: { p: 1 } },
      ],
      uuid: "uuid-a1",
    });
  });

  it("user (tool result) message → type tool_result with verbatim raw", async () => {
    const msg = {
      type: "user",
      session_id: "sess-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
      },
      parent_tool_use_id: null,
    };
    const frames = await framesFor([msg]);
    expect(frames).toHaveLength(1);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "tool_result",
      raw: msg,
    });
  });

  it("result success after streamed content → verbatim raw, single result frame", async () => {
    const msg = {
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      total_cost_usd: 0.05,
      num_turns: 3,
      result: "Final text",
      is_error: false,
    };
    const frames = await framesFor([
      {
        type: "assistant",
        uuid: "u-pre",
        message: { content: [{ type: "text", text: "already streamed" }] },
      },
      msg,
    ]);
    expect(frames).toHaveLength(2);
    expectBytes(frames[1]!, {
      timestamp: FIXED_TIME,
      type: "result",
      raw: msg,
    });
  });

  it("result success with no prior content → same verbatim result frame", async () => {
    const msg = {
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      total_cost_usd: 0.01,
      num_turns: 1,
      result: "Fallback answer",
      is_error: false,
    };
    const frames = await framesFor([msg]);
    expect(frames).toHaveLength(1);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "result",
      raw: msg,
    });
  });

  it("result error → verbatim raw", async () => {
    const msg = {
      type: "result",
      subtype: "error_max_turns",
      session_id: "sess-1",
      total_cost_usd: 0.2,
      num_turns: 50,
      is_error: true,
    };
    const frames = await framesFor([msg]);
    expect(frames).toHaveLength(1);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "result",
      raw: msg,
    });
  });

  it("unknown message type → passthrough type with verbatim raw", async () => {
    const msg = { type: "stream_event", event: { delta: "x" } };
    const frames = await framesFor([msg]);
    expect(frames).toHaveLength(1);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "stream_event",
      raw: msg,
    });
  });
});

describe("external-turn wake-marker notice frame (byte-stable pin)", () => {
  async function externalFrames(
    messages: unknown[],
  ): Promise<TranscriptEntry[]> {
    const frames: TranscriptEntry[] = [];
    const interpreter = createClaudeExternalTurnInterpreter({
      onEvent: (event: ConversationBackendEvent) => {
        if (event.type === "transcript_entry") {
          frames.push(conversationTranscriptFrame(event.entry));
        }
      },
    });
    for (const message of messages) {
      interpreter.handleMessage(message as never);
    }
    await interpreter.flush();
    return frames;
  }

  it("notice frame precedes the first assistant frame, without a task summary", async () => {
    const frames = await externalFrames([
      {
        type: "assistant",
        uuid: "u1",
        message: { content: [{ type: "text", text: "woke" }] },
      },
    ]);
    expect(frames).toHaveLength(2);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "notice",
      role: "notice",
      content: [
        {
          type: "text",
          text: "Agent continued autonomously after background-task activity.",
        },
      ],
    });
    expectBytes(frames[1]!, {
      timestamp: FIXED_TIME,
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "woke" }],
      uuid: "u1",
    });
  });

  it("notice frame carries the last settled task summary", async () => {
    const notification = {
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      summary: "build finished",
      session_id: "sess-1",
    };
    const frames = await externalFrames([
      notification,
      {
        type: "assistant",
        uuid: "u2",
        message: { content: [{ type: "text", text: "done" }] },
      },
    ]);
    // system frame for the notification + notice + assistant
    expect(frames).toHaveLength(3);
    expectBytes(frames[0]!, {
      timestamp: FIXED_TIME,
      type: "system",
      raw: notification,
    });
    expectBytes(frames[1]!, {
      timestamp: FIXED_TIME,
      type: "notice",
      role: "notice",
      content: [
        {
          type: "text",
          text: "Agent continued autonomously after background-task activity (build finished).",
        },
      ],
    });
    expectBytes(frames[2]!, {
      timestamp: FIXED_TIME,
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      uuid: "u2",
    });
  });
});
