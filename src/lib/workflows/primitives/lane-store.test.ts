import { describe, expect, it } from "vitest";
import {
  createInMemoryLaneStore,
  createSessionStateLaneStore,
  type SessionStateLaneCollection,
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
    ref: "conv-1",
    metrics: { rotateBeforeNextTurn: false },
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
      ref: "conv-B",
    });
    await store.write(a);
    await store.write(b);

    const readA = await store.read({ workflowId: "wf-A", laneId: "shared" });
    const readB = await store.read({ workflowId: "wf-B", laneId: "shared" });

    expect(readA?.ref).toBe("conv-1");
    expect(readB?.ref).toBe("conv-B");
  });

  it("distinguishes lanes within the same workflow by laneId", async () => {
    const store = createInMemoryLaneStore();
    const primary = claudeLane({ laneId: "primary" });
    const secondary = claudeLane({ laneId: "secondary", backend: "codex" });
    const codexLane: LaneState = {
      ...secondary,
      ref: "thr-9",
      metrics: {
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
        contextTokens: 50_000,
        contextWindowMax: 200_000,
        rotateBeforeNextTurn: false,
      },
    });
    await store.write(updated);

    const read = await store.read({ workflowId: "wf-A", laneId: "primary" });
    expect(read?.lastUsedAt).toBe("2026-04-28T11:00:00.000Z");
    expect(read?.metrics.contextTokens).toBe(50_000);
  });

  it("rejects writes that do not pass the lane schema (empty continuity handle)", async () => {
    const store = createInMemoryLaneStore();
    await expect(
      store.write({
        ...claudeLane(),
        ref: "",
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

/**
 * Backs the focused `mutateLanes` seam with an in-memory lane map shared with
 * `getSession`, so a `write`/`delete` and a subsequent `read`/`listByWorkflow`
 * observe the same collection (mirroring the focused single-column setter
 * loading the session's `workflowLanes` map, mutating it, and persisting it).
 */
function createFakeLaneSeam() {
  const session: SessionStateLaneCollection = {};
  const labels: string[] = [];
  return {
    session,
    labels,
    getSession: async () => session,
    mutateLanes: async <T>(
      _projectPath: string,
      _sessionName: string,
      label: string,
      mutate: (lanes: Record<string, unknown>) => T | Promise<T>,
    ): Promise<T> => {
      labels.push(label);
      if (!session.workflowLanes) session.workflowLanes = {};
      return mutate(session.workflowLanes);
    },
  };
}

describe("createSessionStateLaneStore", () => {
  it("persists lane state in the session workflowLanes collection", async () => {
    const seam = createFakeLaneSeam();
    const store = createSessionStateLaneStore({
      projectPath: "/project",
      sessionName: "session-1",
      getSession: seam.getSession,
      mutateLanes: seam.mutateLanes,
    });

    await store.write(claudeLane());

    const read = await store.read({ workflowId: "wf-A", laneId: "primary" });
    expect(read).toEqual(claudeLane());
    expect(Object.keys(seam.session.workflowLanes ?? {})).toHaveLength(1);
    expect(seam.labels[0]).toBe("workflow-lane.write[wf-A/primary]");
  });

  it("preserves workflow scoping when listing session-backed lanes", async () => {
    const seam = createFakeLaneSeam();
    const store = createSessionStateLaneStore({
      projectPath: "/project",
      sessionName: "session-1",
      getSession: seam.getSession,
      mutateLanes: seam.mutateLanes,
    });

    await store.write(claudeLane({ workflowId: "wf-A", laneId: "alpha" }));
    await store.write(claudeLane({ workflowId: "wf-A", laneId: "beta" }));
    await store.write(claudeLane({ workflowId: "wf-B", laneId: "alpha" }));

    const wfA = await store.listByWorkflow("wf-A");
    expect(wfA.map((s) => s.laneId).sort()).toEqual(["alpha", "beta"]);
  });

  it("deletes only the requested lane from session state", async () => {
    const seam = createFakeLaneSeam();
    const store = createSessionStateLaneStore({
      projectPath: "/project",
      sessionName: "session-1",
      getSession: seam.getSession,
      mutateLanes: seam.mutateLanes,
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
