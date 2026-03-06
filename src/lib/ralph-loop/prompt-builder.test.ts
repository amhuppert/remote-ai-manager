import { describe, it, expect } from "vitest";
import { buildIterationPrompt } from "./prompt-builder";
import type { FixPlanTask } from "@/types";

function makeTask(overrides: Partial<FixPlanTask> = {}): FixPlanTask {
  return {
    id: "task-1",
    description: "Implement feature X",
    group: 1,
    status: "pending",
    createdAt: "2024-01-01T00:00:00Z",
    completedAt: null,
    skipReason: null,
    addedByIteration: null,
    ...overrides,
  };
}

describe("PromptBuilder", () => {
  it("includes iteration header with number and max", () => {
    const prompt = buildIterationPrompt({
      objective: "Build a login page",
      fixPlan: [makeTask()],
      iterationNumber: 5,
      maxIterations: 20,
    });
    expect(prompt).toContain("Iteration 5 of 20");
  });

  it("includes the objective", () => {
    const prompt = buildIterationPrompt({
      objective: "Refactor the authentication module",
      fixPlan: [makeTask()],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).toContain("Refactor the authentication module");
  });

  it("organizes tasks by group with group headers", () => {
    const prompt = buildIterationPrompt({
      objective: "Test objective",
      fixPlan: [
        makeTask({ id: "t-g2", description: "Group 2 task", group: 2 }),
        makeTask({ id: "t-g1a", description: "Group 1 task A", group: 1 }),
        makeTask({ id: "t-g1b", description: "Group 1 task B", group: 1 }),
        makeTask({ id: "t-g3", description: "Group 3 task", group: 3 }),
      ],
      iterationNumber: 1,
      maxIterations: 10,
    });

    // Groups should appear in order
    const g1Idx = prompt.indexOf("### Group 1");
    const g2Idx = prompt.indexOf("### Group 2");
    const g3Idx = prompt.indexOf("### Group 3");
    expect(g1Idx).toBeGreaterThan(-1);
    expect(g2Idx).toBeGreaterThan(g1Idx);
    expect(g3Idx).toBeGreaterThan(g2Idx);

    // Tasks should appear under their groups
    expect(prompt).toContain("Group 1 task A");
    expect(prompt).toContain("Group 1 task B");
    expect(prompt).toContain("Group 2 task");
    expect(prompt).toContain("Group 3 task");
  });

  it("shows progress count for completed and skipped tasks", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [
        makeTask({ id: "t1", status: "completed" }),
        makeTask({ id: "t2", status: "skipped" }),
        makeTask({ id: "t3", status: "pending" }),
      ],
      iterationNumber: 3,
      maxIterations: 10,
    });
    expect(prompt).toContain("2/3 tasks resolved");
  });

  it("includes task IDs for update_fix_plan reference", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [makeTask({ id: "abc-123" })],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).toContain("[abc-123]");
  });

  it("excludes completed and skipped tasks from active list", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [
        makeTask({
          id: "t-done",
          description: "Done task",
          status: "completed",
        }),
        makeTask({
          id: "t-skip",
          description: "Skipped task",
          status: "skipped",
        }),
        makeTask({
          id: "t-pending",
          description: "Active task",
          status: "pending",
        }),
      ],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).not.toContain("Done task");
    expect(prompt).not.toContain("Skipped task");
    expect(prompt).toContain("Active task");
  });

  it("includes previous iteration context when provided", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [makeTask()],
      iterationNumber: 2,
      maxIterations: 10,
      previousIterationContext: {
        statusReport: {
          status: "in_progress",
          exit_signal: false,
          work_summary: "Set up the database schema",
          work_type: "implementation",
        },
        gitMetrics: {
          filesChanged: 3,
          linesAdded: 45,
          linesRemoved: 10,
          changedFiles: ["schema.ts", "migration.ts", "types.ts"],
        },
      },
    });
    expect(prompt).toContain("Previous Iteration Summary");
    expect(prompt).toContain("Set up the database schema");
    expect(prompt).toContain("Files changed: 3");
  });

  it("includes error context from previous iteration", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [makeTask()],
      iterationNumber: 3,
      maxIterations: 10,
      previousIterationContext: {
        errors: ["SDK timeout after 60s", "Module not found: utils"],
      },
    });
    expect(prompt).toContain("SDK timeout after 60s");
    expect(prompt).toContain("Module not found: utils");
  });

  it("omits previous context section when not provided", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [makeTask()],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).not.toContain("Previous Iteration Summary");
  });

  it("includes tool instructions for report_status and update_fix_plan", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [makeTask()],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).toContain("report_status");
    expect(prompt).toContain("update_fix_plan");
    expect(prompt).toContain("completedTaskIds");
    expect(prompt).toContain("exit_signal");
  });

  it("handles empty plan gracefully", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).toContain("No tasks defined");
  });

  it("includes reference documents section when references provided", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [makeTask()],
      references: [
        {
          filePath: "/tmp/worktree/memory-bank/ralph-reference/audit.md",
          description:
            "Testing audit findings — read when implementing DI changes",
        },
      ],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).toContain("## Reference Documents");
    expect(prompt).toContain(
      "/tmp/worktree/memory-bank/ralph-reference/audit.md",
    );
    expect(prompt).toContain("Testing audit findings");
  });

  it("omits reference documents section when no references", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [makeTask()],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).not.toContain("Reference Documents");
  });

  it("omits reference documents section when references is empty array", () => {
    const prompt = buildIterationPrompt({
      objective: "Test",
      fixPlan: [makeTask()],
      references: [],
      iterationNumber: 1,
      maxIterations: 10,
    });
    expect(prompt).not.toContain("Reference Documents");
  });
});
