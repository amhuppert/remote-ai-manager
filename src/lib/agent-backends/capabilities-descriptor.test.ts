import { describe, expect, it } from "vitest";
import {
  queueDeliveryTimingSchema,
  queueCapabilityForBackend,
  backendCapabilities,
} from "@/lib/agent-backends/capabilities-descriptor";

describe("queueDeliveryTimingSchema", () => {
  it("accepts the in_turn and next_turn timings", () => {
    expect(queueDeliveryTimingSchema.parse("in_turn")).toBe("in_turn");
    expect(queueDeliveryTimingSchema.parse("next_turn")).toBe("next_turn");
  });

  it("rejects unknown timings", () => {
    expect(queueDeliveryTimingSchema.safeParse("eventually").success).toBe(
      false,
    );
  });
});

describe("queueCapabilityForBackend", () => {
  it("resolves Claude to in-turn delivery accepted while running", () => {
    expect(queueCapabilityForBackend("claude")).toEqual({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    });
  });

  it("resolves Codex to next-turn delivery accepted while running", () => {
    expect(queueCapabilityForBackend("codex")).toEqual({
      acceptsWhileRunning: true,
      deliveryTiming: "next_turn",
    });
  });
});

describe("backendCapabilities", () => {
  it("returns the full Claude capability object", () => {
    expect(backendCapabilities("claude")).toEqual({
      queueWhileRunning: true,
      askUserQuestion: true,
      preciseFork: true,
      portableMcpAtStart: true,
      portableMcpBetweenTurns: true,
      contextWindowMetrics: true,
    });
  });

  it("returns the full Codex capability object", () => {
    expect(backendCapabilities("codex")).toEqual({
      queueWhileRunning: false,
      askUserQuestion: true,
      preciseFork: false,
      portableMcpAtStart: true,
      portableMcpBetweenTurns: true,
      contextWindowMetrics: false,
    });
  });
});
