import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  addClient,
  removeClient,
  broadcast,
  getClientCount,
  replayFramesSince,
  _resetForTesting,
} from "./sse-broadcaster";
import type { ConversationStatusEvent } from "@/types";
import { conversationStatusEventSchema } from "./schemas";
import { _resetLoggerForTesting } from "./logging/logger";

const TEST_EVENT: ConversationStatusEvent = {
  type: "conversation-status",
  projectName: "my-project",
  sessionName: "feature-x",
  conversationId: "conv-123",
  status: "running",
};

function makeController(): {
  controller: ReadableStreamDefaultController;
  chunks: Uint8Array[];
} {
  const chunks: Uint8Array[] = [];
  let ctrl!: ReadableStreamDefaultController;
  new ReadableStream({
    start(c) {
      ctrl = c;
    },
  });
  // Wrap enqueue to capture output
  const originalEnqueue = ctrl.enqueue.bind(ctrl);
  ctrl.enqueue = (chunk: Uint8Array) => {
    chunks.push(chunk);
    originalEnqueue(chunk);
  };
  return { controller: ctrl, chunks };
}

beforeEach(() => {
  _resetForTesting();
});

describe("sse-broadcaster", () => {
  it("starts with zero clients", () => {
    expect(getClientCount()).toBe(0);
  });

  it("addClient increments client count", () => {
    const { controller } = makeController();
    addClient(controller);
    expect(getClientCount()).toBe(1);
  });

  it("removeClient decrements client count", () => {
    const { controller } = makeController();
    addClient(controller);
    expect(getClientCount()).toBe(1);
    removeClient(controller);
    expect(getClientCount()).toBe(0);
  });

  it("removeClient is idempotent for unknown controllers", () => {
    const { controller } = makeController();
    removeClient(controller);
    expect(getClientCount()).toBe(0);
  });

  it("broadcast with zero clients does not throw", () => {
    expect(() => broadcast(TEST_EVENT)).not.toThrow();
  });

  it("broadcast sends SSE-formatted data to all clients", () => {
    const client1 = makeController();
    const client2 = makeController();
    addClient(client1.controller);
    addClient(client2.controller);

    broadcast(TEST_EVENT);

    const decoder = new TextDecoder();
    const frame1 = decoder.decode(client1.chunks[0]);
    const frame2 = decoder.decode(client2.chunks[0]);

    expect(frame1).toMatch(/^id: 1\nevent: conversation-status\ndata: /);
    expect(frame1.endsWith("\n\n")).toBe(true);
    expect(frame2).toBe(frame1);

    const dataLine = frame1.split("\n")[2]!.slice("data: ".length);
    const parsed = JSON.parse(dataLine) as Record<string, unknown>;
    expect(parsed).toMatchObject(TEST_EVENT);
    expect(typeof parsed["_sentAt"]).toBe("number");
  });

  it("broadcast embeds _sentAt in the data envelope", () => {
    const { controller, chunks } = makeController();
    addClient(controller);

    const before = Date.now();
    broadcast(TEST_EVENT);
    const after = Date.now();

    const decoder = new TextDecoder();
    const frame = decoder.decode(chunks[0]);
    const dataLine = frame.split("\n")[2]!.slice("data: ".length);
    const parsed = JSON.parse(dataLine) as Record<string, unknown>;

    const sentAt = parsed["_sentAt"];
    expect(typeof sentAt).toBe("number");
    expect(sentAt as number).toBeGreaterThanOrEqual(before);
    expect(sentAt as number).toBeLessThanOrEqual(after);
  });

  it("broadcast removes client whose enqueue throws", () => {
    const { controller: goodCtrl, chunks } = makeController();
    const { controller: badCtrl } = makeController();

    addClient(goodCtrl);
    addClient(badCtrl);
    expect(getClientCount()).toBe(2);

    // Make the bad controller throw on enqueue
    badCtrl.enqueue = () => {
      throw new Error("stream closed");
    };

    broadcast(TEST_EVENT);

    // Bad client should be removed
    expect(getClientCount()).toBe(1);
    // Good client should still receive the event
    const decoder = new TextDecoder();
    expect(decoder.decode(chunks[0])).toContain("conversation-status");
  });

  it("getClientCount reflects accurate count after multiple operations", () => {
    const c1 = makeController();
    const c2 = makeController();
    const c3 = makeController();

    addClient(c1.controller);
    addClient(c2.controller);
    addClient(c3.controller);
    expect(getClientCount()).toBe(3);

    removeClient(c2.controller);
    expect(getClientCount()).toBe(2);

    removeClient(c1.controller);
    removeClient(c3.controller);
    expect(getClientCount()).toBe(0);
  });
});

describe("sse-broadcaster seq + replay buffer", () => {
  const ORIGINAL_BUFFER_ENV = process.env.CC_SSE_REPLAY_BUFFER_SIZE;

  afterEach(() => {
    if (ORIGINAL_BUFFER_ENV === undefined) {
      delete process.env.CC_SSE_REPLAY_BUFFER_SIZE;
    } else {
      process.env.CC_SSE_REPLAY_BUFFER_SIZE = ORIGINAL_BUFFER_ENV;
    }
  });

  it("seq increments by 1 per broadcast", () => {
    const { controller, chunks } = makeController();
    addClient(controller);

    broadcast(TEST_EVENT);
    broadcast(TEST_EVENT);
    broadcast(TEST_EVENT);

    const decoder = new TextDecoder();
    expect(decoder.decode(chunks[0])).toMatch(/^id: 1\n/);
    expect(decoder.decode(chunks[1])).toMatch(/^id: 2\n/);
    expect(decoder.decode(chunks[2])).toMatch(/^id: 3\n/);
  });

  it("id: line is the first line of the frame", () => {
    const { controller, chunks } = makeController();
    addClient(controller);

    broadcast(TEST_EVENT);

    const decoder = new TextDecoder();
    const frame = decoder.decode(chunks[0]);
    const firstLine = frame.split("\n")[0];
    expect(firstLine).toBe("id: 1");
  });

  it("ring buffer evicts oldest entries when size exceeds CC_SSE_REPLAY_BUFFER_SIZE", () => {
    process.env.CC_SSE_REPLAY_BUFFER_SIZE = "3";
    _resetForTesting();

    broadcast(TEST_EVENT); // seq 1
    broadcast(TEST_EVENT); // seq 2
    broadcast(TEST_EVENT); // seq 3
    broadcast(TEST_EVENT); // seq 4 (evicts 1)
    broadcast(TEST_EVENT); // seq 5 (evicts 2)

    // Buffer now holds seq 3,4,5. Asking from the oldest-minus-one (2) is the
    // boundary where the catch-up is still complete.
    const all = replayFramesSince(2);
    expect(all).toHaveLength(3);
    const decoder = new TextDecoder();
    expect(decoder.decode(all[0])).toMatch(/^id: 3\n/);
    expect(decoder.decode(all[1])).toMatch(/^id: 4\n/);
    expect(decoder.decode(all[2])).toMatch(/^id: 5\n/);
  });

  it("replayFramesSince(0) returns all buffered frames", () => {
    broadcast(TEST_EVENT);
    broadcast(TEST_EVENT);
    broadcast(TEST_EVENT);

    const frames = replayFramesSince(0);
    expect(frames).toHaveLength(3);
  });

  it("replayFramesSince(currentSeq) returns empty", () => {
    broadcast(TEST_EVENT);
    broadcast(TEST_EVENT);
    broadcast(TEST_EVENT);

    expect(replayFramesSince(3)).toHaveLength(0);
  });

  it("replayFramesSince(currentSeq - N) returns up to N frames", () => {
    for (let i = 0; i < 150; i++) {
      broadcast(TEST_EVENT);
    }

    const frames = replayFramesSince(50);
    expect(frames).toHaveLength(100);
    const decoder = new TextDecoder();
    expect(decoder.decode(frames[0])).toMatch(/^id: 51\n/);
    expect(decoder.decode(frames[99])).toMatch(/^id: 150\n/);
  });

  it("replayFramesSince returns empty when lastEventId is older than buffer's oldest (gap)", () => {
    process.env.CC_SSE_REPLAY_BUFFER_SIZE = "3";
    _resetForTesting();

    broadcast(TEST_EVENT); // seq 1
    broadcast(TEST_EVENT); // seq 2
    broadcast(TEST_EVENT); // seq 3
    broadcast(TEST_EVENT); // seq 4 (evicts 1; buffer holds 2,3,4)

    // lastEventId = 0 implies the client expects to receive seq 1, but seq 1
    // has been evicted. The replay window has a gap, so signal "cannot
    // catch up" by returning empty instead of a partial replay.
    expect(replayFramesSince(0)).toHaveLength(0);
  });

  it("replayFramesSince returns frames when lastEventId + 1 equals the oldest buffered seq (no gap)", () => {
    process.env.CC_SSE_REPLAY_BUFFER_SIZE = "3";
    _resetForTesting();

    broadcast(TEST_EVENT); // seq 1
    broadcast(TEST_EVENT); // seq 2
    broadcast(TEST_EVENT); // seq 3
    broadcast(TEST_EVENT); // seq 4 (evicts 1; buffer holds 2,3,4)

    const frames = replayFramesSince(1);
    expect(frames).toHaveLength(3);
    const decoder = new TextDecoder();
    expect(decoder.decode(frames[0])).toMatch(/^id: 2\n/);
  });

  it("invalid CC_SSE_REPLAY_BUFFER_SIZE falls back to default 256", () => {
    process.env.CC_SSE_REPLAY_BUFFER_SIZE = "foo";
    _resetForTesting();

    for (let i = 0; i < 300; i++) {
      broadcast(TEST_EVENT);
    }

    // Buffer holds the last 256 frames (seq 45..300); oldest = 45.
    // Replay from oldest - 1 (= 44) is the boundary where the catch-up is
    // still complete; from anything older the new gap rule returns empty.
    expect(replayFramesSince(44)).toHaveLength(256);
    expect(replayFramesSince(0)).toHaveLength(0);
  });

  it("zero or negative CC_SSE_REPLAY_BUFFER_SIZE falls back to default 256", () => {
    process.env.CC_SSE_REPLAY_BUFFER_SIZE = "0";
    _resetForTesting();

    for (let i = 0; i < 300; i++) {
      broadcast(TEST_EVENT);
    }

    expect(replayFramesSince(44)).toHaveLength(256);
  });

  it("_resetForTesting clears seq back to 0 and empties the buffer", () => {
    broadcast(TEST_EVENT);
    broadcast(TEST_EVENT);
    expect(replayFramesSince(0)).toHaveLength(2);

    _resetForTesting();

    expect(replayFramesSince(0)).toHaveLength(0);

    const { controller, chunks } = makeController();
    addClient(controller);
    broadcast(TEST_EVENT);
    const decoder = new TextDecoder();
    expect(decoder.decode(chunks[0])).toMatch(/^id: 1\n/);
  });
});

describe("sse-broadcaster timing log", () => {
  const tmpDir = path.join(os.tmpdir(), "cc-sse-broadcaster-test");
  const testLogFile = path.join(tmpDir, "test.log");

  function readLogLines(): Record<string, unknown>[] {
    if (!existsSync(testLogFile)) return [];
    const content = readFileSync(testLogFile, "utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function cleanup(): void {
    try {
      if (existsSync(testLogFile)) unlinkSync(testLogFile);
    } catch {
      // ignore
    }
  }

  beforeEach(() => {
    cleanup();
    _resetForTesting();
    _resetLoggerForTesting();
    delete process.env["CC_LOG_SILENT"];
    process.env["CC_LOG_FILE"] = testLogFile;
    process.env["CC_LOG_LEVEL"] = "debug";
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
  });

  afterEach(() => {
    cleanup();
    _resetLoggerForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_LEVEL"];
  });

  it("emits sse.broadcast.complete with eventType, seq, subscriberCount, delivered, payloadBytes, durationMs", () => {
    const { controller } = makeController();
    addClient(controller);

    broadcast(TEST_EVENT);

    const lines = readLogLines();
    const log = lines.find((l) => l["message"] === "sse.broadcast.complete");
    expect(log).toBeDefined();
    expect(log?.["eventType"]).toBe("conversation-status");
    expect(log?.["seq"]).toBe(1);
    expect(log?.["subscriberCount"]).toBe(1);
    expect(log?.["delivered"]).toBe(1);
    expect(typeof log?.["payloadBytes"]).toBe("number");
    expect((log?.["payloadBytes"] as number) > 0).toBe(true);
    expect(typeof log?.["durationMs"]).toBe("number");
  });

  it("logs delivered:0 when all subscribers throw on enqueue", () => {
    const { controller: c1 } = makeController();
    const { controller: c2 } = makeController();
    c1.enqueue = () => {
      throw new Error("stream closed");
    };
    c2.enqueue = () => {
      throw new Error("stream closed");
    };
    addClient(c1);
    addClient(c2);

    broadcast(TEST_EVENT);

    const lines = readLogLines();
    const log = lines.find((l) => l["message"] === "sse.broadcast.complete");
    expect(log).toBeDefined();
    expect(log?.["subscriberCount"]).toBe(2);
    expect(log?.["delivered"]).toBe(0);
  });

  it("logs broadcast.no_clients when there are no subscribers", () => {
    broadcast(TEST_EVENT);

    const lines = readLogLines();
    const log = lines.find((l) => l["message"] === "broadcast.no_clients");
    expect(log).toBeDefined();
    expect(log?.["eventType"]).toBe("conversation-status");

    const complete = lines.find(
      (l) => l["message"] === "sse.broadcast.complete",
    );
    expect(complete).toBeUndefined();
  });
});

describe("conversationStatusEventSchema", () => {
  it("accepts event without error", () => {
    const event = {
      type: "conversation-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "c",
      status: "awaiting",
    };
    expect(conversationStatusEventSchema.safeParse(event).success).toBe(true);
  });

  it("accepts event with optional error field", () => {
    const event = {
      type: "conversation-status",
      projectName: "p",
      sessionName: "s",
      conversationId: "c",
      status: "awaiting",
      error: "Fork failed: the fork point was compacted",
    };
    const result = conversationStatusEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.error).toBe(
        "Fork failed: the fork point was compacted",
      );
    }
  });
});
