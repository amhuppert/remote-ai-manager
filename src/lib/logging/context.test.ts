import { describe, it, expect } from "vitest";
import { runWithTrace, getTraceContext } from "./context";

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
