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
  it("records context metrics and bumps lastUsedAt without flagging rotation when below limit", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const updated = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      {
        backend: "claude",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
      },
    );
    expect(updated.lastUsedAt).toBe(T1);
    if (updated.metrics.backend === "claude") {
      expect(updated.metrics.contextTokens).toBe(50_000);
      expect(updated.metrics.contextWindowMax).toBe(200_000);
      expect(updated.metrics.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("flags rotateBeforeNextTurn when context tokens exceed the lane's configured limit", async () => {
    const store = createInMemoryLaneStore();
    await store.write(
      buildClaudeLane({
        policy: { continuityEnabled: true, contextLimitTokens: 100_000 },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const updated = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      {
        backend: "claude",
        contextTokens: 120_000,
        contextWindowMax: 200_000,
      },
    );
    if (updated.metrics.backend === "claude") {
      expect(updated.metrics.rotateBeforeNextTurn).toBe(true);
    }
  });

  it("captures an updated conversationId when the backend rotates the session reference", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const updated = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", conversationId: "conv-rotated" },
    );
    expect(updated.backendState).toMatchObject({
      conversationId: "conv-rotated",
    });
  });

  it("records stale-session recovery metadata when the outcome flags it", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const updated = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", staleSession: true },
    );
    expect(updated.backendState).toMatchObject({ staleSession: true });
  });
});

describe("createLaneService — recordOutcome (Codex)", () => {
  it("records last turn usage and the captured threadId without inventing context-window metrics", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildCodexLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const updated = await service.recordOutcome(
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
    expect(updated.backendState).toMatchObject({ threadId: "thr-real" });
    if (updated.metrics.backend === "codex") {
      expect(updated.metrics.lastTurnUsage?.inputTokens).toBe(100);
      expect(updated.metrics).not.toHaveProperty("contextTokens");
    }
  });

  it("flags rotateBeforeNextTurn when the Codex turn failed", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildCodexLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const updated = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "secondary" },
      { backend: "codex", failed: true },
    );
    if (updated.metrics.backend === "codex") {
      expect(updated.metrics.rotateBeforeNextTurn).toBe(true);
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

  it("clears rotation flag once a turn comes back below the configured limit", async () => {
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
    const updated = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", contextTokens: 80_000, contextWindowMax: 200_000 },
    );
    if (updated.metrics.backend === "claude") {
      expect(updated.metrics.rotateBeforeNextTurn).toBe(false);
    }
  });
});
