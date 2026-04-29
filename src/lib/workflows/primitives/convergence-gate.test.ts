import { describe, expect, it } from "vitest";
import { runConvergenceGate, type ConvergenceVote } from "./convergence-gate";
import { gateResultSchema } from "./gate-vocabulary";

describe("runConvergenceGate", () => {
  it("passes when every voter has accepted", () => {
    const votes: readonly ConvergenceVote[] = [
      { voter: "claude", decision: "accept" },
      { voter: "codex", decision: "accept" },
    ];
    const gate = runConvergenceGate({ votes });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pass");
    expect(gate.kind).toBe("convergence");
    expect(gate.details).toMatchObject({
      voterCount: 2,
      acceptCount: 2,
      rejectCount: 0,
    });
  });

  it("fails when any voter has rejected", () => {
    const votes: readonly ConvergenceVote[] = [
      { voter: "claude", decision: "accept" },
      { voter: "codex", decision: "reject", reason: "performance concern" },
    ];
    const gate = runConvergenceGate({ votes });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("convergence");
    expect(gate.reason).toMatch(/codex/);
    expect(gate.details).toMatchObject({
      voterCount: 2,
      acceptCount: 1,
      rejectCount: 1,
    });
    const rejectors = (
      gate.details as {
        rejectors?: ReadonlyArray<{ voter: string; reason?: string }>;
      }
    ).rejectors;
    expect(rejectors).toEqual([
      { voter: "codex", reason: "performance concern" },
    ]);
  });

  it("fails when every voter has rejected", () => {
    const votes: readonly ConvergenceVote[] = [
      { voter: "claude", decision: "reject" },
      { voter: "codex", decision: "reject" },
    ];
    const gate = runConvergenceGate({ votes });
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.details).toMatchObject({
      acceptCount: 0,
      rejectCount: 2,
    });
  });

  it("fails when there are no voters", () => {
    const gate = runConvergenceGate({ votes: [] });
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.reason).toMatch(/no voters|empty/i);
    expect(gate.details).toMatchObject({
      voterCount: 0,
    });
  });
});
