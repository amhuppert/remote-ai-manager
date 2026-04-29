import { describe, expect, it } from "vitest";
import {
  laneBackendStateSchema,
  laneMetricsSchema,
  lanePolicySchema,
  laneStateSchema,
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

describe("laneBackendStateSchema", () => {
  it("preserves Claude-specific continuity fields", () => {
    const parsed = laneBackendStateSchema.parse({
      backend: "claude",
      conversationId: "conv-123",
      staleSession: false,
    });
    expect(parsed.backend).toBe("claude");
    if (parsed.backend === "claude") {
      expect(parsed.conversationId).toBe("conv-123");
      expect(parsed.staleSession).toBe(false);
    }
  });

  it("preserves Codex-specific continuity fields", () => {
    const parsed = laneBackendStateSchema.parse({
      backend: "codex",
      threadId: "thr-9",
    });
    expect(parsed.backend).toBe("codex");
    if (parsed.backend === "codex") {
      expect(parsed.threadId).toBe("thr-9");
      expect(parsed.staleSession).toBeUndefined();
    }
  });

  it("rejects mixing Claude state with a Codex thread id", () => {
    expect(
      laneBackendStateSchema.safeParse({
        backend: "claude",
        threadId: "thr-1",
      }).success,
    ).toBe(false);
  });

  it("allows initial state where the backend reference is not yet known", () => {
    const claude = laneBackendStateSchema.parse({ backend: "claude" });
    expect(claude.backend).toBe("claude");
    if (claude.backend === "claude") {
      expect(claude.conversationId).toBeUndefined();
    }
  });
});

describe("laneMetricsSchema", () => {
  it("captures Claude context metrics with rotation flag", () => {
    const parsed = laneMetricsSchema.parse({
      backend: "claude",
      contextTokens: 12_345,
      contextWindowMax: 200_000,
      rotateBeforeNextTurn: false,
    });
    expect(parsed.backend).toBe("claude");
    if (parsed.backend === "claude") {
      expect(parsed.contextTokens).toBe(12_345);
      expect(parsed.contextWindowMax).toBe(200_000);
      expect(parsed.rotateBeforeNextTurn).toBe(false);
    }
  });

  it("captures Codex turn usage without forcing context-window metrics", () => {
    const parsed = laneMetricsSchema.parse({
      backend: "codex",
      lastTurnUsage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 25,
      },
      rotateBeforeNextTurn: true,
    });
    expect(parsed.backend).toBe("codex");
    if (parsed.backend === "codex") {
      expect(parsed.lastTurnUsage?.outputTokens).toBe(25);
      expect(parsed.rotateBeforeNextTurn).toBe(true);
      // Codex never carries context-window metrics; the field is absent in
      // the discriminated branch rather than flattened into a fake default.
      expect(parsed).not.toHaveProperty("contextTokens");
      expect(parsed).not.toHaveProperty("contextWindowMax");
    }
  });

  it("rejects context-window metrics on a Codex metrics object", () => {
    expect(
      laneMetricsSchema.safeParse({
        backend: "codex",
        contextTokens: 5,
        rotateBeforeNextTurn: false,
      }).success,
    ).toBe(false);
  });

  it("rejects Codex turn usage on a Claude metrics object", () => {
    expect(
      laneMetricsSchema.safeParse({
        backend: "claude",
        lastTurnUsage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 1,
        },
        rotateBeforeNextTurn: false,
      }).success,
    ).toBe(false);
  });

  it("requires the rotation flag on every metrics shape", () => {
    expect(
      laneMetricsSchema.safeParse({
        backend: "claude",
      }).success,
    ).toBe(false);
    expect(
      laneMetricsSchema.safeParse({
        backend: "codex",
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
      writeCapability: "write_capable",
      policy: { continuityEnabled: true, contextLimitTokens: 180_000 },
      backendState: { backend: "claude", conversationId: "conv-1" },
      metrics: { backend: "claude", rotateBeforeNextTurn: false },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
      ...overrides,
    };
  }

  it("requires the backend tag to match the backend-state and metrics tags", () => {
    expect(
      laneStateSchema.safeParse(
        buildState({
          backend: "codex",
          backendState: { backend: "claude", conversationId: "conv-1" },
        }),
      ).success,
    ).toBe(false);

    expect(
      laneStateSchema.safeParse(
        buildState({
          metrics: {
            backend: "codex",
            lastTurnUsage: null,
            rotateBeforeNextTurn: false,
          } as never,
        }),
      ).success,
    ).toBe(false);
  });

  it("round-trips a Claude lane state with all supported fields populated", () => {
    const parsed = laneStateSchema.parse(
      buildState({
        backendState: {
          backend: "claude",
          conversationId: "conv-1",
          staleSession: false,
        },
        metrics: {
          backend: "claude",
          contextTokens: 100,
          contextWindowMax: 200_000,
          rotateBeforeNextTurn: false,
        },
      }),
    );
    expect(parsed.workflowId).toBe("collab-1");
    expect(parsed.laneId).toBe("primary");
    expect(parsed.backend).toBe("claude");
    expect(parsed.writeCapability).toBe("write_capable");
    expect(parsed.policy.contextLimitTokens).toBe(180_000);
  });

  it("round-trips a Codex lane state without inventing context-window metrics", () => {
    const parsed = laneStateSchema.parse({
      workflowId: "collab-1",
      laneId: "secondary",
      backend: "codex",
      writeCapability: "read_only",
      policy: { continuityEnabled: false },
      backendState: { backend: "codex", threadId: "thr-1" },
      metrics: {
        backend: "codex",
        lastTurnUsage: null,
        rotateBeforeNextTurn: false,
      },
      lastUsedAt: "2026-04-28T10:00:00.000Z",
    });
    expect(parsed.backend).toBe("codex");
    expect(parsed.metrics.backend).toBe("codex");
    if (parsed.metrics.backend === "codex") {
      expect(parsed.metrics.lastTurnUsage).toBeNull();
    }
  });

  it("rejects empty workflow or lane identifiers", () => {
    expect(
      laneStateSchema.safeParse(buildState({ workflowId: "" })).success,
    ).toBe(false);
    expect(laneStateSchema.safeParse(buildState({ laneId: "" })).success).toBe(
      false,
    );
  });
});
