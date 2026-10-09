import { describe, expect, it } from "vitest";
import { checkoutHaltedRun } from "./fixtures";
import { dispositionOf, invocationIdOf } from "./actions";

describe("run page actions", () => {
  it("turns a chosen remedy into the disposition the run applies, carrying the person's reason or evidence", () => {
    const occurrence = "occ-1";
    expect(dispositionOf({ occurrence, remedy: { kind: "continue" } })).toEqual(
      { kind: "continue" },
    );
    expect(
      dispositionOf({
        occurrence,
        remedy: {
          kind: "grant",
          allowance: "validationRetries",
          used: 3,
          limit: 3,
        },
        note: "One more try at the flaky test",
        count: 2,
      }),
    ).toEqual({
      kind: "grant",
      allowance: "validationRetries",
      count: 2,
      reason: "One more try at the flaky test",
    });
    expect(
      dispositionOf({
        occurrence,
        remedy: { kind: "rereview" },
        note: "The reviewer misread the spec",
      }),
    ).toEqual({ kind: "rereview", reason: "The reviewer misread the spec" });
    expect(
      dispositionOf({
        occurrence,
        remedy: { kind: "confirm_effect" },
        note: "commit a41c9e0",
      }),
    ).toEqual({ kind: "confirm_effect", evidence: "commit a41c9e0" });
  });

  it("finds the started Context a context key names, and refuses one not started", () => {
    expect(invocationIdOf(checkoutHaltedRun, "plan")).toBe("checkout-plan-1");
    expect(() => invocationIdOf(checkoutHaltedRun, "docs")).toThrow(
      /has not started/,
    );
  });
});
