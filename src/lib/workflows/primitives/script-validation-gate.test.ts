import { describe, expect, it } from "vitest";
import { gateResultSchema } from "./gate-vocabulary";
import {
  scriptValidationGateFromOutcome,
  type ScriptValidationOutcome,
} from "./script-validation-gate";

describe("scriptValidationGateFromOutcome", () => {
  it("returns a passing gate result for a successful script run", () => {
    const gate = scriptValidationGateFromOutcome({ kind: "pass" });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pass");
    expect(gate.kind).toBe("script_validation");
  });

  it("returns a failing gate result with validation_failed class for a script-reported failure", () => {
    const outcome: ScriptValidationOutcome = {
      kind: "fail",
      summary: "tests failed: 3 of 42",
      logFilePath: "/abs/path/to/log",
      logRelativePath: ".cc/workflow/exec-1/pre-merge-2026.log",
      timedOut: false,
    };
    const gate = scriptValidationGateFromOutcome(outcome);
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("script_validation");
    expect(gate.reason).toBe("tests failed: 3 of 42");
    expect(gate.details).toMatchObject({
      failureClass: "validation_failed",
      logFilePath: "/abs/path/to/log",
      logRelativePath: ".cc/workflow/exec-1/pre-merge-2026.log",
      timedOut: false,
    });
  });

  it("preserves the timedOut flag on validation failure", () => {
    const gate = scriptValidationGateFromOutcome({
      kind: "fail",
      summary: "validation timed out",
      logFilePath: "/abs/path",
      logRelativePath: "rel",
      timedOut: true,
    });
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.details).toMatchObject({ timedOut: true });
  });

  it("maps a validation failure without a log artifact (merge/commit fix loop) omitting the log detail fields", () => {
    const outcome: ScriptValidationOutcome = {
      kind: "fail",
      summary: "Pre-merge validation failed",
      timedOut: false,
    };
    const gate = scriptValidationGateFromOutcome(outcome);
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.reason).toBe("Pre-merge validation failed");
    expect(gate.details).toMatchObject({
      failureClass: "validation_failed",
      timedOut: false,
    });
    expect(gate.details).not.toHaveProperty("logFilePath");
    expect(gate.details).not.toHaveProperty("logRelativePath");
  });

  it("returns a failing gate result with infrastructure class for an exception", () => {
    const outcome: ScriptValidationOutcome = {
      kind: "infra_error",
      reason: "exception",
      message: "ENOENT: spawn failed",
    };
    const gate = scriptValidationGateFromOutcome(outcome);
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.reason).toBe("ENOENT: spawn failed");
    expect(gate.details).toMatchObject({
      failureClass: "infrastructure",
      infraReason: "exception",
    });
  });
});
