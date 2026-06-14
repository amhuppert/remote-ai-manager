import { describe, it, expect, vi } from "vitest";
import { broadcastEvent } from "./broadcast-event";
import type { SSEEvent } from "@/lib/api/sse-events";

const sampleEvent = {
  type: "conversation-created",
  scope: "session",
} as unknown as SSEEvent;

describe("broadcastEvent", () => {
  it("broadcasts the built event on the happy path", () => {
    const broadcast = vi.fn();
    const warn = vi.fn();

    broadcastEvent({
      broadcast,
      build: () => sampleEvent,
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
    });

    expect(broadcast).toHaveBeenCalledWith(sampleEvent);
    expect(warn).not.toHaveBeenCalled();
  });

  it("swallows a build throw and warns with context plus the error message", () => {
    const broadcast = vi.fn();
    const warn = vi.fn();

    broadcastEvent({
      broadcast,
      build: () => {
        throw new Error("bad shape");
      },
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("x.broadcast_failed", {
      conversationId: "c1",
      error: "bad shape",
    });
  });

  it("swallows a broadcast throw and warns", () => {
    const broadcast = vi.fn(() => {
      throw new Error("transport down");
    });
    const warn = vi.fn();

    broadcastEvent({
      broadcast,
      build: () => sampleEvent,
      logger: { warn },
      failureEvent: "x.broadcast_failed",
      context: { conversationId: "c1" },
    });

    expect(warn).toHaveBeenCalledWith("x.broadcast_failed", {
      conversationId: "c1",
      error: "transport down",
    });
  });
});
