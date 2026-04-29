import { describe, expect, it } from "vitest";
import { runCircuitBreakerGate } from "./circuit-breaker-gate";
import { gateResultSchema } from "./gate-vocabulary";

describe("runCircuitBreakerGate", () => {
  it("passes when the failure count is below the threshold", () => {
    const gate = runCircuitBreakerGate({ failureCount: 1, threshold: 3 });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pass");
    expect(gate.kind).toBe("circuit_breaker");
    expect(gate.details).toMatchObject({
      failureCount: 1,
      threshold: 3,
      tripped: false,
    });
  });

  it("passes on a fresh lane with zero failures recorded", () => {
    const gate = runCircuitBreakerGate({ failureCount: 0, threshold: 3 });
    expect(gate.status).toBe("pass");
    expect(gate.details).toMatchObject({
      failureCount: 0,
      threshold: 3,
      tripped: false,
    });
  });

  it("fails when the failure count reaches the threshold exactly", () => {
    const gate = runCircuitBreakerGate({ failureCount: 3, threshold: 3 });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("circuit_breaker");
    expect(gate.reason).toMatch(/3.*3/);
    expect(gate.details).toMatchObject({
      failureCount: 3,
      threshold: 3,
      tripped: true,
    });
  });

  it("fails when the failure count exceeds the threshold", () => {
    const gate = runCircuitBreakerGate({ failureCount: 5, threshold: 3 });
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.details).toMatchObject({
      failureCount: 5,
      threshold: 3,
      tripped: true,
    });
  });

  it("rejects a non-positive threshold so callers cannot accidentally trip on the first failure", () => {
    expect(() =>
      runCircuitBreakerGate({ failureCount: 0, threshold: 0 }),
    ).toThrow();
    expect(() =>
      runCircuitBreakerGate({ failureCount: 0, threshold: -1 }),
    ).toThrow();
  });

  it("rejects a negative failure count", () => {
    expect(() =>
      runCircuitBreakerGate({ failureCount: -1, threshold: 3 }),
    ).toThrow();
  });
});
