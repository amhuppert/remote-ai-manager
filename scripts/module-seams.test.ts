import { describe, expect, it } from "vitest";
import { compareCycleBaseline, coreBoundaryViolations } from "./module-seams";

const allowance = {
  from: "a",
  to: "b",
  reason: "Existing composition cycle",
  removeWhen: "Composition moves outside the core",
};
describe("module seam ratchet", () => {
  it("rejects a newly cyclic edge even if an old cyclic edge survives", () => {
    expect(
      compareCycleBaseline(
        [
          { from: "a", to: "b" },
          { from: "b", to: "c" },
        ],
        [allowance],
      ).added,
    ).toEqual(["b -> c"]);
  });
  it("requires explicit downward ratcheting and rejects duplicate allowances", () => {
    expect(compareCycleBaseline([], [allowance, allowance])).toEqual({
      added: [],
      removed: ["a -> b"],
      duplicates: ["a -> b"],
    });
  });
  it("accepts exactly the reviewed surviving edges", () => {
    expect(compareCycleBaseline([{ from: "a", to: "b" }], [allowance])).toEqual(
      { added: [], removed: [], duplicates: [] },
    );
  });
  it("catches production wiring through an intermediate module", () => {
    const core = "src/lib/workflows/conversation/manager.ts";
    const production = "src/lib/workflows/production.ts";
    expect(
      coreBoundaryViolations(
        new Map([
          [core, ["bridge"]],
          ["bridge", [production]],
          [production, []],
        ]),
      ),
    ).toEqual([[core, "bridge", production]]);
  });
});
