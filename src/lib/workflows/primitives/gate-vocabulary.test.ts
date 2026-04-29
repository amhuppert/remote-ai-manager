import { describe, expect, it } from "vitest";
import {
  GATE_KINDS,
  gateFail,
  gatePass,
  gatePauseMidTurn,
  gatePausePostTurn,
  gateResultSchema,
  isPauseGateResult,
  type GateKind,
} from "./gate-vocabulary";

describe("gateResultSchema", () => {
  it("accepts a pass result for every supported gate kind", () => {
    for (const kind of GATE_KINDS) {
      const parsed = gateResultSchema.parse({
        status: "pass",
        kind,
      });
      expect(parsed.status).toBe("pass");
      expect(parsed.kind).toBe(kind);
    }
  });

  it("accepts a fail result with reason and optional details", () => {
    const parsed = gateResultSchema.parse({
      status: "fail",
      kind: "structured_output",
      reason: "schema mismatch",
      details: { errors: ["invalid"] },
    });
    expect(parsed.status).toBe("fail");
    if (parsed.status === "fail") {
      expect(parsed.reason).toBe("schema mismatch");
      expect(parsed.details).toEqual({ errors: ["invalid"] });
    }
  });

  it("rejects a fail result without a reason", () => {
    const result = gateResultSchema.safeParse({
      status: "fail",
      kind: "script_validation",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a paused result with pauseKind and resumeToken", () => {
    const parsed = gateResultSchema.parse({
      status: "pause",
      kind: "human_approval",
      pauseKind: "post_turn",
      resumeToken: "rt-1",
    });
    expect(parsed.status).toBe("pause");
    if (parsed.status === "pause") {
      expect(parsed.pauseKind).toBe("post_turn");
      expect(parsed.resumeToken).toBe("rt-1");
    }
  });

  it("rejects a paused result without a resume token", () => {
    const result = gateResultSchema.safeParse({
      status: "pause",
      kind: "ask_user",
      pauseKind: "mid_turn",
      resumeToken: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a paused result with an unknown pauseKind", () => {
    const result = gateResultSchema.safeParse({
      status: "pause",
      kind: "ask_user",
      pauseKind: "weird_kind",
      resumeToken: "rt-9",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown gate kind", () => {
    const result = gateResultSchema.safeParse({
      status: "pass",
      kind: "not_a_real_gate" as GateKind,
    });
    expect(result.success).toBe(false);
  });
});

describe("gate factory invariants", () => {
  it("ask_user pauses are always mid_turn", () => {
    const pause = gatePauseMidTurn({
      kind: "ask_user",
      resumeToken: "rt-ask-1",
      details: { questions: [{ id: "q1" }] },
    });
    expect(pause.status).toBe("pause");
    expect(pause.kind).toBe("ask_user");
    expect(pause.pauseKind).toBe("mid_turn");
    expect(pause.resumeToken).toBe("rt-ask-1");
    expect(pause.details).toEqual({ questions: [{ id: "q1" }] });
  });

  it("human_approval pauses are always post_turn", () => {
    const pause = gatePausePostTurn({
      kind: "human_approval",
      resumeToken: "rt-approve-1",
    });
    expect(pause.status).toBe("pause");
    expect(pause.kind).toBe("human_approval");
    expect(pause.pauseKind).toBe("post_turn");
    expect(pause.resumeToken).toBe("rt-approve-1");
  });

  it("rejects pairing ask_user with post_turn", () => {
    const invalid = gateResultSchema.safeParse({
      status: "pause",
      kind: "ask_user",
      pauseKind: "post_turn",
      resumeToken: "rt-bad",
    });
    expect(invalid.success).toBe(false);
  });

  it("rejects pairing human_approval with mid_turn", () => {
    const invalid = gateResultSchema.safeParse({
      status: "pause",
      kind: "human_approval",
      pauseKind: "mid_turn",
      resumeToken: "rt-bad",
    });
    expect(invalid.success).toBe(false);
  });

  it("forbids constructing an ask_user pause via the post-turn helper", () => {
    expect(() =>
      gatePausePostTurn({
        kind: "ask_user" as Extract<GateKind, "human_approval">,
        resumeToken: "rt-bad",
      }),
    ).toThrow();
  });

  it("forbids constructing a human_approval pause via the mid-turn helper", () => {
    expect(() =>
      gatePauseMidTurn({
        kind: "human_approval" as Extract<GateKind, "ask_user">,
        resumeToken: "rt-bad",
      }),
    ).toThrow();
  });

  it("allows non-invariant gate kinds to choose either pause shape", () => {
    const mid = gatePauseMidTurn({
      kind: "circuit_breaker",
      resumeToken: "rt-cb-mid",
    });
    expect(mid.pauseKind).toBe("mid_turn");

    const post = gatePausePostTurn({
      kind: "convergence",
      resumeToken: "rt-conv-post",
    });
    expect(post.pauseKind).toBe("post_turn");
  });
});

describe("gate pass/fail factories", () => {
  it("gatePass produces a normalized pass envelope", () => {
    const result = gatePass({
      kind: "change_set",
      details: { hasDiff: false },
    });
    expect(result).toEqual({
      status: "pass",
      kind: "change_set",
      details: { hasDiff: false },
    });
  });

  it("gateFail carries reason verbatim and preserves details", () => {
    const result = gateFail({
      kind: "circuit_breaker",
      reason: "consecutive failure threshold reached",
      details: { failureCount: 3 },
    });
    expect(result.status).toBe("fail");
    if (result.status === "fail") {
      expect(result.reason).toBe("consecutive failure threshold reached");
      expect(result.details).toEqual({ failureCount: 3 });
    }
  });

  it("gateFail rejects an empty reason", () => {
    expect(() =>
      gateFail({
        kind: "structured_output",
        reason: "",
      }),
    ).toThrow();
  });

  it("gatePass omits details when not provided", () => {
    const result = gatePass({ kind: "change_set" });
    expect("details" in result).toBe(false);
  });
});

describe("isPauseGateResult", () => {
  it("returns true for a paused result", () => {
    const result = gatePauseMidTurn({
      kind: "ask_user",
      resumeToken: "rt-1",
    });
    expect(isPauseGateResult(result)).toBe(true);
  });

  it("returns false for pass and fail results", () => {
    expect(isPauseGateResult(gatePass({ kind: "change_set" }))).toBe(false);
    expect(
      isPauseGateResult(
        gateFail({ kind: "structured_output", reason: "mismatch" }),
      ),
    ).toBe(false);
  });
});
