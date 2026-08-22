// @vitest-environment jsdom
/**
 * The Tasks list and the task-detail drill (Config Panel `tasksRows()` /
 * `taskRows()`).
 *
 * `order` is what the implementer is dispatched against, so the assertions that
 * matter are about renumbering: a move or a remove has to leave a contiguous
 * 1..N run, and the detail screen must refuse to be the place that changes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { TaskDetailScreen, TasksScreen } from "./TasksScreen";
import type { ContextStructuralEditor } from "./structural-editor";

afterEach(cleanup);

const CONTEXT: GraphWorkflowExecutionContextDefinition = {
  id: "ctx_checkout",
  title: "Implement checkout",
  acceptanceCriteria: [{ id: "ac-1", statement: "Audited." }],
  placement: { lane: "delivery", mode: "full" },
};

function task(
  id: string,
  order: number,
  title: string,
  instructions = `Do ${title}`,
): GraphWorkflowTaskDefinition {
  return {
    id,
    contextId: "ctx_checkout",
    order,
    title,
    instructions,
    source: "user",
  };
}

const TASKS: GraphWorkflowTaskDefinition[] = [
  task("task-1", 1, "Reserve inventory"),
  task("task-2", 2, "Authorise the card"),
  task("task-3", 3, "Write the audit row", ""),
];

function editorFor(
  overrides: Partial<ContextStructuralEditor> = {},
): ContextStructuralEditor {
  return {
    host: "builder",
    affordance: "editable",
    context: CONTEXT,
    onContextChange: vi.fn(),
    outputSchemaText: "",
    onOutputSchemaTextChange: vi.fn(),
    upstreamInputs: [],
    tasks: TASKS,
    workflowTaskIds: TASKS.map((each) => each.id),
    onTasksChange: vi.fn(),
    ...overrides,
  };
}

function renderList(overrides: Partial<ContextStructuralEditor> = {}) {
  const editor = editorFor(overrides);
  render(<TasksScreen editor={editor} onOpenTask={vi.fn()} />);
  return editor;
}

describe("TasksScreen listing", () => {
  it("titles each item with its position and title", () => {
    renderList();

    expect(screen.getByText("1 · Reserve inventory")).toBeInTheDocument();
    expect(screen.getByText("2 · Authorise the card")).toBeInTheDocument();
    expect(screen.getByText("3 · Write the audit row")).toBeInTheDocument();
  });

  it("previews the instructions, and says so when there are none", () => {
    renderList();

    expect(
      within(screen.getByTestId("config-item-task-1")).getByText(
        "Do Reserve inventory",
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId("config-item-task-3")).getByText(
        "no instructions yet",
      ),
    ).toBeInTheDocument();
  });

  it("drills into a task", () => {
    const onOpenTask = vi.fn();
    render(<TasksScreen editor={editorFor()} onOpenTask={onOpenTask} />);

    // Exact, not a substring: the move and remove controls on the same item
    // also carry the item's label in their accessible names.
    fireEvent.click(
      screen.getByRole("button", { name: "2 · Authorise the card" }),
    );

    expect(onOpenTask).toHaveBeenCalledWith("task-2");
  });
});

describe("TasksScreen ordering", () => {
  it("renumbers order contiguously after a move up", () => {
    const onTasksChange = vi.fn();
    renderList({ onTasksChange });

    fireEvent.click(
      screen.getByRole("button", { name: "Move 3 · Write the audit row up" }),
    );

    expect(
      onTasksChange.mock.calls[0]?.[0].map(
        (each: GraphWorkflowTaskDefinition) => [each.id, each.order],
      ),
    ).toEqual([
      ["task-1", 1],
      ["task-3", 2],
      ["task-2", 3],
    ]);
  });

  it("renumbers order contiguously after a move down", () => {
    const onTasksChange = vi.fn();
    renderList({ onTasksChange });

    fireEvent.click(
      screen.getByRole("button", { name: "Move 1 · Reserve inventory down" }),
    );

    expect(
      onTasksChange.mock.calls[0]?.[0].map(
        (each: GraphWorkflowTaskDefinition) => [each.id, each.order],
      ),
    ).toEqual([
      ["task-2", 1],
      ["task-1", 2],
      ["task-3", 3],
    ]);
  });

  it("closes the gap a removal leaves", () => {
    const onTasksChange = vi.fn();
    renderList({ onTasksChange });

    fireEvent.click(
      screen.getByRole("button", { name: "Remove 1 · Reserve inventory" }),
    );

    expect(
      onTasksChange.mock.calls[0]?.[0].map(
        (each: GraphWorkflowTaskDefinition) => [each.id, each.order],
      ),
    ).toEqual([
      ["task-2", 1],
      ["task-3", 2],
    ]);
  });

  it("preserves fields it does not renumber", () => {
    const onTasksChange = vi.fn();
    renderList({
      onTasksChange,
      tasks: [
        { ...task("task-1", 1, "Only"), metadata: { origin: "spec" } },
        task("task-2", 2, "Second"),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Move 2 · Second up" }));

    expect(onTasksChange.mock.calls[0]?.[0][1]).toEqual({
      ...task("task-1", 2, "Only"),
      metadata: { origin: "spec" },
    });
  });

  it("adds a task at the end with the next free id and order", () => {
    const onTasksChange = vi.fn();
    renderList({ onTasksChange });

    fireEvent.click(screen.getByRole("button", { name: /add task/i }));

    const next = onTasksChange.mock.calls[0]?.[0];
    expect(next).toHaveLength(4);
    expect(next[3]).toMatchObject({
      id: "task-ctx_checkout-4",
      contextId: "ctx_checkout",
      order: 4,
    });
  });

  it("mints an id no task ANYWHERE in the workflow holds", () => {
    const onTasksChange = vi.fn();
    renderList({
      onTasksChange,
      tasks: [task("task-1", 1, "Reserve inventory")],
      // A sibling context owns `task-2`. Task ids are unique workflow-wide, so
      // numbering off this context's single task would mint that duplicate and
      // Save would fail with `duplicate-task-id`.
      workflowTaskIds: ["task-1", "task-2"],
    });

    fireEvent.click(screen.getByRole("button", { name: /add task/i }));

    const next = onTasksChange.mock.calls[0]?.[0];
    expect(next[1].id).toBe("task-ctx_checkout-2");
  });

  it("offers no Add and no reordering while locked", () => {
    renderList({ host: "execution", affordance: "frozen" });

    expect(screen.queryByRole("button", { name: /add task/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Move 1 · Reserve inventory down" }),
    ).toBeDisabled();
  });
});

describe("TaskDetailScreen", () => {
  function renderDetail(
    taskId = "task-2",
    overrides: Partial<ContextStructuralEditor> = {},
  ) {
    const editor = editorFor(overrides);
    render(<TaskDetailScreen editor={editor} taskId={taskId} />);
    return editor;
  }

  it("edits the title", () => {
    const onTasksChange = vi.fn();
    renderDetail("task-2", { onTasksChange });

    fireEvent.change(screen.getByLabelText("Task title"), {
      target: { value: "Authorise and capture" },
    });

    expect(onTasksChange.mock.calls[0]?.[0]).toEqual([
      TASKS[0],
      { ...TASKS[1], title: "Authorise and capture" },
      TASKS[2],
    ]);
  });

  it("edits the instructions", () => {
    const onTasksChange = vi.fn();
    renderDetail("task-2", { onTasksChange });

    fireEvent.change(screen.getByLabelText("Task instructions"), {
      target: { value: "Call the PSP, then bank the token." },
    });

    expect(onTasksChange.mock.calls[0]?.[0][1]).toEqual({
      ...TASKS[1],
      instructions: "Call the PSP, then bank the token.",
    });
  });

  it("states the position read-only and points reordering back at the list", () => {
    renderDetail("task-2");

    const row = screen.getByTestId("config-row-task-order");
    expect(row).toHaveTextContent("position");
    expect(row).toHaveTextContent("2");
    expect(row).toHaveTextContent("of 3");
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(
      screen.getByText(
        /Reorder from the Tasks screen — order is what the implementer is dispatched against\./,
      ),
    ).toBeInTheDocument();
  });

  it("says so rather than blanking when the task is gone", () => {
    renderDetail("task-missing");
    expect(screen.getByText(/no longer exists/i)).toBeInTheDocument();
  });

  it("disables both editors while locked", () => {
    renderDetail("task-2", { host: "execution", affordance: "pause-to-edit" });

    expect(screen.getByLabelText("Task title")).toBeDisabled();
    expect(screen.getByLabelText("Task instructions")).toBeDisabled();
  });
});
