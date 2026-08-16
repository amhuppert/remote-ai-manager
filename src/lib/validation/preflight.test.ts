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
              command: {
                full: "scripts/validate/test-full-suite.sh",
                changed: "scripts/validate/test.sh",
              },
              cost: 8,
              pathArgs: "paths",
            },
          },
          preMerge: ["test"],
        },
        undefined,
      ),
    ).toEqual({
      commandCosts: { test: 8 },
      concurrencyLimit: 8,
      laneMergeCommands: ["test"],
    });
  });

  it("projects a table cost declaration unchanged", () => {
    expect(
      createValidationCommandPreflight(
        {
          commands: {
            test: {
              command: {
                full: "scripts/validate/test-full-suite.sh",
                changed: "scripts/validate/test.sh",
              },
              cost: { full: 8, changed: 4, paths: { base: 1, perPath: 1 } },
              pathArgs: "paths",
            },
          },
          preMerge: ["test"],
        },
        undefined,
      ).commandCosts,
    ).toEqual({
      test: { full: 8, changed: 4, paths: { base: 1, perPath: 1 } },
    });
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

  it("rejects a table cost whose full weight exceeds the limit", () => {
    const rejection = validationCostExceedsLimit("test", {
      commandCosts: {
        test: { full: 12, changed: 3, paths: { base: 1, perPath: 1 } },
      },
      concurrencyLimit: 8,
    });

    expect(rejection).toMatchObject({
      code: "validation_cost_exceeds_limit",
      name: "test",
      cost: 12,
      limit: 8,
    });
    expect(rejection?.message).toContain("maximum configured cost 12");
    expect(rejection?.message).toContain("global limit 8");
  });

  it("accepts a table cost whose full weight fits the limit", () => {
    expect(
      validationCostExceedsLimit("test", {
        commandCosts: {
          test: { full: 4, changed: 2, paths: { base: 1, perPath: 0 } },
        },
        concurrencyLimit: 4,
      }),
    ).toBeNull();
  });
});
