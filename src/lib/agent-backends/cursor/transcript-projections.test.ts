import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { elementAt } from "@/lib/shared/testing/element-at";
import {
  appendTranscriptEntry,
  type TranscriptEntry,
} from "@/lib/prompt/transcript";
import { conversationTranscriptFrame } from "../transcript";
import {
  projectStoredToolResultBlocks,
  projectTranscriptUsage,
} from "../transcript-projections";
import {
  cursorTranscriptEntryId,
  projectCursorNativeEvent,
  type CursorNativeEvent,
} from "./transcript-projections";
import { decodeNativePayload, encodeNativePayload } from "./worker/ipc";

const TEST_DIR = path.join("/tmp", `cc-cursor-projections-${process.pid}`);

beforeEach(async () => {
  await mkdir(path.join(TEST_DIR, "transcripts"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

const CONTEXT = {
  conversationId: "conv-1",
  timestamp: "2026-08-21T00:00:00.000Z",
};

/**
 * Drives one native SDK object through the exact path production uses: the
 * worker's tagged encoding, the IPC hop's JSON round trip, and the parent's
 * decode. Projection therefore never sees a value the channel could not carry.
 */
function forward(
  eventType: string,
  native: unknown,
  overrides: { runId?: string; eventIndex?: number } = {},
): CursorNativeEvent {
  const encoded = encodeNativePayload(eventType, native);
  if (!encoded.ok) {
    throw new Error(`fixture failed to encode: ${encoded.violation}`);
  }
  const decoded = decodeNativePayload(
    eventType,
    JSON.parse(JSON.stringify(encoded.payload)) as string,
  );
  if (!decoded.ok) {
    throw new Error(`fixture failed to decode: ${decoded.violation}`);
  }
  return {
    runId: overrides.runId ?? "run-1",
    eventIndex: overrides.eventIndex ?? 0,
    eventType,
    tagged: decoded.tagged,
    decoded: decoded.value,
  };
}

/** Persists the projected frame and reads the line back off disk. */
async function persistAndReload(
  conversationId: string,
  frame: TranscriptEntry,
): Promise<Record<string, unknown>> {
  await appendTranscriptEntry(conversationId, frame, TEST_DIR);
  const filePath = path.join(
    TEST_DIR,
    "transcripts",
    `${conversationId}.jsonl`,
  );
  const lines = (await readFile(filePath, "utf-8")).trim().split("\n");
  return JSON.parse(elementAt(lines, lines.length - 1)) as Record<
    string,
    unknown
  >;
}

describe("cursor native event envelopes", () => {
  it("reloads a decoded native payload structurally equal to what the SDK delivered", async () => {
    const native = {
      type: "assistant",
      agent_id: "agent-7",
      run_id: "run-1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
      },
      edges: {
        absent: undefined,
        notANumber: Number.NaN,
        positive: Number.POSITIVE_INFINITY,
        negative: Number.NEGATIVE_INFINITY,
        huge: 9007199254740993n,
        bytes: Buffer.from([0, 1, 2, 250]),
      },
    };

    const projection = projectCursorNativeEvent(
      forward("assistant", native),
      CONTEXT,
    );
    const line = await persistAndReload(
      "conv-lossless",
      conversationTranscriptFrame(projection.entry),
    );

    const reloaded = decodeNativePayload("assistant", JSON.stringify(line.raw));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value).toStrictEqual(native);
  });

  it("persists an unknown native type with unknown fields and projects no content", async () => {
    const native = {
      type: "some_future_event",
      agent_id: "agent-7",
      unknownField: { nested: [1, "two", null] },
    };

    const projection = projectCursorNativeEvent(
      forward("some_future_event", native),
      CONTEXT,
    );
    expect(projection.blocks).toEqual([]);
    expect(projection.entry.type).toBe("some_future_event");

    const line = await persistAndReload(
      "conv-unknown",
      conversationTranscriptFrame(projection.entry),
    );
    const reloaded = decodeNativePayload(
      "some_future_event",
      JSON.stringify(line.raw),
    );
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value).toStrictEqual(native);
  });

  it("preserves the SDK's truncation markers rather than repairing them", async () => {
    const native = {
      type: "tool_call",
      agent_id: "agent-7",
      run_id: "run-1",
      call_id: "call-9",
      name: "read",
      status: "completed",
      args: { path: "/repo/big.ts" },
      result: "first 200 lines…",
      truncated: { args: false, result: true },
    };

    const projection = projectCursorNativeEvent(
      forward("tool_call", native),
      CONTEXT,
    );
    const line = await persistAndReload(
      "conv-truncated",
      conversationTranscriptFrame(projection.entry),
    );
    const reloaded = decodeNativePayload("tool_call", JSON.stringify(line.raw));
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value).toStrictEqual(native);
  });

  it("stamps every persisted entry with its run-scoped id", () => {
    const projection = projectCursorNativeEvent(
      forward(
        "status",
        { type: "status", status: "RUNNING" },
        {
          runId: "run-42",
          eventIndex: 7,
        },
      ),
      CONTEXT,
    );
    const frame = conversationTranscriptFrame(projection.entry);
    expect(frame.id).toBe(cursorTranscriptEntryId("conv-1", "run-42", 7));
  });
});

describe("cursor content projection", () => {
  it("projects assistant text and named tool_use blocks", () => {
    const projection = projectCursorNativeEvent(
      forward("assistant", {
        type: "assistant",
        agent_id: "a",
        run_id: "r",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "on it" },
            {
              type: "tool_use",
              id: "call-1",
              name: "edit",
              input: { path: "a.ts" },
            },
          ],
        },
      }),
      CONTEXT,
    );

    expect(projection.blocks).toEqual([
      { type: "text", text: "on it" },
      {
        type: "tool_use",
        id: "call-1",
        name: "edit",
        input: { path: "a.ts" },
      },
    ]);
  });

  it("projects a thinking event as a thinking block", () => {
    const projection = projectCursorNativeEvent(
      forward("thinking", {
        type: "thinking",
        agent_id: "a",
        run_id: "r",
        text: "considering the edit",
      }),
      CONTEXT,
    );
    expect(projection.blocks).toEqual([
      { type: "thinking", text: "considering the edit" },
    ]);
  });

  it("projects a running tool call as a named tool_use block carrying its call id", () => {
    const projection = projectCursorNativeEvent(
      forward("tool_call", {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-5",
        name: "shell",
        status: "running",
        args: { command: "ls" },
      }),
      CONTEXT,
    );
    expect(projection.blocks).toEqual([
      {
        type: "tool_use",
        id: "call-5",
        name: "shell",
        input: { command: "ls" },
      },
    ]);
  });

  it.each([
    ["read", "file read"],
    ["edit", "file edit/write"],
    ["delete", "file delete"],
    ["grep", "search"],
    ["ls", "listing"],
    ["shell", "shell"],
    ["mcp", "MCP"],
  ])(
    "projects a completed %s call as a tool_result block preserving its call id",
    (name) => {
      const projection = projectCursorNativeEvent(
        forward("tool_call", {
          type: "tool_call",
          agent_id: "a",
          run_id: "r",
          call_id: `call-${name}`,
          name,
          status: "completed",
          result: `${name} output`,
        }),
        CONTEXT,
      );
      expect(projection.blocks).toEqual([
        {
          type: "tool_result",
          tool_use_id: `call-${name}`,
          content: `${name} output`,
        },
      ]);
    },
  );

  it("marks an errored tool call's result as an error", () => {
    const projection = projectCursorNativeEvent(
      forward("tool_call", {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-err",
        name: "shell",
        status: "error",
        result: "exit 1",
      }),
      CONTEXT,
    );
    expect(projection.blocks).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call-err",
        content: "exit 1",
        isError: true,
      },
    ]);
  });

  it("projects no content for the SDK's echo of the user prompt", () => {
    const projection = projectCursorNativeEvent(
      forward("user", {
        type: "user",
        agent_id: "a",
        run_id: "r",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
      CONTEXT,
    );
    expect(projection.blocks).toEqual([]);
  });
});

describe("cursor decoders registered in the shared projection registries", () => {
  it("decodes a reloaded tool_result frame back into its neutral blocks", async () => {
    const projection = projectCursorNativeEvent(
      forward("tool_call", {
        type: "tool_call",
        agent_id: "a",
        run_id: "r",
        call_id: "call-77",
        name: "delete",
        status: "error",
        result: { message: "permission denied" },
      }),
      CONTEXT,
    );
    const frame = conversationTranscriptFrame(projection.entry);
    expect(frame.type).toBe("tool_result");

    const line = await persistAndReload("conv-tool", frame);
    expect(projectStoredToolResultBlocks(line, new Map())).toEqual([
      {
        type: "tool_result",
        tool_use_id: "call-77",
        content: JSON.stringify({ message: "permission denied" }),
        isError: true,
      },
    ]);
  });

  it("reports a reloaded usage frame with its lineage and no fabricated cost", async () => {
    const projection = projectCursorNativeEvent(
      forward("usage", {
        type: "usage",
        agent_id: "agent-lineage",
        run_id: "r",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
          totalTokens: 14,
          reasoningTokens: 3,
        },
      }),
      CONTEXT,
    );

    const line = await persistAndReload(
      "conv-usage",
      conversationTranscriptFrame(projection.entry),
    );
    expect(projectTranscriptUsage(line)).toEqual({
      lineageId: "agent-lineage",
      cumulativeCostUsd: null,
      numTurns: null,
    });
  });
});
