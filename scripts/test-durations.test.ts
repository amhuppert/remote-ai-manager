import { describe, expect, it } from "vitest";
import { rankTestDurations, type CachedResultEntry } from "./test-durations";

const entries: CachedResultEntry[] = [
  ["unit-node:src/a.test.ts", { duration: 1000, failed: false }],
  ["unit-node:src/b.test.ts", { duration: 3000, failed: true }],
  ["unit-node:src/c.test.ts", { duration: 2000, failed: false }],
  ["unit-jsdom:src/d.test.tsx", { duration: 4000, failed: false }],
];

describe("rankTestDurations", () => {
  it("ranks files by execution time, longest first, with project and outcome", () => {
    const report = rankTestDurations(entries, 2);
    expect(report.slowest).toEqual([
      {
        file: "src/d.test.tsx",
        project: "unit-jsdom",
        seconds: 4,
        failed: false,
      },
      { file: "src/b.test.ts", project: "unit-node", seconds: 3, failed: true },
    ]);
  });

  it("totals and medians per project and states the share the listed files take", () => {
    const report = rankTestDurations(entries, 2);
    expect(report.fileCount).toBe(4);
    expect(report.totalSeconds).toBe(10);
    expect(report.byProject).toEqual({
      "unit-node": { count: 3, totalSeconds: 6, medianSeconds: 2 },
      "unit-jsdom": { count: 1, totalSeconds: 4, medianSeconds: 4 },
    });
    expect(report.slowestShare).toBeCloseTo(0.7);
  });

  it("lists failed files separately so a red full run is visible in the ledger", () => {
    expect(rankTestDurations(entries, 1).failedFiles).toEqual([
      "unit-node:src/b.test.ts",
    ]);
  });
});
