import { describe, expect, it } from "vitest";
import { storedConversationStateSchema } from "../schemas";
import { makeConversationState } from "./conversation-state-fixture";

describe("makeConversationState", () => {
  it("produces a schema-valid stored conversation from zero overrides", () => {
    // Parse-based construction is the point of the factory: a future field
    // added to the schema with a `.default()` fills here automatically, so
    // adding one costs zero fixture edits (audit 1beec403 finding 10: the
    // previous hand-written-literal pattern cost 49 edits per field).
    const state = makeConversationState();
    expect(() => storedConversationStateSchema.parse(state)).not.toThrow();
    expect(state.id).toBe("conv-1");
    expect(state.agentBackend).toBe("claude");
    expect(state.pendingQueue).toEqual([]);
    expect(state.pendingAgentNotices).toEqual([]);
    expect(state.totalCostUsd).toBeNull();
    expect(state.unread).toBe(false);
  });

  it("applies overrides over the base and the schema defaults", () => {
    const state = makeConversationState({
      id: "conv-override",
      status: "running",
      agentBackend: "codex",
      totalCostUsd: 4.25,
      backendRef: { backend: "codex", ref: "thread-9" },
    });
    expect(state.id).toBe("conv-override");
    expect(state.status).toBe("running");
    expect(state.agentBackend).toBe("codex");
    expect(state.totalCostUsd).toBe(4.25);
    expect(state.backendRef).toEqual({ backend: "codex", ref: "thread-9" });
    // Untouched defaults still fill.
    expect(state.pendingQueue).toEqual([]);
  });

  it("rejects overrides that violate the schema instead of persisting garbage", () => {
    expect(() =>
      makeConversationState({
        // @ts-expect-error — invalid status is exactly what must throw
        status: "not-a-status",
      }),
    ).toThrow();
  });
});
