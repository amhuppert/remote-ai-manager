import { describe, expect, it } from "vitest";
import { createInMemoryLaneStore } from "./lane-store";
import { createLaneService } from "./lane-service";
import type { LaneOutcome } from "./lane-service";
import type { LaneState } from "./lane-vocabulary";

const T0 = "2026-04-28T10:00:00.000Z";
const T1 = "2026-04-28T10:05:00.000Z";

function clockOnce(value: string): () => string {
  return () => value;
}

function buildClaudeLane(overrides: Partial<LaneState> = {}): LaneState {
  return {
    workflowId: "wf-A",
    laneId: "primary",
    backend: "claude",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true, contextLimitTokens: 150_000 },
    backendState: { backend: "claude", conversationId: "conv-1" },
    metrics: { backend: "claude", rotateBeforeNextTurn: false },
    lastUsedAt: T0,
    ...overrides,
  };
}

function buildCodexLane(overrides: Partial<LaneState> = {}): LaneState {
  return {
    workflowId: "wf-A",
    laneId: "secondary",
    backend: "codex",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    backendState: { backend: "codex", threadId: "thr-1" },
    metrics: {
      backend: "codex",
      lastTurnUsage: null,
      rotateBeforeNextTurn: false,
    },
    lastUsedAt: T0,
    ...overrides,
  };
}

describe("createLaneService — resolve", () => {
  it("returns null when no lane has been initialized for the ref", async () => {
    const service = createLaneService({
      store: createInMemoryLaneStore(),
      now: clockOnce(T1),
    });
    const result = await service.resolve({
      workflowId: "wf-A",
      laneId: "missing",
    });
    expect(result).toBeNull();
  });

  it("returns the active continuity context for a lane-backed call", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const result = await service.resolve({
      workflowId: "wf-A",
      laneId: "primary",
    });
    expect(result?.backendState).toMatchObject({ conversationId: "conv-1" });
    expect(result?.metrics).toMatchObject({ rotateBeforeNextTurn: false });
  });

  it("scopes resolution by workflow so lanes from sibling workflows do not leak", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane({ workflowId: "wf-A", laneId: "p" }));
    await store.write(
      buildClaudeLane({
        workflowId: "wf-B",
        laneId: "p",
        backendState: { backend: "claude", conversationId: "conv-B" },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const fromA = await service.resolve({ workflowId: "wf-A", laneId: "p" });
    const fromB = await service.resolve({ workflowId: "wf-B", laneId: "p" });
    expect(fromA?.backendState).toMatchObject({ conversationId: "conv-1" });
    expect(fromB?.backendState).toMatchObject({ conversationId: "conv-B" });
  });
});

describe("createLaneService — initialize", () => {
  it("seeds a new lane state and returns the persisted result", async () => {
    const store = createInMemoryLaneStore();
    const service = createLaneService({ store, now: clockOnce(T1) });
    const seeded = await service.initialize(buildCodexLane());
    expect(seeded.lastUsedAt).toBe(T1);
    expect(seeded.backendState).toMatchObject({ threadId: "thr-1" });
    const reread = await service.resolve({
      workflowId: "wf-A",
      laneId: "secondary",
    });
    expect(reread?.lastUsedAt).toBe(T1);
  });

  it("replaces an existing lane state when re-initialized", async () => {
    const store = createInMemoryLaneStore();
    const service = createLaneService({ store, now: clockOnce(T1) });
    await service.initialize(buildClaudeLane());
    const replaced = await service.initialize(
      buildClaudeLane({
        backendState: { backend: "claude", conversationId: "conv-replaced" },
      }),
    );
    expect(replaced.backendState).toMatchObject({
      conversationId: "conv-replaced",
    });
  });
});

describe("createLaneService — recordOutcome (Claude)", () => {
  it("records context metrics and reports no_rotation without flagging rotation when below limit", async () => {
    const store = createInMemoryLaneStore();
    await store.write(
      buildClaudeLane({
        policy: { continuityEnabled: true, contextLimitTokens: 100_000 },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      {
        backend: "claude",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
      },
    );
    expect(contextLimitEvaluation).toBe("no_rotation");
    expect(state.lastUsedAt).toBe(T1);
    if (state.metrics.backend === "claude") {
      expect(state.metrics.contextTokens).toBe(50_000);
      expect(state.metrics.contextWindowMax).toBe(200_000);
      expect(state.metrics.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("flags rotation and reports rotation_required when context tokens exceed the lane's configured limit", async () => {
    const store = createInMemoryLaneStore();
    await store.write(
      buildClaudeLane({
        policy: { continuityEnabled: true, contextLimitTokens: 100_000 },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      {
        backend: "claude",
        contextTokens: 120_000,
        contextWindowMax: 200_000,
      },
    );
    expect(contextLimitEvaluation).toBe("rotation_required");
    if (state.metrics.backend === "claude") {
      expect(state.metrics.rotateBeforeNextTurn).toBe(true);
    }
  });

  it("reports metrics_unavailable without flagging rotation when a limit is configured but contextTokens is absent", async () => {
    const store = createInMemoryLaneStore();
    await store.write(
      buildClaudeLane({
        policy: { continuityEnabled: true, contextLimitTokens: 100_000 },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", conversationId: "conv-validator" },
    );
    expect(contextLimitEvaluation).toBe("metrics_unavailable");
    if (state.metrics.backend === "claude") {
      expect(state.metrics.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("reports disabled when no limit is configured", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane({ policy: { continuityEnabled: true } }));
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", contextTokens: 199_000, contextWindowMax: 200_000 },
    );
    expect(contextLimitEvaluation).toBe("disabled");
    if (state.metrics.backend === "claude") {
      expect(state.metrics.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("captures an updated conversationId when the backend rotates the session reference", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", conversationId: "conv-rotated" },
    );
    expect(state.backendState).toMatchObject({
      conversationId: "conv-rotated",
    });
  });

  it("records stale-session recovery metadata when the outcome flags it", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", staleSession: true },
    );
    expect(state.backendState).toMatchObject({ staleSession: true });
  });

  it("flags rotation when the turn auto-compacted under a configured limit even with tokens below the limit", async () => {
    const store = createInMemoryLaneStore();
    await store.write(
      buildClaudeLane({
        policy: { continuityEnabled: true, contextLimitTokens: 100_000 },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      {
        backend: "claude",
        contextTokens: 40_000,
        contextWindowMax: 200_000,
        compactedThisTurn: true,
      },
    );
    expect(contextLimitEvaluation).toBe("rotation_required");
    if (state.metrics.backend === "claude") {
      expect(state.metrics.rotateBeforeNextTurn).toBe(true);
    }
  });

  it("does not flag rotation on compaction when no limit is configured (disabled short-circuits)", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane({ policy: { continuityEnabled: true } }));
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      {
        backend: "claude",
        contextTokens: 40_000,
        contextWindowMax: 200_000,
        compactedThisTurn: true,
      },
    );
    expect(contextLimitEvaluation).toBe("disabled");
    if (state.metrics.backend === "claude") {
      expect(state.metrics.rotateBeforeNextTurn).toBe(false);
    }
  });
});

describe("createLaneService — recordOutcome (Codex)", () => {
  it("records last turn usage and the captured threadId without inventing context-window metrics", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildCodexLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "secondary" },
      {
        backend: "codex",
        threadId: "thr-real",
        lastTurnUsage: {
          inputTokens: 100,
          cachedInputTokens: 10,
          outputTokens: 50,
        },
      },
    );
    expect(contextLimitEvaluation).toBe("disabled");
    expect(state.backendState).toMatchObject({ threadId: "thr-real" });
    if (state.metrics.backend === "codex") {
      expect(state.metrics.lastTurnUsage?.inputTokens).toBe(100);
      expect(state.metrics).not.toHaveProperty("contextTokens");
    }
  });

  it("flags rotateBeforeNextTurn when the Codex turn failed while keeping the label disabled with no limit", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildCodexLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "secondary" },
      { backend: "codex", failed: true },
    );
    expect(contextLimitEvaluation).toBe("disabled");
    if (state.metrics.backend === "codex") {
      expect(state.metrics.rotateBeforeNextTurn).toBe(true);
    }
  });

  it("reports unsupported when a limit is configured, without routing Codex rotation through the gate", async () => {
    const store = createInMemoryLaneStore();
    await store.write(
      buildCodexLane({
        policy: { continuityEnabled: true, contextLimitTokens: 50_000 },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "secondary" },
      { backend: "codex", failed: true },
    );
    expect(contextLimitEvaluation).toBe("unsupported");
    if (state.metrics.backend === "codex") {
      expect(state.metrics.rotateBeforeNextTurn).toBe(true);
    }
  });
});

describe("createLaneService — invariants", () => {
  it("throws when recording an outcome for a lane that has not been initialized", async () => {
    const service = createLaneService({
      store: createInMemoryLaneStore(),
      now: clockOnce(T1),
    });
    await expect(
      service.recordOutcome(
        { workflowId: "wf-A", laneId: "ghost" },
        { backend: "claude" },
      ),
    ).rejects.toThrow(/not initialized/i);
  });

  it("rejects an outcome whose backend tag does not match the lane's backend", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    await expect(
      service.recordOutcome({ workflowId: "wf-A", laneId: "primary" }, {
        backend: "codex",
        threadId: "thr-x",
      } as LaneOutcome),
    ).rejects.toThrow(/backend/i);
  });

  it("keeps rotation sticky once flagged even when a later turn comes back below the limit", async () => {
    const store = createInMemoryLaneStore();
    await store.write(
      buildClaudeLane({
        policy: { continuityEnabled: true, contextLimitTokens: 100_000 },
        metrics: {
          backend: "claude",
          contextTokens: 120_000,
          contextWindowMax: 200_000,
          rotateBeforeNextTurn: true,
        },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state, contextLimitEvaluation } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", contextTokens: 80_000, contextWindowMax: 200_000 },
    );
    expect(contextLimitEvaluation).toBe("rotation_required");
    if (state.metrics.backend === "claude") {
      expect(state.metrics.rotateBeforeNextTurn).toBe(true);
    }
  });
});
