import { describe, expect, it } from "vitest";
import {
  summarizeTestModules,
  projectTransformDuration,
} from "./test-timing-reporter";

describe("test timing evidence", () => {
  it("distinguishes unavailable transform measurements from measured zero", () => {
    expect(projectTransformDuration({})).toBeNull();
    expect(
      projectTransformDuration({ vitenode: { getTotalDuration: () => 0 } }),
    ).toBe(0);
    expect(
      projectTransformDuration({ vitenode: { getTotalDuration: () => 12 } }),
    ).toBe(12);
  });
  it("keeps collection, setup and execution distinct and unavailable transform time explicit", () => {
    const rows = summarizeTestModules("/repo", [
      {
        moduleId: "/repo/src/example.test.ts",
        project: { name: "unit-node" },
        state: () => "passed",
        diagnostic: () => ({
          collectDuration: 125,
          setupDuration: 12,
          duration: 8,
          environmentSetupDuration: 2,
          prepareDuration: 4,
          heap: undefined,
          importDurations: {},
        }),
      },
    ]);
    expect(rows).toEqual([
      {
        file: "src/example.test.ts",
        project: "unit-node",
        state: "passed",
        collectMs: 125,
        setupMs: 12,
        executionMs: 8,
        environmentMs: 2,
        prepareMs: 4,
        transformMs: null,
      },
    ]);
  });
});
