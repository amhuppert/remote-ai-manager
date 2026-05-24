/**
 * Tests for the MCP route-handler → SSE event adapter.
 *
 * The adapter accepts `McpConfigRouteBroadcastPayload` values (the route-
 * handler's scope-agnostic payload) and emits the public `mcp-config-updated`
 * and `mcp-tools-updated` SSE events. The tests verify that only the
 * approved fields make it into the broadcasted event and that the emit
 * function is invoked with a schema-valid payload.
 */

import { describe, expect, it, vi } from "vitest";

import type { McpConfigRouteBroadcastPayload } from "@/lib/mcp/config-route-handlers";
import {
  mcpConfigUpdatedEventSchema,
  mcpToolsUpdatedEventSchema,
} from "@/lib/mcp/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import { createMcpRouteBroadcast } from "./sse-broadcast";

describe("createMcpRouteBroadcast", () => {
  it("emits an mcp-config-updated event for a global scope payload", () => {
    const emit = vi.fn<(event: SSEEvent) => void>();
    const broadcast = createMcpRouteBroadcast(emit);

    const payload: McpConfigRouteBroadcastPayload = {
      kind: "config-updated",
      level: "global",
      changedServerKeys: ["calc"],
      effectiveConfigHash: "hash-1",
    };
    broadcast(payload);

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]![0];
    expect(event.type).toBe("mcp-config-updated");
    if (event.type !== "mcp-config-updated") throw new Error("bad event type");

    // Must conform to the public schema (no extra fields, correct shape).
    expect(mcpConfigUpdatedEventSchema.safeParse(event).success).toBe(true);
    expect(event.level).toBe("global");
    expect(event.changedServerKeys).toEqual(["calc"]);
    expect(event.effectiveConfigHash).toBe("hash-1");
  });

  it("emits an mcp-config-updated event for a conversation scope with all identifiers", () => {
    const emit = vi.fn<(event: SSEEvent) => void>();
    const broadcast = createMcpRouteBroadcast(emit);

    broadcast({
      kind: "config-updated",
      level: "conversation",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      changedServerKeys: ["a", "b"],
      effectiveConfigHash: "hash-2",
    });

    const event = emit.mock.calls[0]![0];
    if (event.type !== "mcp-config-updated") throw new Error("bad event type");
    expect(event.projectName).toBe("proj");
    expect(event.sessionName).toBe("sess");
    expect(event.conversationId).toBe("conv-1");
    expect(event.changedServerKeys).toEqual(["a", "b"]);
    expect(mcpConfigUpdatedEventSchema.safeParse(event).success).toBe(true);
  });

  it("emits an mcp-tools-updated event for tool refreshes", () => {
    const emit = vi.fn<(event: SSEEvent) => void>();
    const broadcast = createMcpRouteBroadcast(emit);

    broadcast({
      kind: "tools-updated",
      level: "conversation",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
      serverKey: "calc",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0]![0];
    expect(event.type).toBe("mcp-tools-updated");
    if (event.type !== "mcp-tools-updated") throw new Error("bad event type");
    expect(event.serverKey).toBe("calc");
    expect(event).not.toHaveProperty("configSignature");
    expect(mcpToolsUpdatedEventSchema.safeParse(event).success).toBe(true);
  });

  it("does not include undefined scope identifier fields", () => {
    // The strict schema above rejects extra keys. Global events must not
    // carry project/session/conversation slots at all — not even as undefined.
    const emit = vi.fn<(event: SSEEvent) => void>();
    const broadcast = createMcpRouteBroadcast(emit);

    broadcast({
      kind: "config-updated",
      level: "global",
      changedServerKeys: [],
      effectiveConfigHash: "h",
    });

    const event = emit.mock.calls[0]![0];
    expect(event).not.toHaveProperty("projectName");
    expect(event).not.toHaveProperty("sessionName");
    expect(event).not.toHaveProperty("conversationId");
  });

  it("defaults to the production broadcaster when no emit function is supplied", () => {
    // Smoke test: calling the factory with no args returns a usable function.
    // We don't actually invoke the broadcaster here (it would write to a
    // shared client Set) — we just verify the factory signature.
    const broadcast = createMcpRouteBroadcast();
    expect(typeof broadcast).toBe("function");
  });
});
