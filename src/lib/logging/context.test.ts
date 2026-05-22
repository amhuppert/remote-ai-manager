import { describe, it, expect } from "vitest";
import {
  runWithTrace,
  getTraceContext,
  captureTraceContext,
  runAsTrace,
  type TraceContext,
} from "./context";

describe("TraceContext", () => {
  it("returns undefined outside a traced context", () => {
    expect(getTraceContext()).toBeUndefined();
  });

  it("provides trace context within runWithTrace callback", () => {
    const ctx = { traceId: "test-trace-123", action: "test-action" };

    runWithTrace(ctx, () => {
      const result = getTraceContext();
      expect(result).toEqual(ctx);
    });
  });

  it("returns undefined after runWithTrace completes", () => {
    runWithTrace({ traceId: "temp" }, () => {
      // inside context
    });

    expect(getTraceContext()).toBeUndefined();
  });

  it("propagates context through async operations", async () => {
    const ctx = {
      traceId: "async-trace",
      action: "async-action",
      projectName: "my-project",
      sessionName: "my-session",
    };

    await runWithTrace(ctx, async () => {
      // Simulate async operation
      await Promise.resolve();
      const result = getTraceContext();
      expect(result).toEqual(ctx);
    });
  });

  it("supports nested contexts (inner overrides outer)", () => {
    const outer = { traceId: "outer" };
    const inner = { traceId: "inner", action: "inner-action" };

    runWithTrace(outer, () => {
      expect(getTraceContext()?.traceId).toBe("outer");

      runWithTrace(inner, () => {
        expect(getTraceContext()?.traceId).toBe("inner");
        expect(getTraceContext()?.action).toBe("inner-action");
      });

      // Outer context restored
      expect(getTraceContext()?.traceId).toBe("outer");
    });
  });

  it("allows optional fields to be omitted", () => {
    const ctx = { traceId: "minimal" };

    runWithTrace(ctx, () => {
      const result = getTraceContext();
      expect(result).toEqual({ traceId: "minimal" });
      expect(result?.action).toBeUndefined();
      expect(result?.projectName).toBeUndefined();
      expect(result?.sessionName).toBeUndefined();
    });
  });
});

describe("captureTraceContext", () => {
  it("returns null outside a traced context", () => {
    expect(captureTraceContext()).toBeNull();
  });

  it("returns a snapshot of the current trace context", () => {
    const ctx = {
      traceId: "snap-1",
      action: "snap-action",
      projectName: "snap-proj",
      sessionName: "snap-session",
    };

    runWithTrace(ctx, () => {
      expect(captureTraceContext()).toEqual(ctx);
    });
  });

  it("snapshot survives the original trace scope", async () => {
    let snapshot: ReturnType<typeof captureTraceContext> = null;

    runWithTrace({ traceId: "ephemeral", action: "x" }, () => {
      snapshot = captureTraceContext();
    });

    // Snapshot retains the captured value even after the scope exits.
    expect(snapshot).toEqual({ traceId: "ephemeral", action: "x" });
    expect(getTraceContext()).toBeUndefined();
  });
});

describe("runAsTrace", () => {
  it("runs fn inside a trace with a fresh traceId when no inherit is given", () => {
    let observed: TraceContext | undefined;
    runAsTrace("poll:test", () => {
      observed = getTraceContext();
    });

    expect(observed?.traceId).toBeTypeOf("string");
    expect(observed?.traceId.length).toBeGreaterThan(0);
    expect(observed?.action).toBe("poll:test");
  });

  it("inherits traceId and identifiers from the provided parent, overriding action", () => {
    const parent = {
      traceId: "parent-trace",
      action: "request:POST /api/foo",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv",
    };

    let observed: TraceContext | undefined;
    runAsTrace(
      "job:merge",
      () => {
        observed = getTraceContext();
      },
      parent,
    );

    expect(observed?.traceId).toBe("parent-trace");
    expect(observed?.projectName).toBe("proj");
    expect(observed?.sessionName).toBe("sess");
    expect(observed?.conversationId).toBe("conv");
    expect(observed?.action).toBe("job:merge");
  });

  it("mints a fresh traceId when inherit is null", () => {
    let observed: TraceContext | undefined;
    runAsTrace(
      "poll:test",
      () => {
        observed = getTraceContext();
      },
      null,
    );

    expect(observed?.traceId).toBeTypeOf("string");
    expect(observed?.traceId.length).toBeGreaterThan(0);
    expect(observed?.action).toBe("poll:test");
  });

  it("returns the value produced by fn", () => {
    const result = runAsTrace("compute", () => 42);
    expect(result).toBe(42);
  });

  it("propagates the new context through async work", async () => {
    let observed: TraceContext | undefined;
    await runAsTrace("async:job", async () => {
      await Promise.resolve();
      observed = getTraceContext();
    });

    expect(observed?.action).toBe("async:job");
  });

  it("each call without inherit produces a unique traceId", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 8; i += 1) {
      runAsTrace("poll:unique", () => {
        const id = getTraceContext()?.traceId;
        if (id) ids.add(id);
      });
    }
    expect(ids.size).toBe(8);
  });

  it("can be used inside an existing trace to override the scope", () => {
    runWithTrace({ traceId: "outer", action: "outer-action" }, () => {
      runAsTrace("inner:job", () => {
        const ctx = getTraceContext();
        expect(ctx?.action).toBe("inner:job");
        // No inherit passed: mints a fresh root, not the outer trace.
        expect(ctx?.traceId).not.toBe("outer");
      });
    });
  });
});
