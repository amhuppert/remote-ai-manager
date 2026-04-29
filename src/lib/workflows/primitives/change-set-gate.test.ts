import { describe, expect, it } from "vitest";
import { runChangeSetGate } from "./change-set-gate";
import { gateResultSchema } from "./gate-vocabulary";

describe("runChangeSetGate", () => {
  it("passes when changes are required and present", () => {
    const gate = runChangeSetGate({
      hasChanges: true,
      expectation: "required",
    });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("pass");
    expect(gate.kind).toBe("change_set");
    expect(gate.details).toMatchObject({
      expectation: "required",
      hasChanges: true,
    });
  });

  it("fails when changes are required but absent", () => {
    const gate = runChangeSetGate({
      hasChanges: false,
      expectation: "required",
    });
    expect(() => gateResultSchema.parse(gate)).not.toThrow();
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.kind).toBe("change_set");
    expect(gate.reason).toMatch(/no.*chang/i);
    expect(gate.details).toMatchObject({
      expectation: "required",
      hasChanges: false,
    });
  });

  it("passes when changes are forbidden and absent", () => {
    const gate = runChangeSetGate({
      hasChanges: false,
      expectation: "forbidden",
    });
    expect(gate.status).toBe("pass");
    expect(gate.details).toMatchObject({
      expectation: "forbidden",
      hasChanges: false,
    });
  });

  it("fails when changes are forbidden but present", () => {
    const gate = runChangeSetGate({
      hasChanges: true,
      expectation: "forbidden",
    });
    expect(gate.status).toBe("fail");
    if (gate.status !== "fail") return;
    expect(gate.reason).toMatch(/unexpected/i);
    expect(gate.details).toMatchObject({
      expectation: "forbidden",
      hasChanges: true,
    });
  });
});
