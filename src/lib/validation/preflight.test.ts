import { describe, expect, it } from "vitest";
import {
  createValidationCommandPreflight,
  validationCostExceedsLimit,
} from "./preflight";

describe("validation command preflight", () => {
  it("projects canonical registry costs and uses the seeded global limit", () => {
    expect(
      createValidationCommandPreflight(
        {
          commands: {
            test: {
              command: "scripts/validate/test.sh",
              cost: 8,
              scopeArgs: "paths",
            },
          },
          preMerge: ["test"],
        },
        undefined,
      ),
    ).toEqual({ commandCosts: { test: 8 }, concurrencyLimit: 8 });
  });

  it("rejects configured cost above the limit without clamping", () => {
    expect(
      validationCostExceedsLimit("test", {
        commandCosts: { test: 5 },
        concurrencyLimit: 4,
      }),
    ).toMatchObject({
      code: "validation_cost_exceeds_limit",
      name: "test",
      cost: 5,
      limit: 4,
    });
  });
});
