import { describe, expect, it } from "vitest";
import { createInMemoryLaneStore } from "./lane-store";
import { createLaneService, deriveLaneOutcome } from "./lane-service";
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
    policy: { continuityEnabled: true },
    ref: "conv-1",
    metrics: {},
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
    ref: "thr-1",
    metrics: {
      lastTurnUsage: null,
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
    expect(result?.ref).toBe("conv-1");
    expect(result?.metrics).toMatchObject({});
  });

  it("scopes resolution by workflow so lanes from sibling workflows do not leak", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane({ workflowId: "wf-A", laneId: "p" }));
    await store.write(
      buildClaudeLane({
        workflowId: "wf-B",
        laneId: "p",
        ref: "conv-B",
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const fromA = await service.resolve({ workflowId: "wf-A", laneId: "p" });
    const fromB = await service.resolve({ workflowId: "wf-B", laneId: "p" });
    expect(fromA?.ref).toBe("conv-1");
    expect(fromB?.ref).toBe("conv-B");
  });
});

describe("createLaneService — initialize", () => {
  it("seeds a new lane state and returns the persisted result", async () => {
    const store = createInMemoryLaneStore();
    const service = createLaneService({ store, now: clockOnce(T1) });
    const seeded = await service.initialize(buildCodexLane());
    expect(seeded.lastUsedAt).toBe(T1);
    expect(seeded.ref).toBe("thr-1");
    const reread = await service.resolve({
      workflowId: "wf-A",
      laneId: "secondary",
    });
    expect(reread?.lastUsedAt).toBe(T1);
  });

  it("round-trips the optional CC dispatch conversation independently of the backend ref", async () => {
    const service = createLaneService({
      store: createInMemoryLaneStore(),
      now: clockOnce(T1),
    });
    const seeded = await service.initialize(
      buildCodexLane({ conversationId: "conv-dispatch-1" }),
    );

    expect(seeded.conversationId).toBe("conv-dispatch-1");
    expect(seeded.ref).toBe("thr-1");
  });

  it("replaces an existing lane state when re-initialized", async () => {
    const store = createInMemoryLaneStore();
    const service = createLaneService({ store, now: clockOnce(T1) });
    await service.initialize(buildClaudeLane());
    const replaced = await service.initialize(
      buildClaudeLane({ ref: "conv-replaced" }),
    );
    expect(replaced.ref).toBe("conv-replaced");
  });
});

describe("createLaneService — recordOutcome (Claude)", () => {
  it("records context metrics and advances the timestamp", async () => {
    const store = createInMemoryLaneStore();
    await store.write(
      buildClaudeLane({
        policy: { continuityEnabled: true },
      }),
    );
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      {
        backend: "claude",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
      },
    );
    expect(state.lastUsedAt).toBe(T1);
    expect(state.metrics.contextTokens).toBe(50_000);
    expect(state.metrics.contextWindowMax).toBe(200_000);
  });

  it("captures the updated backend reference", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", ref: "conv-updated" },
    );
    expect(state.ref).toBe("conv-updated");
  });

  it("records stale-session recovery metadata when the outcome flags it", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildClaudeLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "primary" },
      { backend: "claude", staleSession: true },
    );
    expect(state.staleSession).toBe(true);
  });
});

describe("createLaneService — recordOutcome (Codex)", () => {
  it("records last turn usage and the captured threadId without inventing context-window metrics", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildCodexLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "secondary" },
      {
        backend: "codex",
        ref: "thr-real",
        lastTurnUsage: {
          inputTokens: 100,
          cachedInputTokens: 10,
          outputTokens: 50,
        },
      },
    );
    expect(state.ref).toBe("thr-real");
    expect(state.metrics.lastTurnUsage?.inputTokens).toBe(100);
    expect(state.metrics).not.toHaveProperty("contextTokens");
  });

  it("preserves the reference for a retained failed turn", async () => {
    const store = createInMemoryLaneStore();
    await store.write(buildCodexLane());
    const service = createLaneService({ store, now: clockOnce(T1) });
    const { state } = await service.recordOutcome(
      { workflowId: "wf-A", laneId: "secondary" },
      { backend: "codex", continuationDisposition: "retain" },
    );
    expect(state.ref).toBe("thr-1");
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
        ref: "thr-x",
      } as LaneOutcome),
    ).rejects.toThrow(/backend/i);
  });
});

describe("deriveLaneOutcome — pure decision", () => {
  it("applies metrics against a supplied lane", () => {
    const { state } = deriveLaneOutcome(
      buildClaudeLane({
        policy: { continuityEnabled: true },
      }),
      { backend: "claude", contextTokens: 120_000, contextWindowMax: 200_000 },
      T1,
    );
    expect(state.metrics.contextTokens).toBe(120_000);
    expect(state.lastUsedAt).toBe(T1);
  });

  it("rejects an outcome whose backend does not match the supplied lane's backend", () => {
    expect(() =>
      deriveLaneOutcome(
        buildClaudeLane(),
        { backend: "codex" } as LaneOutcome,
        T1,
      ),
    ).toThrow(/backend/i);
  });
});
