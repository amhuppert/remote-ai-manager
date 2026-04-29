import { describe, expect, it } from "vitest";
import { gateResultSchema } from "./gate-vocabulary";
import { runContextLimitGate } from "./context-limit-gate";
import type { LaneMetrics } from "./lane-vocabulary";

const claudeMetrics = (
  overrides: Partial<{
    contextTokens: number;
    contextWindowMax: number;
    rotateBeforeNextTurn: boolean;
  }> = {},
): LaneMetrics => ({
  backend: "claude",
  contextTokens: overrides.contextTokens,
  contextWindowMax: overrides.contextWindowMax,
  rotateBeforeNextTurn: overrides.rotateBeforeNextTurn ?? false,
});

const codexMetrics = (
  overrides: { rotateBeforeNextTurn?: boolean } = {},
): LaneMetrics => ({
  backend: "codex",
  rotateBeforeNextTurn: overrides.rotateBeforeNextTurn ?? false,
});

describe("runContextLimitGate", () => {
  it("returns pass with disabled evaluation when no contextLimitTokens policy is set", () => {
    const gate = runContextLimitGate({
      metrics: claudeMetrics({ contextTokens: 9_000_000 }),
      policy: {},
    });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pass");
    expect(gate.kind).toBe("context_limit");
    if (gate.status === "pass") {
      expect(gate.details).toMatchObject({ evaluation: "disabled" });
    }
  });

  it("returns pass with unsupported evaluation when the backend lacks context metrics", () => {
    const gate = runContextLimitGate({
      metrics: codexMetrics(),
      policy: { contextLimitTokens: 100_000 },
    });
    expect(gate.status).toBe("pass");
    if (gate.status === "pass") {
      expect(gate.details).toMatchObject({ evaluation: "unsupported" });
    }
  });

  it("returns pass with no_rotation evaluation when context tokens are below the limit", () => {
    const gate = runContextLimitGate({
      metrics: claudeMetrics({ contextTokens: 50_000 }),
      policy: { contextLimitTokens: 100_000 },
    });
    expect(gate.status).toBe("pass");
    if (gate.status === "pass") {
      expect(gate.details).toMatchObject({
        evaluation: "no_rotation",
        contextTokens: 50_000,
        limit: 100_000,
      });
    }
  });

  it("returns pass with no_rotation when context tokens exactly equal the limit", () => {
    const gate = runContextLimitGate({
      metrics: claudeMetrics({ contextTokens: 100_000 }),
      policy: { contextLimitTokens: 100_000 },
    });
    expect(gate.status).toBe("pass");
    if (gate.status === "pass") {
      expect(gate.details).toMatchObject({ evaluation: "no_rotation" });
    }
  });

  it("returns fail with rotation_required evaluation when context tokens exceed the limit", () => {
    const gate = runContextLimitGate({
      metrics: claudeMetrics({ contextTokens: 200_000 }),
      policy: { contextLimitTokens: 100_000 },
    });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.kind).toBe("context_limit");
      expect(gate.reason).toContain("rotation");
      expect(gate.details).toMatchObject({
        evaluation: "rotation_required",
        contextTokens: 200_000,
        limit: 100_000,
      });
    }
  });

  it("returns pass with metrics_unavailable evaluation when Claude metrics lack contextTokens", () => {
    const gate = runContextLimitGate({
      metrics: claudeMetrics({}),
      policy: { contextLimitTokens: 100_000 },
    });
    expect(gate.status).toBe("pass");
    if (gate.status === "pass") {
      expect(gate.details).toMatchObject({ evaluation: "metrics_unavailable" });
    }
  });

  it("respects an existing rotateBeforeNextTurn flag from the metrics", () => {
    const gate = runContextLimitGate({
      metrics: claudeMetrics({ rotateBeforeNextTurn: true }),
      policy: {},
    });
    expect(gate.status).toBe("fail");
    if (gate.status === "fail") {
      expect(gate.details).toMatchObject({ evaluation: "rotation_required" });
    }
  });
});
