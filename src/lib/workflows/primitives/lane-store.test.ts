import { describe, expect, it } from "vitest";
import {
  createInMemoryLaneStore,
  createSessionStateLaneStore,
  type SessionStateLaneStoreSessionLike,
} from "./lane-store";
import type { LaneState } from "./lane-vocabulary";

const NOW = "2026-04-28T10:00:00.000Z";

function claudeLane(overrides: Partial<LaneState> = {}): LaneState {
  return {
    workflowId: "wf-A",
    laneId: "primary",
    backend: "claude",
    writeCapability: "write_capable",
    policy: { continuityEnabled: true },
    backendState: { backend: "claude", conversationId: "conv-1" },
    metrics: { backend: "claude", rotateBeforeNextTurn: false },
    lastUsedAt: NOW,
    ...overrides,
  };
}

describe("createInMemoryLaneStore", () => {
  it("returns null when no state has been written for the ref", async () => {
    const store = createInMemoryLaneStore();
    const result = await store.read({ workflowId: "wf-A", laneId: "primary" });
    expect(result).toBeNull();
  });

  it("round-trips a written lane state through read", async () => {
    const store = createInMemoryLaneStore();
    const state = claudeLane();
    await store.write(state);
    const read = await store.read({ workflowId: "wf-A", laneId: "primary" });
    expect(read).toEqual(state);
  });

  it("scopes lane state by workflow so identical laneIds across workflows do not collide", async () => {
    const store = createInMemoryLaneStore();
    const a = claudeLane({ workflowId: "wf-A", laneId: "shared" });
    const b = claudeLane({
      workflowId: "wf-B",
      laneId: "shared",
      backendState: { backend: "claude", conversationId: "conv-B" },
    });
    await store.write(a);
    await store.write(b);

    const readA = await store.read({ workflowId: "wf-A", laneId: "shared" });
    const readB = await store.read({ workflowId: "wf-B", laneId: "shared" });

    expect(readA?.backendState).toMatchObject({ conversationId: "conv-1" });
    expect(readB?.backendState).toMatchObject({ conversationId: "conv-B" });
  });

  it("distinguishes lanes within the same workflow by laneId", async () => {
    const store = createInMemoryLaneStore();
    const primary = claudeLane({ laneId: "primary" });
    const secondary = claudeLane({ laneId: "secondary", backend: "codex" });
    const codexLane: LaneState = {
      ...secondary,
      backendState: { backend: "codex", threadId: "thr-9" },
      metrics: {
        backend: "codex",
        lastTurnUsage: null,
        rotateBeforeNextTurn: false,
      },
    };
    await store.write(primary);
    await store.write(codexLane);

    const readPrimary = await store.read({
      workflowId: "wf-A",
      laneId: "primary",
    });
    const readSecondary = await store.read({
      workflowId: "wf-A",
      laneId: "secondary",
    });

    expect(readPrimary?.backend).toBe("claude");
    expect(readSecondary?.backend).toBe("codex");
  });

  it("replaces an existing lane state on subsequent writes", async () => {
    const store = createInMemoryLaneStore();
    await store.write(claudeLane({ lastUsedAt: NOW }));
    const updated = claudeLane({
      lastUsedAt: "2026-04-28T11:00:00.000Z",
      metrics: {
        backend: "claude",
        contextTokens: 50_000,
        contextWindowMax: 200_000,
        rotateBeforeNextTurn: false,
      },
    });
    await store.write(updated);

    const read = await store.read({ workflowId: "wf-A", laneId: "primary" });
    expect(read?.lastUsedAt).toBe("2026-04-28T11:00:00.000Z");
    if (read?.metrics.backend === "claude") {
      expect(read.metrics.contextTokens).toBe(50_000);
    }
  });

  it("rejects writes whose payload tag mismatches do not pass the schema", async () => {
    const store = createInMemoryLaneStore();
    await expect(
      store.write({
        ...claudeLane(),
        backend: "codex",
      } as unknown as LaneState),
    ).rejects.toThrow();
  });

  it("supports listing lanes belonging to a single workflow", async () => {
    const store = createInMemoryLaneStore();
    await store.write(claudeLane({ workflowId: "wf-A", laneId: "alpha" }));
    await store.write(claudeLane({ workflowId: "wf-A", laneId: "beta" }));
    await store.write(claudeLane({ workflowId: "wf-B", laneId: "alpha" }));

    const wfA = await store.listByWorkflow("wf-A");
    expect(wfA.map((s) => s.laneId).sort()).toEqual(["alpha", "beta"]);
    const wfB = await store.listByWorkflow("wf-B");
    expect(wfB).toHaveLength(1);
    expect(wfB[0]?.workflowId).toBe("wf-B");
  });
});

describe("createSessionStateLaneStore", () => {
  it("persists lane state in the session workflowLanes collection", async () => {
    const session: SessionStateLaneStoreSessionLike = {};
    const labels: string[] = [];
    const store = createSessionStateLaneStore({
      projectPath: "/project",
      sessionName: "session-1",
      getSession: async () => session,
      mutateSession: async (_projectPath, _sessionName, label, mutate) => {
        labels.push(label);
        return mutate(session);
      },
    });

    await store.write(claudeLane());

    const read = await store.read({ workflowId: "wf-A", laneId: "primary" });
    expect(read).toEqual(claudeLane());
    expect(Object.keys(session.workflowLanes ?? {})).toHaveLength(1);
    expect(labels[0]).toBe("workflow-lane.write[wf-A/primary]");
  });

  it("preserves workflow scoping when listing session-backed lanes", async () => {
    const session: SessionStateLaneStoreSessionLike = {};
    const store = createSessionStateLaneStore({
      projectPath: "/project",
      sessionName: "session-1",
      getSession: async () => session,
      mutateSession: async (_projectPath, _sessionName, _label, mutate) =>
        mutate(session),
    });

    await store.write(claudeLane({ workflowId: "wf-A", laneId: "alpha" }));
    await store.write(claudeLane({ workflowId: "wf-A", laneId: "beta" }));
    await store.write(claudeLane({ workflowId: "wf-B", laneId: "alpha" }));

    const wfA = await store.listByWorkflow("wf-A");
    expect(wfA.map((s) => s.laneId).sort()).toEqual(["alpha", "beta"]);
  });

  it("deletes only the requested lane from session state", async () => {
    const session: SessionStateLaneStoreSessionLike = {};
    const store = createSessionStateLaneStore({
      projectPath: "/project",
      sessionName: "session-1",
      getSession: async () => session,
      mutateSession: async (_projectPath, _sessionName, _label, mutate) =>
        mutate(session),
    });

    await store.write(claudeLane({ workflowId: "wf-A", laneId: "keep" }));
    await store.write(claudeLane({ workflowId: "wf-A", laneId: "drop" }));

    await store.delete({ workflowId: "wf-A", laneId: "drop" });

    expect(
      await store.read({ workflowId: "wf-A", laneId: "keep" }),
    ).not.toBeNull();
    expect(await store.read({ workflowId: "wf-A", laneId: "drop" })).toBeNull();
  });
});
