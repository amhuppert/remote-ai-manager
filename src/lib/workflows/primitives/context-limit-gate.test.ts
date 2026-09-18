import { afterEach, describe, expect, it } from "vitest";
import { gateResultSchema } from "./gate-vocabulary";
import {
  contextLimitEvaluationSchema,
  evaluateContextLimit,
  runContextLimitGate,
  type ContextLimitMetrics,
} from "./context-limit-gate";
import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "@/lib/agent-backends/registry-core";
import { bootstrapBackends } from "@/lib/agent-backends/registry";
import {
  createTestFakeBackend,
  TESTFAKE_BACKEND_ID,
} from "@/lib/agent-backends/testing/testfake-backend";

const claudeMetrics = (
  overrides: Partial<{
    contextTokens: number;
    rotateBeforeNextTurn: boolean;
  }> = {},
): ContextLimitMetrics => ({
  backend: "claude",
  contextTokens: overrides.contextTokens,
  rotateBeforeNextTurn: overrides.rotateBeforeNextTurn ?? false,
});

const codexMetrics = (
  overrides: { rotateBeforeNextTurn?: boolean } = {},
): ContextLimitMetrics => ({
  backend: "codex",
  rotateBeforeNextTurn: overrides.rotateBeforeNextTurn ?? false,
});

describe("evaluateContextLimit", () => {
  it("returns rotation_required when the lane already flags rotateBeforeNextTurn (no limit configured)", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({ rotateBeforeNextTurn: true }),
        policy: {},
      }),
    ).toBe("rotation_required");
  });

  it("returns rotation_required for the sticky case: rotateBeforeNextTurn true even when contextTokens are below the limit", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({
          rotateBeforeNextTurn: true,
          contextTokens: 10_000,
        }),
        policy: { contextLimitTokens: 100_000 },
      }),
    ).toBe("rotation_required");
  });

  it("returns disabled when no contextLimitTokens policy is configured", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({ contextTokens: 9_000_000 }),
        policy: {},
      }),
    ).toBe("disabled");
  });

  it.each(["codex", "cursor"] as const)(
    "returns unsupported for %s when occupancy and compaction are unknown",
    (backend) => {
      expect(
        evaluateContextLimit({
          metrics: { backend, rotateBeforeNextTurn: false },
          policy: { contextLimitTokens: 100_000 },
        }),
      ).toBe("unsupported");
    },
  );

  it("returns metrics_unavailable when a Claude lane has not recorded contextTokens", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({}),
        policy: { contextLimitTokens: 100_000 },
      }),
    ).toBe("metrics_unavailable");
  });

  it("returns rotation_required when contextTokens exceed the limit", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({ contextTokens: 200_000 }),
        policy: { contextLimitTokens: 100_000 },
      }),
    ).toBe("rotation_required");
  });

  it("returns no_rotation when contextTokens are at or below the limit", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({ contextTokens: 100_000 }),
        policy: { contextLimitTokens: 100_000 },
      }),
    ).toBe("no_rotation");
  });

  it("returns rotation_required when compactedThisTurn is set even though contextTokens are below the limit (the masking case)", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({ contextTokens: 10_000 }),
        policy: { contextLimitTokens: 100_000 },
        compactedThisTurn: true,
      }),
    ).toBe("rotation_required");
  });

  it("returns disabled for a compacted turn when no contextLimitTokens policy is configured", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({ contextTokens: 10_000 }),
        policy: {},
        compactedThisTurn: true,
      }),
    ).toBe("disabled");
  });

  it.each(["codex", "cursor"] as const)(
    "rotates after observed %s compaction without occupancy metrics",
    (backend) => {
      expect(
        evaluateContextLimit({
          metrics: { backend, rotateBeforeNextTurn: false },
          policy: { contextLimitTokens: 100_000 },
          compactedThisTurn: true,
        }),
      ).toBe("rotation_required");
    },
  );

  it.each(["codex", "cursor"] as const)(
    "leaves %s compaction rotation disabled without a limit policy",
    (backend) => {
      expect(
        evaluateContextLimit({
          metrics: { backend, rotateBeforeNextTurn: false },
          policy: {},
          compactedThisTurn: true,
        }),
      ).toBe("disabled");
    },
  );

  it("returns rotation_required when compacted with no recorded contextTokens (compaction masks the metric before metrics_unavailable)", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({}),
        policy: { contextLimitTokens: 100_000 },
        compactedThisTurn: true,
      }),
    ).toBe("rotation_required");
  });

  it("leaves non-compacted paths unchanged when compactedThisTurn is false", () => {
    expect(
      evaluateContextLimit({
        metrics: claudeMetrics({ contextTokens: 10_000 }),
        policy: { contextLimitTokens: 100_000 },
        compactedThisTurn: false,
      }),
    ).toBe("no_rotation");
  });

  it("exposes the full evaluation taxonomy via contextLimitEvaluationSchema", () => {
    expect(contextLimitEvaluationSchema.options).toEqual([
      "disabled",
      "unsupported",
      "metrics_unavailable",
      "no_rotation",
      "rotation_required",
    ]);
  });
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

describe("descriptor-driven metric support (consumer locality)", () => {
  afterEach(() => {
    _resetBackendRegistryForTesting();
    bootstrapBackends();
  });

  it("returns unsupported for a registered backend whose descriptor declares no context-window metrics", () => {
    const fake = createTestFakeBackend();
    _resetBackendRegistryForTesting();
    _registerBackendForTesting(fake.descriptor);

    expect(
      evaluateContextLimit({
        metrics: { backend: TESTFAKE_BACKEND_ID, rotateBeforeNextTurn: false },
        policy: { contextLimitTokens: 100_000 },
      }),
    ).toBe("unsupported");
  });

  it("evaluates occupancy for a registered backend whose descriptor declares context-window metrics", () => {
    const fake = createTestFakeBackend({
      capabilities: { contextWindowMetrics: true },
    });
    _resetBackendRegistryForTesting();
    _registerBackendForTesting(fake.descriptor);

    expect(
      evaluateContextLimit({
        metrics: { backend: TESTFAKE_BACKEND_ID, rotateBeforeNextTurn: false },
        policy: { contextLimitTokens: 100_000 },
      }),
    ).toBe("metrics_unavailable");

    expect(
      evaluateContextLimit({
        metrics: {
          backend: TESTFAKE_BACKEND_ID,
          contextTokens: 200_000,
          rotateBeforeNextTurn: false,
        },
        policy: { contextLimitTokens: 100_000 },
      }),
    ).toBe("rotation_required");

    const gate = runContextLimitGate({
      metrics: {
        backend: TESTFAKE_BACKEND_ID,
        contextTokens: 50_000,
        rotateBeforeNextTurn: false,
      },
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
});
