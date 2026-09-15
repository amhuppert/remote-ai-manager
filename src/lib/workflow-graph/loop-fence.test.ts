import { describe, expect, it, vi } from "vitest";
import { createWorkflowExecution } from "./test-fixtures";
import {
  StaleLoopFenceError,
  assertLoopFence,
  getCurrentLoopFence,
  loopFenceAppliesTo,
  matchesLoopFence,
  runWithLoopFence,
} from "./loop-fence";

const FENCE = {
  projectPath: "/repo",
  sessionName: "session-1",
  executionId: "execution-1",
  loopEpoch: 0,
};

describe("loop fence context", () => {
  it("recognizes stale-generation errors from another loaded runtime module", async () => {
    vi.resetModules();
    const runtimeModule = await import("./loop-fence");
    expect(new runtimeModule.StaleLoopFenceError(FENCE, null)).toBeInstanceOf(
      StaleLoopFenceError,
    );
  });

  it("enforces a route fence across independently loaded runtime modules", async () => {
    vi.resetModules();
    const routeModule = await import("./loop-fence");
    await routeModule.runWithLoopFence(FENCE, async () => {
      await Promise.resolve();
      expect(() =>
        assertLoopFence(
          "/repo",
          "session-1",
          createWorkflowExecution({
            id: FENCE.executionId,
            loopEpoch: FENCE.loopEpoch + 1,
          }),
        ),
      ).toThrow(StaleLoopFenceError);
    });
  });

  it("exposes the fence inside runWithLoopFence and clears it outside", async () => {
    expect(getCurrentLoopFence()).toBeNull();

    await runWithLoopFence(FENCE, async () => {
      expect(getCurrentLoopFence()).toEqual(FENCE);
      // Survives awaits within the fenced scope.
      await Promise.resolve();
      expect(getCurrentLoopFence()).toEqual(FENCE);
    });

    expect(getCurrentLoopFence()).toBeNull();
  });

  it("propagates the fence into promises created inside the scope even after it returns", async () => {
    // The execution loop spawns in-flight context tasks and may exit before
    // they settle; the tasks must keep their generation's fence.
    let observed: unknown = "unset";
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const task = runWithLoopFence(FENCE, async () => {
      await gate;
      observed = getCurrentLoopFence();
    });

    settle();
    await task;
    expect(observed).toEqual(FENCE);
  });
});

describe("matchesLoopFence", () => {
  it("matches only when both execution id and loop epoch are equal", () => {
    const execution = createWorkflowExecution({ id: "execution-1" });

    expect(matchesLoopFence(FENCE, execution)).toBe(true);
    expect(matchesLoopFence(FENCE, { ...execution, id: "execution-2" })).toBe(
      false,
    );
    expect(matchesLoopFence(FENCE, { ...execution, loopEpoch: 1 })).toBe(false);
    expect(matchesLoopFence(FENCE, null)).toBe(false);
  });
});

describe("assertLoopFence", () => {
  it("is a no-op when no fence is active (user/agent route writes)", () => {
    expect(() => assertLoopFence("/repo", "session-1", null)).not.toThrow();
    expect(() =>
      assertLoopFence(
        "/repo",
        "session-1",
        createWorkflowExecution({ id: "any" }),
      ),
    ).not.toThrow();
  });

  it("passes for the matching generation and throws StaleLoopFenceError otherwise", async () => {
    const execution = createWorkflowExecution({ id: "execution-1" });

    await runWithLoopFence(FENCE, async () => {
      expect(() =>
        assertLoopFence("/repo", "session-1", execution),
      ).not.toThrow();

      // Successor execution (this loop's execution was aborted/archived).
      expect(() =>
        assertLoopFence("/repo", "session-1", {
          ...execution,
          id: "execution-2",
        }),
      ).toThrow(StaleLoopFenceError);

      // Same execution, resumed since (new loop generation).
      expect(() =>
        assertLoopFence("/repo", "session-1", { ...execution, loopEpoch: 1 }),
      ).toThrow(StaleLoopFenceError);

      // Execution archived entirely.
      expect(() => assertLoopFence("/repo", "session-1", null)).toThrow(
        StaleLoopFenceError,
      );
    });
  });

  it("does not govern executions of other sessions touched from the fenced scope", async () => {
    // A fenced loop may legitimately reach into ANOTHER session (e.g. a
    // collaboration dispatch); the fence claims only its own session's state.
    await runWithLoopFence(FENCE, async () => {
      expect(() =>
        assertLoopFence(
          "/repo",
          "session-2",
          createWorkflowExecution({ id: "unrelated" }),
        ),
      ).not.toThrow();
      expect(() => assertLoopFence("/other", "session-1", null)).not.toThrow();
    });
  });

  it("reports the expected and observed generations on the error", async () => {
    await runWithLoopFence(FENCE, async () => {
      try {
        assertLoopFence(
          "/repo",
          "session-1",
          createWorkflowExecution({ id: "execution-2", loopEpoch: 5 }),
        );
        expect.unreachable("assertLoopFence must throw");
      } catch (error) {
        if (!(error instanceof StaleLoopFenceError)) throw error;
        expect(error.fence).toEqual(FENCE);
        expect(error.actualExecutionId).toBe("execution-2");
        expect(error.actualLoopEpoch).toBe(5);
      }
    });
  });
});

describe("loopFenceAppliesTo", () => {
  it("matches only the fence's own session", () => {
    expect(loopFenceAppliesTo(FENCE, "/repo", "session-1")).toBe(true);
    expect(loopFenceAppliesTo(FENCE, "/repo", "session-2")).toBe(false);
    expect(loopFenceAppliesTo(FENCE, "/other", "session-1")).toBe(false);
  });
});
