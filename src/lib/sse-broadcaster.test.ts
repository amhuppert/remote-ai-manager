import { describe, it, expect, beforeEach } from "vitest";
import {
  addClient,
  removeClient,
  broadcast,
  getClientCount,
  _resetForTesting,
} from "./sse-broadcaster";
import type { ConversationStatusEvent } from "@/types";
import { conversationStatusEventSchema } from "./schemas";

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
    const expected = `event: conversation-status\ndata: ${JSON.stringify(TEST_EVENT)}\n\n`;

    expect(decoder.decode(client1.chunks[0])).toBe(expected);
    expect(decoder.decode(client2.chunks[0])).toBe(expected);
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
