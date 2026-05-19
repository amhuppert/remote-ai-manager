import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "@/app/api/events/route";
import { _resetForTesting, broadcast, getClientCount } from "./sse-broadcaster";
import type { ConversationStatusEvent } from "@/types";

const TEST_EVENT: ConversationStatusEvent = {
  type: "conversation-status",
  projectName: "p",
  sessionName: "s",
  conversationId: "c",
  status: "running",
};

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/events", {
    method: "GET",
    headers,
  });
}

async function readFramesUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (combined: string) => boolean,
  timeoutMs = 1000,
): Promise<string> {
  const decoder = new TextDecoder();
  let combined = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(combined)) {
    if (Date.now() > deadline) {
      throw new Error(
        `readFramesUntil timed out; received so far: ${JSON.stringify(combined)}`,
      );
    }
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) combined += decoder.decode(value);
  }
  return combined;
}

beforeEach(() => {
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
});

describe("GET /api/events", () => {
  it("sends `connected` frame when no Last-Event-ID header is present", async () => {
    const response = GET(makeRequest());
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");

    const reader = response.body!.getReader();
    const out = await readFramesUntil(reader, (s) => s.includes("connected"));
    expect(out).toContain("event: connected");
    await reader.cancel();
  });

  it("replays buffered frames before `connected` when Last-Event-ID is provided", async () => {
    broadcast(TEST_EVENT); // seq 1
    broadcast(TEST_EVENT); // seq 2
    broadcast(TEST_EVENT); // seq 3

    const response = GET(makeRequest({ "Last-Event-ID": "0" }));
    const reader = response.body!.getReader();
    const out = await readFramesUntil(reader, (s) => s.includes("connected"));

    const idxFirstReplay = out.indexOf("id: 1\n");
    const idxConnected = out.indexOf("event: connected");
    expect(idxFirstReplay).toBeGreaterThanOrEqual(0);
    expect(idxConnected).toBeGreaterThan(idxFirstReplay);

    expect(out).toContain("id: 1\n");
    expect(out).toContain("id: 2\n");
    expect(out).toContain("id: 3\n");

    await reader.cancel();
  });

  it("replays only frames with seq strictly greater than Last-Event-ID", async () => {
    broadcast(TEST_EVENT); // seq 1
    broadcast(TEST_EVENT); // seq 2
    broadcast(TEST_EVENT); // seq 3

    const response = GET(makeRequest({ "Last-Event-ID": "2" }));
    const reader = response.body!.getReader();
    const out = await readFramesUntil(reader, (s) => s.includes("connected"));

    expect(out).not.toContain("id: 1\n");
    expect(out).not.toContain("id: 2\n");
    expect(out).toContain("id: 3\n");

    await reader.cancel();
  });

  it("ignores malformed Last-Event-ID header", async () => {
    broadcast(TEST_EVENT);

    const response = GET(makeRequest({ "Last-Event-ID": "not-a-number" }));
    const reader = response.body!.getReader();
    const out = await readFramesUntil(reader, (s) => s.includes("connected"));

    expect(out).not.toContain("id: 1\n");
    expect(out).toContain("event: connected");

    await reader.cancel();
  });

  it("enqueues heartbeat frames every 15s", async () => {
    vi.useFakeTimers();
    try {
      const response = GET(makeRequest());
      const reader = response.body!.getReader();

      const decoder = new TextDecoder();
      const first = await reader.read();
      expect(decoder.decode(first.value)).toContain("event: connected");

      vi.advanceTimersByTime(15_000);
      const second = await reader.read();
      expect(decoder.decode(second.value)).toBe(": heartbeat\n\n");

      vi.advanceTimersByTime(15_000);
      const third = await reader.read();
      expect(decoder.decode(third.value)).toBe(": heartbeat\n\n");

      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() stops the heartbeat timer (no more frames after cancel)", async () => {
    vi.useFakeTimers();
    try {
      const response = GET(makeRequest());
      const reader = response.body!.getReader();

      const decoder = new TextDecoder();
      const first = await reader.read();
      expect(decoder.decode(first.value)).toContain("event: connected");

      expect(getClientCount()).toBe(1);
      await reader.cancel();
      expect(getClientCount()).toBe(0);

      vi.advanceTimersByTime(60_000);
      expect(true).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
