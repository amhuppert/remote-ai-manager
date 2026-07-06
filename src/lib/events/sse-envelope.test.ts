import { describe, expect, it } from "vitest";
import {
  parseSseEventData,
  readSseEnvelopeSentAt,
  stampSseEnvelope,
} from "./sse-envelope";
import {
  conversationStatusEventSchema,
  messageAppendedEventSchema,
} from "@/lib/conversations/schemas";
import { mcpToolsUpdatedEventSchema } from "@/lib/mcp/schemas";

describe("sse-envelope", () => {
  it("stamp → parse round-trips the bare event", () => {
    const event = { type: "conversation-status", status: "running" };
    const raw = JSON.stringify(stampSseEnvelope(event, 1_700_000_000_000));
    expect(parseSseEventData(raw)).toEqual(event);
  });

  it("parse passes through frames without a stamp", () => {
    const event = { type: "conversation-status", status: "running" };
    expect(parseSseEventData(JSON.stringify(event))).toEqual(event);
  });

  it("parse passes through non-object payloads", () => {
    expect(parseSseEventData("null")).toBeNull();
    expect(parseSseEventData('"init"')).toBe("init");
    expect(parseSseEventData("[1,2]")).toEqual([1, 2]);
  });

  it("parse throws on malformed JSON, matching JSON.parse semantics", () => {
    expect(() => parseSseEventData("not json")).toThrow();
  });

  it("reads the stamp without mutating anything, null when absent", () => {
    const raw = JSON.stringify(stampSseEnvelope({ type: "x" }, 42));
    expect(readSseEnvelopeSentAt(raw)).toBe(42);
    expect(readSseEnvelopeSentAt(JSON.stringify({ type: "x" }))).toBeNull();
    expect(readSseEnvelopeSentAt("not json")).toBeNull();
  });

  // Regression pins for the silent-drop bug: `.strict()` domain schemas
  // reject a raw stamped frame, so handlers MUST parse through
  // parseSseEventData. If a schema ever starts seeing the stamp again these
  // fail loudly instead of the UI silently going stale.
  it("strict project-scope conversation events parse only after stripping", () => {
    const statusEvent = {
      type: "conversation-status",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      status: "running",
    };
    const raw = JSON.stringify(stampSseEnvelope(statusEvent, 1));
    expect(
      conversationStatusEventSchema.safeParse(JSON.parse(raw)).success,
    ).toBe(false);
    expect(
      conversationStatusEventSchema.safeParse(parseSseEventData(raw)).success,
    ).toBe(true);

    const appendedEvent = {
      type: "message-appended",
      scope: "project",
      projectName: "proj",
      conversationId: "pc-1",
      seq: 0,
      message: {
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: null,
      },
    };
    const appendedRaw = JSON.stringify(stampSseEnvelope(appendedEvent, 1));
    expect(
      messageAppendedEventSchema.safeParse(parseSseEventData(appendedRaw))
        .success,
    ).toBe(true);
  });

  it("strict mcp live-update events parse only after stripping", () => {
    const event = {
      type: "mcp-tools-updated",
      level: "conversation",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      serverKey: "calc",
    };
    const raw = JSON.stringify(stampSseEnvelope(event, 1));
    expect(mcpToolsUpdatedEventSchema.safeParse(JSON.parse(raw)).success).toBe(
      false,
    );
    expect(
      mcpToolsUpdatedEventSchema.safeParse(parseSseEventData(raw)).success,
    ).toBe(true);
  });
});
