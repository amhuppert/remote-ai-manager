import { describe, expect, it } from "vitest";
import {
  narrowTestFilesToFilters,
  readTestPathFilters,
  TEST_PATH_FILTERS_ENV,
} from "./test-path-filters";

const ROOT = "/repo";
const FILES = [
  "scripts/validate/worker-budget.test.ts",
  "scripts/validate/worker-budget-extra.test.ts",
  "src/components/ui/Button.test.tsx",
  "src/lib/validation/service.test.ts",
] as const;

describe("narrowTestFilesToFilters", () => {
  it("returns every file when no filter is given", () => {
    expect(narrowTestFilesToFilters(FILES, [], ROOT)).toEqual(FILES);
  });

  it("keeps a file whose repository-relative path contains the filter, case-insensitively", () => {
    expect(narrowTestFilesToFilters(FILES, ["WORKER-budget"], ROOT)).toEqual([
      "scripts/validate/worker-budget.test.ts",
      "scripts/validate/worker-budget-extra.test.ts",
    ]);
  });

  it("keeps a file selected by its exact repository-relative path", () => {
    expect(
      narrowTestFilesToFilters(
        FILES,
        ["src/lib/validation/service.test.ts"],
        ROOT,
      ),
    ).toEqual(["src/lib/validation/service.test.ts"]);
  });

  it("treats an absolute filter as a path prefix under the root", () => {
    expect(
      narrowTestFilesToFilters(FILES, [`${ROOT}/src/components/ui/`], ROOT),
    ).toEqual(["src/components/ui/Button.test.tsx"]);
  });

  it("treats a filter ending in a slash as a directory", () => {
    expect(narrowTestFilesToFilters(FILES, ["src/lib/"], ROOT)).toEqual([
      "src/lib/validation/service.test.ts",
    ]);
  });

  it("unions the matches of several filters in inventory order", () => {
    expect(
      narrowTestFilesToFilters(FILES, ["service.test", "Button"], ROOT),
    ).toEqual([
      "src/components/ui/Button.test.tsx",
      "src/lib/validation/service.test.ts",
    ]);
  });

  it("selects nothing for a filter that matches no file", () => {
    expect(narrowTestFilesToFilters(FILES, ["nowhere"], ROOT)).toEqual([]);
  });
});

describe("readTestPathFilters", () => {
  it("returns no filters when the variable is absent or empty", () => {
    expect(readTestPathFilters({})).toEqual([]);
    expect(readTestPathFilters({ [TEST_PATH_FILTERS_ENV]: "" })).toEqual([]);
  });

  it("decodes the JSON array the launcher writes", () => {
    expect(
      readTestPathFilters({
        [TEST_PATH_FILTERS_ENV]: JSON.stringify(["a.test.ts", "src/lib/"]),
      }),
    ).toEqual(["a.test.ts", "src/lib/"]);
  });

  it("rejects a value that is not a JSON array of strings", () => {
    expect(() =>
      readTestPathFilters({ [TEST_PATH_FILTERS_ENV]: '{"a":1}' }),
    ).toThrow(/CC_TEST_PATH_FILTERS/);
    expect(() =>
      readTestPathFilters({ [TEST_PATH_FILTERS_ENV]: "[1]" }),
    ).toThrow(/CC_TEST_PATH_FILTERS/);
  });
});
