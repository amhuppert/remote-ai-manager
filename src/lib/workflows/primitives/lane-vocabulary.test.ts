import { describe, expect, it } from "vitest";
import {
  laneMetricsSchema,
  lanePolicySchema,
  laneSessionRef,
  laneStateSchema,
  laneStorageKey,
  type LaneState,
} from "./lane-vocabulary";

describe("lanePolicySchema", () => {
  it("accepts continuity-enabled policy with optional context-limit threshold", () => {
    const parsed = lanePolicySchema.parse({
      continuityEnabled: true,
      contextLimitTokens: 150_000,
    });
    expect(parsed.continuityEnabled).toBe(true);
    expect(parsed.contextLimitTokens).toBe(150_000);
  });

  it("accepts continuity-disabled policy without a context-limit threshold", () => {
    const parsed = lanePolicySchema.parse({ continuityEnabled: false });
    expect(parsed.continuityEnabled).toBe(false);
    expect(parsed.contextLimitTokens).toBeUndefined();
  });

  it("rejects a non-positive context-limit threshold", () => {
    expect(
      lanePolicySchema.safeParse({
        continuityEnabled: true,
        contextLimitTokens: 0,
      }).success,
    ).toBe(false);
    expect(
      lanePolicySchema.safeParse({
        continuityEnabled: true,
        contextLimitTokens: -1,
      }).success,
    ).toBe(false);
  });
});

describe("laneMetricsSchema", () => {
  it("captures context metrics alongside the rotation flag", () => {
    const parsed = laneMetricsSchema.parse({
      contextTokens: 12_345,
      contextWindowMax: 200_000,
      rotateBeforeNextTurn: false,
    });
    expect(parsed.contextTokens).toBe(12_345);
    expect(parsed.contextWindowMax).toBe(200_000);
    expect(parsed.rotateBeforeNextTurn).toBe(false);
  });

  it("captures per-turn usage without forcing context-window metrics", () => {
    const parsed = laneMetricsSchema.parse({
      lastTurnUsage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 25,
      },
      rotateBeforeNextTurn: true,
    });
    expect(parsed.lastTurnUsage?.outputTokens).toBe(25);
    expect(parsed.rotateBeforeNextTurn).toBe(true);
    // Absent metrics stay absent rather than flattening into fake defaults.
    expect(parsed).not.toHaveProperty("contextTokens");
    expect(parsed).not.toHaveProperty("contextWindowMax");
  });

  it("requires the rotation flag", () => {
    expect(laneMetricsSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unknown metric fields (strict shape)", () => {
    expect(
      laneMetricsSchema.safeParse({
        rotateBeforeNextTurn: false,
        madeUpMetric: 1,
      }).success,
    ).toBe(false);
  });
});

describe("laneStateSchema", () => {
  function buildState(overrides: Partial<LaneState> = {}): LaneState {
    return {
      workflowId: "collab-1",
      laneId: "primary",
      backend: "claude",
      ref: "conv-1",
      writeCapability: "write_capable",
      policy: { continuityEnabled: true, contextLimitTokens: 180_000 },
      metrics: { rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
      ...overrides,
    };
  }

  it("round-trips a lane state with all supported fields populated", () => {
    const parsed = laneStateSchema.parse(
      buildState({
        staleSession: false,
        metrics: {
          contextTokens: 100,
          contextWindowMax: 200_000,
          rotateBeforeNextTurn: false,
        },
      }),
    );
    expect(parsed.workflowId).toBe("collab-1");
    expect(parsed.laneId).toBe("primary");
    expect(parsed.backend).toBe("claude");
    expect(parsed.ref).toBe("conv-1");
    expect(parsed.writeCapability).toBe("write_capable");
    expect(parsed.policy.contextLimitTokens).toBe(180_000);
    expect(parsed.staleSession).toBe(false);
  });

  it("accepts a null continuity handle for a lane with no backend session yet", () => {
    const parsed = laneStateSchema.parse(buildState({ ref: null }));
    expect(parsed.ref).toBeNull();
  });

  it("rejects an empty-string continuity handle", () => {
    expect(laneStateSchema.safeParse(buildState({ ref: "" })).success).toBe(
      false,
    );
  });

  it("rejects empty workflow or lane identifiers", () => {
    expect(
      laneStateSchema.safeParse(buildState({ workflowId: "" })).success,
    ).toBe(false);
    expect(laneStateSchema.safeParse(buildState({ laneId: "" })).success).toBe(
      false,
    );
  });

  it("laneSessionRef exposes the handle as an AgentSessionRef, null when absent", () => {
    expect(laneSessionRef(buildState())).toEqual({
      backend: "claude",
      ref: "conv-1",
    });
    expect(
      laneSessionRef(buildState({ backend: "codex", ref: "thr-9" })),
    ).toEqual({ backend: "codex", ref: "thr-9" });
    expect(laneSessionRef(buildState({ ref: null }))).toBeNull();
  });
});

describe("laneStorageKey", () => {
  it("produces distinct keys for ids that would collide under naive concatenation", () => {
    expect(
      laneStorageKey({ workflowId: "wf-a", laneId: "b-lane" }),
    ).not.toEqual(laneStorageKey({ workflowId: "wf-a-b", laneId: "lane" }));
  });
});
