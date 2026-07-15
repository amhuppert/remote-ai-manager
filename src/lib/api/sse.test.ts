import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  addSseListener,
  instrumentSseEventSource,
  type SseEventTarget,
} from "./sse";
import type { ClientLogger } from "@/lib/logging/client-logger";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";

function makeEventSource(): { es: SseEventTarget; fake: FakeEventSource } {
  const fake = new FakeEventSource("/api/events");
  return { es: fake, fake };
}

function recordingLogger(): {
  logger: ClientLogger;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const logger: ClientLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return { logger, warn };
}

describe("addSseListener", () => {
  it("delivers schema-validated payloads with the transport envelope stripped", () => {
    const { es, fake } = makeEventSource();
    // A `.strict()` schema pins the real wire contract: frames arrive with
    // the broadcaster's `_sentAt` stamp, and the listener must strip it
    // before validation or the event is silently dropped.
    const schema = z
      .object({ type: z.literal("thing-updated"), id: z.string() })
      .strict();
    const handler = vi.fn();

    addSseListener(es, "thing-updated", schema, handler);
    fake.emit("thing-updated", { type: "thing-updated", id: "t-1" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "thing-updated", id: "t-1" });
  });

  it("drops a wrong-shape frame without calling the handler and logs a payload-free schema rejection", () => {
    const { es, fake } = makeEventSource();
    const { logger, warn } = recordingLogger();
    const schema = z.object({
      type: z.literal("thing-updated"),
      id: z.string(),
    });
    const handler = vi.fn();

    addSseListener(es, "thing-updated", schema, handler, logger);
    fake.emit("thing-updated", { type: "thing-updated", secret: "leak-me" });

    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const [event, payload] = warn.mock.calls[0]!;
    expect(event).toBe("sse.frame_schema_rejected");
    expect(payload).toMatchObject({ eventType: "thing-updated" });
    expect(JSON.stringify(payload)).not.toContain("leak-me");
  });

  it("drops malformed JSON frames without throwing and logs a payload-free parse failure", () => {
    const { es, fake } = makeEventSource();
    const { logger, warn } = recordingLogger();
    const handler = vi.fn();
    addSseListener(es, "thing-updated", z.unknown(), handler, logger);

    const listeners = fake.listeners.get("thing-updated") ?? [];
    expect(listeners.length).toBe(1);
    expect(() =>
      listeners[0]?.({ data: "not-json" } as MessageEvent),
    ).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("sse.frame_parse_failed", {
      eventType: "thing-updated",
    });
  });

  it("does not let a throwing handler propagate into EventSource dispatch and logs the failure without the payload", () => {
    const { es, fake } = makeEventSource();
    const { logger, warn } = recordingLogger();
    addSseListener(
      es,
      "thing-updated",
      z.unknown(),
      () => {
        throw new Error("reaction failed");
      },
      logger,
    );

    expect(() =>
      fake.emit("thing-updated", { type: "thing-updated", secret: "leak-me" }),
    ).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    const [event, payload] = warn.mock.calls[0]!;
    expect(event).toBe("sse.handler_failed");
    expect(payload).toMatchObject({
      eventType: "thing-updated",
      error: "reaction failed",
    });
    expect(JSON.stringify(payload)).not.toContain("leak-me");
  });

  it("only reacts to the registered event type", () => {
    const { es, fake } = makeEventSource();
    const handler = vi.fn();
    addSseListener(es, "thing-updated", z.unknown(), handler);

    fake.emit("other-event", { type: "other-event" });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("instrumentSseEventSource", () => {
  it("keeps delivering events to listeners registered after instrumentation", () => {
    const { es, fake } = makeEventSource();
    instrumentSseEventSource(es);

    const handler = vi.fn();
    addSseListener(
      es,
      "thing-updated",
      z.object({ type: z.literal("thing-updated") }).strict(),
      handler,
    );
    fake.emit("thing-updated", { type: "thing-updated" });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("logs transport timing for stale frames", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      const { es, fake } = makeEventSource();
      instrumentSseEventSource(es);
      addSseListener(es, "thing-updated", z.unknown(), () => {});

      // FakeEventSource stamps a fixed epoch `_sentAt` far in the past, so
      // the computed transport delta always crosses the log threshold.
      fake.emit("thing-updated", { type: "thing-updated" });

      expect(debugSpy).toHaveBeenCalledWith(
        "sse.message",
        expect.objectContaining({ eventType: "thing-updated" }),
      );
    } finally {
      debugSpy.mockRestore();
    }
  });
});
