// @vitest-inputs src/**/*.test.{ts,tsx,mjs} scripts/**/*.test.{ts,tsx,mjs}
// @vitest-inputs eslint-rules/**/*.test.{ts,tsx,mjs}
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { UserConfig } from "vitest/config";
import vitestConfig from "../vitest.config";
import { TEST_PATH_FILTERS_ENV } from "./test-path-filters";
import { buildRepositoryTestProfileInventory } from "./test-profiles";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const inventory = buildRepositoryTestProfileInventory(REPO_ROOT);
const resolvedConfig: UserConfig = await vitestConfig({
  command: "serve",
  mode: "test",
});

function testConfigFor(projectName: string): Record<string, unknown> {
  const projects: unknown = resolvedConfig.test?.projects;
  if (!Array.isArray(projects)) {
    throw new Error("vitest.config.ts no longer declares test.projects");
  }
  for (const project of projects) {
    if (typeof project !== "object" || project === null) continue;
    const test: unknown = Reflect.get(project, "test");
    if (typeof test !== "object" || test === null) continue;
    if (Reflect.get(test, "name") === projectName) {
      return test as Record<string, unknown>;
    }
  }
  throw new Error(`vitest.config.ts declares no "${projectName}" project`);
}

function includesFor(projectName: string): readonly string[] {
  const includes = testConfigFor(projectName)["include"];
  if (!Array.isArray(includes)) {
    throw new Error(`${projectName} has no include inventory`);
  }
  return includes.filter((entry): entry is string => typeof entry === "string");
}

describe("Vitest execution profiles", () => {
  it.each([
    ["unit-pure", "pure-node"],
    ["unit-node", "node-integration"],
    ["unit-jsdom", "dom-integration"],
    ["unit-architecture", "architecture-toolchain"],
    ["cursor-acceptance", "browser-live-acceptance"],
  ] as const)("maps %s to the %s inventory", (project, profile) => {
    const includes = includesFor(project);
    expect(includes).toHaveLength(inventory.byProfile[profile].length);
    expect(new Set(includes)).toEqual(new Set(inventory.byProfile[profile]));
  });

  it("narrows the unit include lists to the launcher's path filters", async () => {
    const previous = process.env[TEST_PATH_FILTERS_ENV];
    process.env[TEST_PATH_FILTERS_ENV] = JSON.stringify([
      "scripts/test-profile-config.test.ts",
      "src/components/ui/JsonTree.test",
    ]);
    try {
      const narrowed: UserConfig = await vitestConfig({
        command: "serve",
        mode: "test",
      });
      const projects: unknown = narrowed.test?.projects;
      const includesOf = (name: string): unknown => {
        if (!Array.isArray(projects)) throw new Error("no projects");
        const project: unknown = projects.find(
          (candidate: unknown) =>
            typeof candidate === "object" &&
            candidate !== null &&
            Reflect.get(Reflect.get(candidate, "test") ?? {}, "name") === name,
        );
        return Reflect.get(Reflect.get(project ?? {}, "test") ?? {}, "include");
      };
      expect(includesOf("unit-architecture")).toEqual([
        "scripts/test-profile-config.test.ts",
      ]);
      expect(includesOf("unit-jsdom")).toEqual([
        "src/components/ui/JsonTree.test.tsx",
      ]);
      expect(includesOf("unit-node")).toEqual([]);
      expect(includesOf("unit-pure")).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[TEST_PATH_FILTERS_ENV];
      else process.env[TEST_PATH_FILTERS_ENV] = previous;
    }
  });

  it("gives the pure cohort no setup file", () => {
    expect(testConfigFor("unit-pure")["setupFiles"]).toBeUndefined();
  });

  it("keeps integration profiles on their resource-owning setup", () => {
    expect(testConfigFor("unit-node")["setupFiles"]).toEqual([
      "vitest.node.setup.ts",
    ]);
    expect(testConfigFor("unit-jsdom")["setupFiles"]).toEqual([
      "vitest.jsdom.setup.ts",
    ]);
    expect(testConfigFor("unit-architecture")["setupFiles"]).toEqual([
      "vitest.node.setup.ts",
      "vitest.architecture.setup.ts",
    ]);
  });
});
