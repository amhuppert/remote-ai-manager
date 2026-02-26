import { describe, it, expect } from "vitest";
import { classifyProgress, parseNumstat } from "./progress-detector";
import type { GitIterationMetrics, ReportStatusInput } from "@/types";

describe("ProgressDetector", () => {
  describe("parseNumstat", () => {
    it("parses standard numstat output", () => {
      const output = "10\t2\tsrc/main.ts\n5\t0\tsrc/utils.ts\n";
      const result = parseNumstat(output);
      expect(result).toEqual({
        filesChanged: 2,
        linesAdded: 15,
        linesRemoved: 2,
        changedFiles: ["src/main.ts", "src/utils.ts"],
      });
    });

    it("handles binary files (- in numstat)", () => {
      const output = "-\t-\timage.png\n10\t2\tsrc/main.ts\n";
      const result = parseNumstat(output);
      expect(result.filesChanged).toBe(2);
      expect(result.linesAdded).toBe(10);
      expect(result.changedFiles).toEqual(["image.png", "src/main.ts"]);
    });

    it("handles empty output", () => {
      const result = parseNumstat("");
      expect(result).toEqual({
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        changedFiles: [],
      });
    });

    it("handles single file", () => {
      const output = "3\t1\tREADME.md\n";
      const result = parseNumstat(output);
      expect(result).toEqual({
        filesChanged: 1,
        linesAdded: 3,
        linesRemoved: 1,
        changedFiles: ["README.md"],
      });
    });
  });

  describe("classifyProgress", () => {
    const noChanges: GitIterationMetrics = {
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      changedFiles: [],
    };

    const withChanges: GitIterationMetrics = {
      filesChanged: 2,
      linesAdded: 10,
      linesRemoved: 3,
      changedFiles: ["a.ts", "b.ts"],
    };

    it("returns progress when files changed", () => {
      expect(classifyProgress(withChanges, null, 0)).toBe("progress");
    });

    it("returns progress when status report says complete", () => {
      const report: ReportStatusInput = {
        status: "complete",
        exit_signal: true,
        work_summary: "All done",
        work_type: "implementation",
      };
      expect(classifyProgress(noChanges, report, 0)).toBe("progress");
    });

    it("returns progress when tasks were completed", () => {
      expect(classifyProgress(noChanges, null, 2)).toBe("progress");
    });

    it("returns no_progress with no changes, no report", () => {
      expect(classifyProgress(noChanges, null, 0)).toBe("no_progress");
    });

    it("returns no_progress with no changes and in_progress report", () => {
      const report: ReportStatusInput = {
        status: "in_progress",
        exit_signal: false,
        work_summary: "Working on it",
        work_type: "implementation",
      };
      expect(classifyProgress(noChanges, report, 0)).toBe("no_progress");
    });

    it("returns no_progress with no changes and blocked report", () => {
      const report: ReportStatusInput = {
        status: "blocked",
        exit_signal: false,
        work_summary: "Stuck",
        work_type: "implementation",
      };
      expect(classifyProgress(noChanges, report, 0)).toBe("no_progress");
    });

    it("returns progress with no changes but undefined report and tasks completed", () => {
      expect(classifyProgress(noChanges, undefined, 1)).toBe("progress");
    });
  });
});
