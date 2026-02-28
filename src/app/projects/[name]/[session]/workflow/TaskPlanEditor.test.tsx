// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import TaskPlanEditor from "./TaskPlanEditor";
import type { FixPlanTask } from "./types";

const baseTasks: FixPlanTask[] = [
  {
    id: "t1",
    description: "Implement auth",
    group: 1,
    status: "pending",
    createdAt: "2026-02-25T10:00:00Z",
    completedAt: null,
    skipReason: null,
    addedByIteration: null,
  },
  {
    id: "t2",
    description: "Create schema",
    group: 1,
    status: "pending",
    createdAt: "2026-02-25T10:00:00Z",
    completedAt: null,
    skipReason: null,
    addedByIteration: null,
  },
  {
    id: "t3",
    description: "Add validation",
    group: 2,
    status: "completed",
    createdAt: "2026-02-25T10:00:00Z",
    completedAt: "2026-02-25T11:00:00Z",
    skipReason: null,
    addedByIteration: null,
  },
];

describe("TaskPlanEditor", () => {
  // --- Existing features ---

  it("renders all tasks", () => {
    const { container } = render(<TaskPlanEditor tasks={baseTasks} />);
    const items = container.querySelectorAll(".task-plan-item");
    expect(items.length).toBe(3);
  });

  it("shows add input when not readOnly", () => {
    const { container } = render(<TaskPlanEditor tasks={baseTasks} />);
    expect(container.querySelector(".task-plan-add-input")).not.toBeNull();
  });

  it("hides add input when readOnly", () => {
    const { container } = render(<TaskPlanEditor tasks={baseTasks} readOnly />);
    expect(container.querySelector(".task-plan-add-input")).toBeNull();
  });

  it("calls onTaskAdd when enter is pressed", () => {
    const onTaskAdd = vi.fn();
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskAdd={onTaskAdd} />,
    );
    const input = container.querySelector(
      ".task-plan-add-input",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onTaskAdd).toHaveBeenCalledWith("New task");
  });

  it("calls onTaskRemove when remove button is clicked", () => {
    const onTaskRemove = vi.fn();
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskRemove={onTaskRemove} />,
    );
    const removeButtons = container.querySelectorAll(".task-plan-remove");
    // Only pending tasks show remove buttons (t1, t2)
    expect(removeButtons.length).toBe(2);
    fireEvent.click(removeButtons[0]!);
    expect(onTaskRemove).toHaveBeenCalledWith("t1");
  });

  // --- Group headers ---

  it("shows group headers when tasks span multiple groups", () => {
    const { container } = render(<TaskPlanEditor tasks={baseTasks} />);
    const groupHeaders = container.querySelectorAll(".task-plan-group-header");
    expect(groupHeaders.length).toBe(2);
  });

  it("omits group headers when all tasks are in one group", () => {
    const singleGroupTasks = baseTasks.map((t) => ({ ...t, group: 1 }));
    const { container } = render(<TaskPlanEditor tasks={singleGroupTasks} />);
    const groupHeaders = container.querySelectorAll(".task-plan-group-header");
    expect(groupHeaders.length).toBe(0);
  });

  // --- Drag-to-reorder ---

  it("shows drag handle on pending tasks when not readOnly", () => {
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskReorder={vi.fn()} />,
    );
    const handles = container.querySelectorAll(".task-plan-drag-handle");
    // Only pending tasks (t1, t2) get handles
    expect(handles.length).toBe(2);
  });

  it("hides drag handles in readOnly mode", () => {
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} readOnly onTaskReorder={vi.fn()} />,
    );
    const handles = container.querySelectorAll(".task-plan-drag-handle");
    expect(handles.length).toBe(0);
  });

  it("makes task items draggable when not readOnly", () => {
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskReorder={vi.fn()} />,
    );
    const items = container.querySelectorAll(".task-plan-item");
    // Only pending tasks should be draggable
    expect(items[0]!.getAttribute("draggable")).toBe("true");
    expect(items[1]!.getAttribute("draggable")).toBe("true");
    // Completed tasks should not be draggable
    expect(items[2]!.getAttribute("draggable")).toBe("false");
  });

  // --- Inline editing ---

  it("enters edit mode on double-click for pending tasks when not readOnly", () => {
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskEdit={vi.fn()} />,
    );
    const descriptions = container.querySelectorAll(
      ".task-plan-item-description",
    );
    fireEvent.doubleClick(descriptions[0]!);
    const editInput = container.querySelector(".task-plan-edit-input");
    expect(editInput).not.toBeNull();
    expect((editInput as HTMLInputElement).value).toBe("Implement auth");
  });

  it("does not enter edit mode on double-click for completed tasks", () => {
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskEdit={vi.fn()} />,
    );
    const descriptions = container.querySelectorAll(
      ".task-plan-item-description",
    );
    // Third task is completed
    fireEvent.doubleClick(descriptions[2]!);
    const editInput = container.querySelector(".task-plan-edit-input");
    expect(editInput).toBeNull();
  });

  it("does not enter edit mode in readOnly mode", () => {
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} readOnly onTaskEdit={vi.fn()} />,
    );
    const descriptions = container.querySelectorAll(
      ".task-plan-item-description",
    );
    fireEvent.doubleClick(descriptions[0]!);
    expect(container.querySelector(".task-plan-edit-input")).toBeNull();
  });

  it("commits edit on Enter key", () => {
    const onTaskEdit = vi.fn();
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskEdit={onTaskEdit} />,
    );
    const descriptions = container.querySelectorAll(
      ".task-plan-item-description",
    );
    fireEvent.doubleClick(descriptions[0]!);
    const editInput = container.querySelector(
      ".task-plan-edit-input",
    ) as HTMLInputElement;
    fireEvent.change(editInput, { target: { value: "Updated auth" } });
    fireEvent.keyDown(editInput, { key: "Enter" });
    expect(onTaskEdit).toHaveBeenCalledWith("t1", "Updated auth");
  });

  it("cancels edit on Escape key", () => {
    const onTaskEdit = vi.fn();
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskEdit={onTaskEdit} />,
    );
    const descriptions = container.querySelectorAll(
      ".task-plan-item-description",
    );
    fireEvent.doubleClick(descriptions[0]!);
    const editInput = container.querySelector(
      ".task-plan-edit-input",
    ) as HTMLInputElement;
    fireEvent.change(editInput, { target: { value: "Changed" } });
    fireEvent.keyDown(editInput, { key: "Escape" });
    expect(onTaskEdit).not.toHaveBeenCalled();
    expect(container.querySelector(".task-plan-edit-input")).toBeNull();
  });

  it("commits edit on blur", () => {
    const onTaskEdit = vi.fn();
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskEdit={onTaskEdit} />,
    );
    const descriptions = container.querySelectorAll(
      ".task-plan-item-description",
    );
    fireEvent.doubleClick(descriptions[0]!);
    const editInput = container.querySelector(
      ".task-plan-edit-input",
    ) as HTMLInputElement;
    fireEvent.change(editInput, { target: { value: "Blurred edit" } });
    fireEvent.blur(editInput);
    expect(onTaskEdit).toHaveBeenCalledWith("t1", "Blurred edit");
  });

  it("does not commit empty description on edit", () => {
    const onTaskEdit = vi.fn();
    const { container } = render(
      <TaskPlanEditor tasks={baseTasks} onTaskEdit={onTaskEdit} />,
    );
    const descriptions = container.querySelectorAll(
      ".task-plan-item-description",
    );
    fireEvent.doubleClick(descriptions[0]!);
    const editInput = container.querySelector(
      ".task-plan-edit-input",
    ) as HTMLInputElement;
    fireEvent.change(editInput, { target: { value: "  " } });
    fireEvent.keyDown(editInput, { key: "Enter" });
    expect(onTaskEdit).not.toHaveBeenCalled();
  });
});
