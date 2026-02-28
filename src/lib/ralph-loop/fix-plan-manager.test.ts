import { describe, it, expect } from "vitest";
import {
  createTask,
  completeTasks,
  skipTasks,
  addTasks,
  applyFixPlanUpdate,
  isAllResolved,
  getActiveTasksByGroup,
  getCurrentGroup,
  getTaskProgress,
} from "./fix-plan-manager";
import type { FixPlanTask } from "@/types";

function makeTask(overrides: Partial<FixPlanTask> = {}): FixPlanTask {
  return {
    id: "task-1",
    description: "Test task",
    group: 1,
    status: "pending",
    createdAt: "2024-01-01T00:00:00Z",
    completedAt: null,
    skipReason: null,
    addedByIteration: null,
    ...overrides,
  };
}

describe("FixPlanManager", () => {
  describe("createTask", () => {
    it("creates a task with generated ID and pending status", () => {
      const task = createTask({ description: "Fix bug", group: 1 });
      expect(task.id).toBeTruthy();
      expect(task.description).toBe("Fix bug");
      expect(task.group).toBe(1);
      expect(task.status).toBe("pending");
      expect(task.completedAt).toBeNull();
      expect(task.skipReason).toBeNull();
    });

    it("sets addedByIteration when provided", () => {
      const task = createTask({
        description: "New task",
        group: 3,
        addedByIteration: 5,
      });
      expect(task.addedByIteration).toBe(5);
    });
  });

  describe("completeTasks", () => {
    it("marks tasks as completed by IDs", () => {
      const plan = [
        makeTask({ id: "t1" }),
        makeTask({ id: "t2" }),
        makeTask({ id: "t3" }),
      ];
      const result = completeTasks(plan, ["t1", "t3"]);
      expect(result.completedIds).toEqual(["t1", "t3"]);
      expect(result.plan[0]!.status).toBe("completed");
      expect(result.plan[0]!.completedAt).toBeTruthy();
      expect(result.plan[1]!.status).toBe("pending");
      expect(result.plan[2]!.status).toBe("completed");
    });

    it("reports not found IDs", () => {
      const plan = [makeTask({ id: "t1" })];
      const result = completeTasks(plan, ["t1", "t-nonexistent"]);
      expect(result.completedIds).toEqual(["t1"]);
      expect(result.notFound).toEqual(["t-nonexistent"]);
    });

    it("handles empty task IDs", () => {
      const plan = [makeTask({ id: "t1" })];
      const result = completeTasks(plan, []);
      expect(result.completedIds).toEqual([]);
      expect(result.plan[0]!.status).toBe("pending");
    });
  });

  describe("skipTasks", () => {
    it("marks tasks as skipped with reason", () => {
      const plan = [makeTask({ id: "t1" }), makeTask({ id: "t2" })];
      const result = skipTasks(plan, [
        { taskId: "t1", reason: "No longer needed" },
      ]);
      expect(result.skippedIds).toEqual(["t1"]);
      expect(result.plan[0]!.status).toBe("skipped");
      expect(result.plan[0]!.skipReason).toBe("No longer needed");
      expect(result.plan[0]!.completedAt).toBeTruthy();
      expect(result.plan[1]!.status).toBe("pending");
    });

    it("reports not found IDs", () => {
      const plan = [makeTask({ id: "t1" })];
      const result = skipTasks(plan, [{ taskId: "t-nope", reason: "Gone" }]);
      expect(result.skippedIds).toEqual([]);
      expect(result.notFound).toEqual(["t-nope"]);
    });
  });

  describe("addTasks", () => {
    it("adds new tasks with generated IDs", () => {
      const plan = [makeTask({ id: "existing" })];
      const result = addTasks(
        plan,
        [
          { description: "New task A", group: 1 },
          { description: "New task B", group: 2 },
        ],
        3,
      );
      expect(result.plan).toHaveLength(3);
      expect(result.addedIds).toHaveLength(2);
      expect(result.plan[1]!.description).toBe("New task A");
      expect(result.plan[1]!.group).toBe(1);
      expect(result.plan[1]!.addedByIteration).toBe(3);
      expect(result.plan[2]!.description).toBe("New task B");
    });
  });

  describe("applyFixPlanUpdate", () => {
    it("applies all mutation types at once", () => {
      const plan = [
        makeTask({ id: "t1" }),
        makeTask({ id: "t2" }),
        makeTask({ id: "t3" }),
      ];
      const result = applyFixPlanUpdate(
        plan,
        {
          completedTaskIds: ["t1"],
          skippedTasks: [{ taskId: "t2", reason: "Not needed" }],
          newTasks: [{ description: "Discovered task", group: 1 }],
        },
        5,
      );
      expect(result.completedIds).toEqual(["t1"]);
      expect(result.skippedIds).toEqual(["t2"]);
      expect(result.addedIds).toHaveLength(1);
      expect(result.plan).toHaveLength(4);
      expect(result.plan[0]!.status).toBe("completed");
      expect(result.plan[1]!.status).toBe("skipped");
      expect(result.plan[2]!.status).toBe("pending");
      expect(result.plan[3]!.description).toBe("Discovered task");
    });

    it("handles partial updates", () => {
      const plan = [makeTask({ id: "t1" })];
      const result = applyFixPlanUpdate(plan, { completedTaskIds: ["t1"] }, 1);
      expect(result.completedIds).toEqual(["t1"]);
      expect(result.skippedIds).toEqual([]);
      expect(result.addedIds).toEqual([]);
    });

    it("collects all not-found IDs", () => {
      const plan = [makeTask({ id: "t1" })];
      const result = applyFixPlanUpdate(
        plan,
        {
          completedTaskIds: ["missing-1"],
          skippedTasks: [{ taskId: "missing-2", reason: "x" }],
        },
        1,
      );
      expect(result.notFoundIds).toEqual(["missing-1", "missing-2"]);
    });
  });

  describe("isAllResolved", () => {
    it("returns false for empty plan", () => {
      expect(isAllResolved([])).toBe(false);
    });

    it("returns true when all completed", () => {
      expect(
        isAllResolved([
          makeTask({ status: "completed" }),
          makeTask({ status: "completed" }),
        ]),
      ).toBe(true);
    });

    it("returns true when all skipped", () => {
      expect(isAllResolved([makeTask({ status: "skipped" })])).toBe(true);
    });

    it("returns true when mix of completed and skipped", () => {
      expect(
        isAllResolved([
          makeTask({ status: "completed" }),
          makeTask({ status: "skipped" }),
        ]),
      ).toBe(true);
    });

    it("returns false when any pending", () => {
      expect(
        isAllResolved([
          makeTask({ status: "completed" }),
          makeTask({ status: "pending" }),
        ]),
      ).toBe(false);
    });

    it("returns false when any in_progress", () => {
      expect(
        isAllResolved([
          makeTask({ status: "completed" }),
          makeTask({ status: "in_progress" }),
        ]),
      ).toBe(false);
    });
  });

  describe("getActiveTasksByGroup", () => {
    it("groups pending and in_progress tasks by group number", () => {
      const plan = [
        makeTask({ id: "g2-1", group: 2, status: "pending" }),
        makeTask({ id: "g1-1", group: 1, status: "pending" }),
        makeTask({ id: "g1-2", group: 1, status: "in_progress" }),
        makeTask({ id: "done", group: 1, status: "completed" }),
        makeTask({ id: "skip", group: 1, status: "skipped" }),
        makeTask({ id: "g3-1", group: 3, status: "pending" }),
      ];
      const grouped = getActiveTasksByGroup(plan);
      expect([...grouped.keys()]).toEqual([1, 2, 3]);
      expect(grouped.get(1)!.map((t) => t.id)).toEqual(["g1-1", "g1-2"]);
      expect(grouped.get(2)!.map((t) => t.id)).toEqual(["g2-1"]);
      expect(grouped.get(3)!.map((t) => t.id)).toEqual(["g3-1"]);
    });

    it("returns empty map for fully resolved plan", () => {
      const plan = [
        makeTask({ status: "completed" }),
        makeTask({ status: "skipped" }),
      ];
      expect(getActiveTasksByGroup(plan).size).toBe(0);
    });
  });

  describe("getCurrentGroup", () => {
    it("returns lowest active group number", () => {
      const plan = [
        makeTask({ group: 1, status: "completed" }),
        makeTask({ group: 2, status: "pending" }),
        makeTask({ group: 3, status: "pending" }),
      ];
      expect(getCurrentGroup(plan)).toBe(2);
    });

    it("returns null when all resolved", () => {
      const plan = [
        makeTask({ status: "completed" }),
        makeTask({ status: "skipped" }),
      ];
      expect(getCurrentGroup(plan)).toBeNull();
    });
  });

  describe("getTaskProgress", () => {
    it("computes progress counts", () => {
      const plan = [
        makeTask({ status: "completed" }),
        makeTask({ status: "completed" }),
        makeTask({ status: "skipped" }),
        makeTask({ status: "in_progress" }),
        makeTask({ status: "pending" }),
      ];
      const progress = getTaskProgress(plan);
      expect(progress).toEqual({
        total: 5,
        completed: 2,
        skipped: 1,
        pending: 1,
        inProgress: 1,
      });
    });

    it("handles empty plan", () => {
      const progress = getTaskProgress([]);
      expect(progress).toEqual({
        total: 0,
        completed: 0,
        skipped: 0,
        pending: 0,
        inProgress: 0,
      });
    });
  });
});
