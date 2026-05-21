import { describe, expect, it } from "vitest";
import {
  toPrimitive,
  toGraph,
  type GraphWorkflowLaneAdapterInputContext,
} from "./graph-workflow-lane-adapter";
import { createInMemoryLaneStore } from "./lane-store";
import { createLaneService } from "./lane-service";
import type { GraphWorkflowAgentSessionState } from "@/lib/schemas";

const T0 = "2026-04-28T10:00:00.000Z";
const T1 = "2026-04-28T10:05:00.000Z";

function buildClaudeImplementer(
  overrides: Partial<
    Extract<GraphWorkflowAgentSessionState, { engine: "claude" }>
  > = {},
): GraphWorkflowAgentSessionState {
  return {
    engine: "claude",
    lane: "implementer",
    contextId: "ctx-1",
    workflowConversationId: "conv-w",
    sessionRef: {
      engine: "claude",
      lane: "implementer",
      conversationId: "conv-session-1",
    },
    lastContextTokens: 50_000,
    lastContextWindowMax: 200_000,
    rotateBeforeNextTurn: false,
    limitEvaluation: "supported",
    lastUsedAt: T0,
    ...overrides,
  };
}

function buildCodexImplementer(
  overrides: Partial<
    Extract<GraphWorkflowAgentSessionState, { engine: "codex" }>
  > = {},
): GraphWorkflowAgentSessionState {
  return {
    engine: "codex",
    lane: "implementer",
    contextId: "ctx-1",
    sessionRef: {
      engine: "codex",
      lane: "implementer",
      threadId: "thr-1",
    },
    lastTurnUsage: null,
    rotateBeforeNextTurn: false,
    limitEvaluation: "unsupported",
    lastUsedAt: T0,
    ...overrides,
  };
}

describe("graphWorkflowLaneAdapter — Claude implementer round-trip", () => {
  it("preserves all Claude implementer fields through toPrimitive → toGraph", () => {
    const original = buildClaudeImplementer();
    const ctx: GraphWorkflowLaneAdapterInputContext = {
      executionId: "exec-1",
      policy: { continuityEnabled: true, contextLimitTokens: 150_000 },
    };
    const projected = toPrimitive(original, ctx);
    const reconstructed = toGraph(projected.primitive, projected.extras);
    expect(reconstructed).toEqual(original);
  });

  it("infers write_capable for an implementer lane and exposes executionId as the workflowId", () => {
    const projected = toPrimitive(buildClaudeImplementer(), {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    expect(projected.primitive.writeCapability).toBe("write_capable");
    expect(projected.primitive.workflowId).toBe("exec-1");
    expect(projected.primitive.laneId).toBe("implementer");
  });

  it("preserves rotateBeforeNextTurn=true so stale-session recovery flag survives the round trip", () => {
    const original = buildClaudeImplementer({ rotateBeforeNextTurn: true });
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true, contextLimitTokens: 100_000 },
    });
    if (projected.primitive.metrics.backend === "claude") {
      expect(projected.primitive.metrics.rotateBeforeNextTurn).toBe(true);
    }
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });

  it("converts null context metrics to omitted optional fields and back to null", () => {
    const original = buildClaudeImplementer({
      lastContextTokens: null,
      lastContextWindowMax: null,
      limitEvaluation: "disabled",
    });
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: false },
    });
    if (projected.primitive.metrics.backend === "claude") {
      expect(projected.primitive.metrics.contextTokens).toBeUndefined();
      expect(projected.primitive.metrics.contextWindowMax).toBeUndefined();
    }
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });

  it("preserves workflowConversationId distinct from sessionRef.conversationId", () => {
    const original = buildClaudeImplementer({
      workflowConversationId: "conv-distinct-from-session",
    });
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    expect(projected.extras.workflowConversationId).toBe(
      "conv-distinct-from-session",
    );
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });

  it("preserves sessionRef.conversationId via primitive backendState", () => {
    const original = buildClaudeImplementer({
      sessionRef: {
        engine: "claude",
        lane: "implementer",
        conversationId: "conv-claude-runtime",
      },
    });
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    if (projected.primitive.backendState.backend === "claude") {
      expect(projected.primitive.backendState.conversationId).toBe(
        "conv-claude-runtime",
      );
    }
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });
});

describe("graphWorkflowLaneAdapter — Claude context_validator", () => {
  it("infers read_only for context_validator and round-trips identically", () => {
    const original: GraphWorkflowAgentSessionState = {
      engine: "claude",
      lane: "context_validator",
      contextId: "ctx-2",
      workflowConversationId: "conv-validator",
      sessionRef: {
        engine: "claude",
        lane: "context_validator",
        conversationId: "conv-session-validator",
      },
      lastContextTokens: 30_000,
      lastContextWindowMax: 200_000,
      rotateBeforeNextTurn: false,
      limitEvaluation: "supported",
      lastUsedAt: T0,
    };
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true, contextLimitTokens: 150_000 },
    });
    expect(projected.primitive.writeCapability).toBe("read_only");
    expect(projected.primitive.laneId).toBe("context_validator");
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });
});

describe("graphWorkflowLaneAdapter — Codex round-trip", () => {
  it("preserves a Codex lane with sessionRef and lastTurnUsage", () => {
    const original = buildCodexImplementer({
      lastTurnUsage: {
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 50,
      },
    });
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    if (projected.primitive.backendState.backend === "codex") {
      expect(projected.primitive.backendState.threadId).toBe("thr-1");
    }
    if (projected.primitive.metrics.backend === "codex") {
      expect(projected.primitive.metrics.lastTurnUsage).toEqual({
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 50,
      });
    }
    expect(projected.extras.limitEvaluation).toBe("unsupported");
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });

  it("preserves a Codex lane with no sessionRef (initial pre-thread state)", () => {
    const original: GraphWorkflowAgentSessionState = {
      engine: "codex",
      lane: "implementer",
      contextId: "ctx-1",
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: T0,
    };
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    if (projected.primitive.backendState.backend === "codex") {
      expect(projected.primitive.backendState.threadId).toBeUndefined();
    }
    if (projected.primitive.metrics.backend === "codex") {
      expect(projected.primitive.metrics.lastTurnUsage).toBeNull();
    }
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });

  it("preserves rotateBeforeNextTurn=true for Codex failure recovery", () => {
    const original = buildCodexImplementer({ rotateBeforeNextTurn: true });
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    if (projected.primitive.metrics.backend === "codex") {
      expect(projected.primitive.metrics.rotateBeforeNextTurn).toBe(true);
    }
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });

  it("preserves a Codex context_validator lane (read_only) round-trip", () => {
    const original: GraphWorkflowAgentSessionState = {
      engine: "codex",
      lane: "context_validator",
      contextId: "ctx-2",
      sessionRef: {
        engine: "codex",
        lane: "context_validator",
        threadId: "thr-validator",
      },
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
      limitEvaluation: "disabled",
      lastUsedAt: T0,
    };
    const projected = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    expect(projected.primitive.writeCapability).toBe("read_only");
    expect(toGraph(projected.primitive, projected.extras)).toEqual(original);
  });
});

describe("graphWorkflowLaneAdapter — workflow scoping", () => {
  it("uses executionId as the primitive workflowId so different executions stay isolated", () => {
    const state = buildClaudeImplementer({ contextId: "ctx-shared" });
    const projA = toPrimitive(state, {
      executionId: "exec-A",
      policy: { continuityEnabled: true },
    });
    const projB = toPrimitive(state, {
      executionId: "exec-B",
      policy: { continuityEnabled: true },
    });
    expect(projA.primitive.workflowId).toBe("exec-A");
    expect(projB.primitive.workflowId).toBe("exec-B");
    // Same lane name, different workflow scope — primitive lane storage keys must differ.
    expect(projA.primitive.laneId).toBe(projB.primitive.laneId);
  });
});

describe("graphWorkflowLaneAdapter — lane-service parity", () => {
  it("flips Claude rotateBeforeNextTurn when the lane service records context-token overflow, matching graph rotation rules", async () => {
    const original = buildClaudeImplementer({ rotateBeforeNextTurn: false });
    const ctx: GraphWorkflowLaneAdapterInputContext = {
      executionId: "exec-1",
      policy: { continuityEnabled: true, contextLimitTokens: 100_000 },
    };
    const { primitive, extras } = toPrimitive(original, ctx);
    const store = createInMemoryLaneStore();
    const service = createLaneService({ store, now: () => T1 });
    await service.initialize(primitive);
    const updated = await service.recordOutcome(
      { workflowId: primitive.workflowId, laneId: primitive.laneId },
      {
        backend: "claude",
        contextTokens: 120_000,
        contextWindowMax: 200_000,
      },
    );
    const reconstructed = toGraph(updated, extras);
    expect(reconstructed).toMatchObject({
      engine: "claude",
      lane: "implementer",
      contextId: "ctx-1",
      lastContextTokens: 120_000,
      lastContextWindowMax: 200_000,
      rotateBeforeNextTurn: true,
      limitEvaluation: "supported",
      lastUsedAt: T1,
    });
  });

  it("flips Codex rotateBeforeNextTurn=true when the lane service records a failed turn, matching graph rotation rules", async () => {
    const original = buildCodexImplementer();
    const { primitive, extras } = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    const store = createInMemoryLaneStore();
    const service = createLaneService({ store, now: () => T1 });
    await service.initialize(primitive);
    const updated = await service.recordOutcome(
      { workflowId: primitive.workflowId, laneId: primitive.laneId },
      { backend: "codex", failed: true },
    );
    const reconstructed = toGraph(updated, extras);
    expect(reconstructed.engine).toBe("codex");
    expect(reconstructed.rotateBeforeNextTurn).toBe(true);
    expect(reconstructed.lastUsedAt).toBe(T1);
  });
});

describe("graphWorkflowLaneAdapter — invariants", () => {
  it("rejects toGraph for a Claude primitive whose backendState has no conversationId (graph requires one)", () => {
    const original = buildClaudeImplementer();
    const { primitive, extras } = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    if (primitive.backendState.backend !== "claude") {
      throw new Error("test setup expected Claude branch");
    }
    const stripped = {
      ...primitive,
      backendState: { backend: "claude" as const },
    };
    expect(() => toGraph(stripped, extras)).toThrow(/conversationId/i);
  });

  it("rejects toGraph for a Claude primitive carrying limitEvaluation=unsupported in extras", () => {
    const original = buildClaudeImplementer();
    const { primitive } = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    expect(() =>
      toGraph(primitive, {
        lane: "implementer",
        contextId: "ctx-1",
        limitEvaluation: "unsupported",
      }),
    ).toThrow();
  });

  it("rejects toGraph for a Codex primitive carrying limitEvaluation=supported in extras", () => {
    const original = buildCodexImplementer();
    const { primitive } = toPrimitive(original, {
      executionId: "exec-1",
      policy: { continuityEnabled: true },
    });
    expect(() =>
      toGraph(primitive, {
        lane: "implementer",
        contextId: "ctx-1",
        limitEvaluation: "supported",
      }),
    ).toThrow();
  });
});
