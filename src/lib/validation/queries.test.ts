import { describe, expect, it } from "vitest";
import { selectValidationCommandOptions } from "./queries";
import type { ValidationCommandsResponse } from "./schemas";

const response: ValidationCommandsResponse = {
  projects: [
    {
      projectName: "alpha",
      commands: [
        {
          name: "test",
          cost: 4,
          pathArgs: "paths",
          changedScope: "native",
        },
        {
          name: "typecheck",
          cost: 2,
          pathArgs: "forbid",
          changedScope: "full_fallback",
        },
      ],
    },
    {
      projectName: "beta",
      commands: [
        {
          name: "lint",
          cost: 1,
          pathArgs: "forbid",
          changedScope: "native",
        },
        {
          name: "typecheck",
          cost: 6,
          description: "beta's slower tsc",
          pathArgs: "forbid",
          changedScope: "full_fallback",
        },
      ],
    },
  ],
};

describe("selectValidationCommandOptions", () => {
  it("returns undefined while the registry is unavailable", () => {
    expect(selectValidationCommandOptions(undefined, null)).toBeUndefined();
    expect(selectValidationCommandOptions(undefined, "alpha")).toBeUndefined();
  });

  it("scopes to the named project's commands", () => {
    expect(selectValidationCommandOptions(response, "alpha")).toEqual([
      {
        name: "test",
        cost: 4,
        pathArgs: "paths",
        changedScope: "native",
      },
      {
        name: "typecheck",
        cost: 2,
        pathArgs: "forbid",
        changedScope: "full_fallback",
      },
    ]);
  });

  it("treats a project missing from the response as unavailable, not empty", () => {
    expect(
      selectValidationCommandOptions(response, "unreadable"),
    ).toBeUndefined();
  });

  it("unions across projects for the global scope, first occurrence winning", () => {
    expect(selectValidationCommandOptions(response, null)).toEqual([
      {
        name: "lint",
        cost: 1,
        pathArgs: "forbid",
        changedScope: "native",
      },
      {
        name: "test",
        cost: 4,
        pathArgs: "paths",
        changedScope: "native",
      },
      // alpha is listed first, so its typecheck summary wins the dedupe.
      {
        name: "typecheck",
        cost: 2,
        pathArgs: "forbid",
        changedScope: "full_fallback",
      },
    ]);
  });
});
