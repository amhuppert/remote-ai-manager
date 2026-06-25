import { describe, it, expect, vi } from "vitest";
import type { Logger } from "@/lib/logging";
import {
  createSessionToolsSupervisor,
  type SessionToolsSupervisorDeps,
} from "./session-tools-supervisor";
import type { SdkMcpStreamClosedInfo } from "./query-session";

// ---------------------------------------------------------------------------
// Test doubles — plain objects satisfying the deps interface (DI, no vi.mock)
// ---------------------------------------------------------------------------

function noopLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

interface Harness {
  deps: SessionToolsSupervisorDeps;
  rebind: ReturnType<typeof vi.fn>;
  escalateToKill: ReturnType<typeof vi.fn>;
  setDead(dead: boolean): void;
  setQuestionPending(pending: boolean): void;
}

function makeHarness(
  overrides: {
    rebind?: () => Promise<void>;
    dead?: boolean;
    questionPending?: boolean;
  } = {},
): Harness {
  let dead = overrides.dead ?? false;
  let questionPending = overrides.questionPending ?? false;
  let clock = 1000;

  const rebind = vi.fn(overrides.rebind ?? (async () => {}));
  const escalateToKill = vi.fn();

  const deps: SessionToolsSupervisorDeps = {
    conversationId: "conv-test",
    rebind,
    escalateToKill,
    isDead: () => dead,
    isQuestionPending: () => questionPending,
    now: () => (clock += 5),
    logger: noopLogger(),
  };

  return {
    deps,
    rebind,
    escalateToKill,
    setDead: (d) => {
      dead = d;
    },
    setQuestionPending: (p) => {
      questionPending = p;
    },
  };
}

function streamClosed(): SdkMcpStreamClosedInfo {
  return {
    serverName: "cc-session-tools",
    toolName: "mcp__cc-session-tools__AskUserQuestion",
    consecutiveCount: 0,
  };
}

// Flush microtasks so a fire-and-forget rebind kicked off by onStreamClosed
// has a chance to settle before assertions.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SessionToolsSupervisor.ensureReady", () => {
  it("does not rebind on the first turn — the initial bind is already fresh", async () => {
    const h = makeHarness();
    const sup = createSessionToolsSupervisor(h.deps);

    const result = await sup.ensureReady("turn_start");

    expect(result).toEqual({ status: "ready" });
    expect(h.rebind).not.toHaveBeenCalled();
    expect(sup.health()).toBe("healthy");
  });

  it("forces a single rebind on a reused turn and reports ready on success", async () => {
    const h = makeHarness();
    const sup = createSessionToolsSupervisor(h.deps);

    await sup.ensureReady("turn_start"); // first turn: no rebind
    const result = await sup.ensureReady("turn_start"); // reused turn

    expect(result).toEqual({ status: "ready" });
    expect(h.rebind).toHaveBeenCalledTimes(1);
    expect(sup.health()).toBe("healthy");
  });

  it("returns recreate-runtime when the reused-turn rebind fails", async () => {
    const h = makeHarness({
      rebind: async () => {
        throw new Error("re-bind connect error");
      },
    });
    const sup = createSessionToolsSupervisor(h.deps);

    await sup.ensureReady("turn_start"); // consume the first-turn skip
    const result = await sup.ensureReady("turn_start");

    expect(result.status).toBe("recreate-runtime");
    expect(h.rebind).toHaveBeenCalledTimes(1);
  });

  it("returns recreate-runtime without rebinding when the runtime is already dead", async () => {
    const h = makeHarness({ dead: true });
    const sup = createSessionToolsSupervisor(h.deps);

    const result = await sup.ensureReady("turn_start");

    expect(result.status).toBe("recreate-runtime");
    expect(h.rebind).not.toHaveBeenCalled();
  });

  it("never rebinds while a question is validly pending (proactive guard)", async () => {
    const h = makeHarness({ questionPending: true });
    const sup = createSessionToolsSupervisor(h.deps);

    await sup.ensureReady("turn_start"); // first turn skip
    const result = await sup.ensureReady("turn_start"); // would normally rebind

    expect(result).toEqual({ status: "ready" });
    expect(h.rebind).not.toHaveBeenCalled();
  });
});

describe("SessionToolsSupervisor.onStreamClosed state machine", () => {
  it("rebinds once on the first cc-session-tools close and does not escalate on success", async () => {
    const h = makeHarness();
    const sup = createSessionToolsSupervisor(h.deps);

    sup.onStreamClosed(streamClosed());
    await flush();

    expect(h.rebind).toHaveBeenCalledTimes(1);
    expect(h.escalateToKill).not.toHaveBeenCalled();
    expect(sup.health()).toBe("healthy");
  });

  it("escalates to kill when the first-close rebind fails", async () => {
    const h = makeHarness({
      rebind: async () => {
        throw new Error("rebind failed");
      },
    });
    const sup = createSessionToolsSupervisor(h.deps);

    sup.onStreamClosed(streamClosed());
    await flush();

    expect(h.rebind).toHaveBeenCalledTimes(1);
    expect(h.escalateToKill).toHaveBeenCalledTimes(1);
    expect(sup.health()).toBe("dead");
  });

  it("escalates to kill on a second close in the same turn (after a rebind attempt)", async () => {
    const h = makeHarness();
    const sup = createSessionToolsSupervisor(h.deps);

    sup.onStreamClosed(streamClosed());
    await flush();
    expect(h.escalateToKill).not.toHaveBeenCalled();

    sup.onStreamClosed(streamClosed());
    await flush();

    expect(h.escalateToKill).toHaveBeenCalledTimes(1);
  });

  it("stays dead when the first-close rebind resolves after a second-close escalation", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({ rebind: () => gate });
    const sup = createSessionToolsSupervisor(h.deps);

    sup.onStreamClosed(streamClosed());
    await flush();

    sup.onStreamClosed(streamClosed());
    expect(h.escalateToKill).toHaveBeenCalledTimes(1);
    expect(sup.health()).toBe("dead");

    release();
    await flush();

    expect(sup.health()).toBe("dead");
  });

  it("resets the per-turn close count at each turn boundary (ensureReady turn_start)", async () => {
    const h = makeHarness();
    const sup = createSessionToolsSupervisor(h.deps);

    // Turn 1: one close, rebind succeeds, no escalation.
    sup.onStreamClosed(streamClosed());
    await flush();

    // Turn boundary.
    await sup.ensureReady("turn_start");

    // Turn 2: a single close must NOT count as the "second close" — no kill.
    sup.onStreamClosed(streamClosed());
    await flush();

    expect(h.escalateToKill).not.toHaveBeenCalled();
  });

  it("ignores stream-closed signals once the runtime is dead", async () => {
    const h = makeHarness({ dead: true });
    const sup = createSessionToolsSupervisor(h.deps);

    sup.onStreamClosed(streamClosed());
    await flush();

    expect(h.rebind).not.toHaveBeenCalled();
    expect(h.escalateToKill).not.toHaveBeenCalled();
  });
});

describe("SessionToolsSupervisor single-flight rebind", () => {
  it("joins an in-flight rebind rather than starting a concurrent second one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = makeHarness({ rebind: () => gate });
    const sup = createSessionToolsSupervisor(h.deps);

    await sup.ensureReady("turn_start"); // first-turn skip
    const p = sup.ensureReady("turn_start"); // starts rebind (blocked on gate)
    sup.onStreamClosed(streamClosed()); // must join, not start a 2nd rebind
    await flush();

    expect(h.rebind).toHaveBeenCalledTimes(1);

    release();
    await p;
  });
});

describe("SessionToolsSupervisor.markUnhealthy / health", () => {
  it("reflects an explicit markUnhealthy and recovers to healthy after a rebind", async () => {
    const h = makeHarness();
    const sup = createSessionToolsSupervisor(h.deps);

    expect(sup.health()).toBe("healthy");
    sup.markUnhealthy("status_probe");
    expect(sup.health()).toBe("unhealthy");

    await sup.ensureReady("turn_start"); // first-turn skip -> healthy
    expect(sup.health()).toBe("healthy");
  });
});
