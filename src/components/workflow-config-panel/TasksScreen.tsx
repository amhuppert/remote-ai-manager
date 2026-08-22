"use client";

import type { GraphWorkflowTaskDefinition } from "@/lib/workflow-graph/definition-schemas";
import { isConfigLocked } from "./affordance";
import {
  ConfigItemList,
  ConfigTextArea,
  ConfigTextInput,
  type ConfigListItem,
} from "./ConfigControls";
import { ConfigControlRow, ConfigRowGroup } from "./ConfigRow";
import {
  moveItem,
  nextTaskId,
  removeItem,
  renumberTasks,
} from "./ordered-edits";
import { taskScreenId } from "./navigation-ids";
import type { ContextStructuralEditor } from "./structural-editor";
import { textPart, valuePart } from "./value-parts";

/**
 * Tasks — the ordered work an implementer is dispatched against, and the detail
 * screen for one of them (Config Panel `tasksRows()` / `taskRows()`).
 *
 * Every structural edit renumbers: `order` is the dispatch key, so a gap or a
 * duplicate left behind by a move or a remove would point the implementer at a
 * position no task holds. The detail screen therefore states the position and
 * refuses to be the place that changes it — one owner for the ordering.
 */

const ORDER_HINT =
  "Reorder from the Tasks screen — order is what the implementer is dispatched against.";

const NO_INSTRUCTIONS = "no instructions yet";

/** `N · Title`, the label every ordering control's accessible name is built on. */
function itemTitle(task: GraphWorkflowTaskDefinition): string {
  return `${task.order} · ${task.title}`;
}

export function TasksScreen({
  editor,
  onOpenTask,
}: {
  editor: ContextStructuralEditor;
  onOpenTask: (taskId: string) => void;
}): React.JSX.Element {
  const locked = isConfigLocked(editor.affordance);
  const tasks = editor.tasks;

  function commit(next: readonly GraphWorkflowTaskDefinition[]): void {
    editor.onTasksChange(renumberTasks(next));
  }

  const items: ConfigListItem[] = tasks.map((task, index) => ({
    id: task.id,
    title: itemTitle(task),
    screenId: taskScreenId(task.id),
    onOpen: () => onOpenTask(task.id),
    meta:
      task.instructions.trim().length > 0 ? task.instructions : NO_INSTRUCTIONS,
    onMoveUp:
      index === 0 ? undefined : () => commit(moveItem(tasks, index, index - 1)),
    onMoveDown:
      index === tasks.length - 1
        ? undefined
        : () => commit(moveItem(tasks, index, index + 1)),
    onRemove: () => commit(removeItem(tasks, index)),
  }));

  return (
    <ConfigRowGroup>
      <ConfigControlRow
        rowId="tasks-list"
        label="Ordered tasks"
        disabled={locked}
      >
        <ConfigItemList
          items={items}
          disabled={locked}
          {...(locked
            ? {}
            : {
                addLabel: "Add task",
                onAdd: () =>
                  commit([
                    ...tasks,
                    {
                      id: nextTaskId(
                        editor.context.id,
                        tasks.length + 1,
                        editor.workflowTaskIds,
                      ),
                      contextId: editor.context.id,
                      order: tasks.length + 1,
                      title: "New task",
                      instructions: "",
                      source: "user",
                    },
                  ]),
              })}
        />
      </ConfigControlRow>
    </ConfigRowGroup>
  );
}

export function TaskDetailScreen({
  editor,
  taskId,
}: {
  editor: ContextStructuralEditor;
  taskId: string;
}): React.JSX.Element {
  const locked = isConfigLocked(editor.affordance);
  const tasks = editor.tasks;
  const index = tasks.findIndex((each) => each.id === taskId);
  const task = tasks[index];

  if (task === undefined) {
    // A live edit or a rebase can remove the task under an open drill. Saying so
    // beats an empty screen the reader would read as a rendering failure.
    return (
      <ConfigRowGroup>
        <ConfigControlRow rowId="task-missing" label="Task">
          <p className="m-0 font-mono text-[0.72rem] leading-[1.6] text-text-tertiary">
            This task no longer exists — go back to the Tasks screen.
          </p>
        </ConfigControlRow>
      </ConfigRowGroup>
    );
  }

  function edit(patch: Partial<GraphWorkflowTaskDefinition>): void {
    // Spread the task so metadata, source and contextId round-trip verbatim.
    editor.onTasksChange(
      tasks.map((each, at) => (at === index ? { ...each, ...patch } : each)),
    );
  }

  return (
    <ConfigRowGroup>
      <ConfigControlRow
        rowId="task-title"
        label="Title"
        control={
          <ConfigTextInput
            value={task.title}
            onChange={(title) => edit({ title })}
            ariaLabel="Task title"
            placeholder="Task title"
            disabled={locked}
          />
        }
      />
      <ConfigControlRow
        rowId="task-instructions"
        label="Instructions"
        disabled={locked}
      >
        <ConfigTextArea
          value={task.instructions}
          onChange={(instructions) => edit({ instructions })}
          ariaLabel="Task instructions"
          rows={6}
          placeholder="What this task must do"
          disabled={locked}
        />
      </ConfigControlRow>
      <ConfigControlRow
        rowId="task-order"
        label="Order"
        hint={ORDER_HINT}
        parts={[
          textPart("position", "dim"),
          valuePart(String(task.order)),
          textPart(`of ${tasks.length}`, "dim"),
        ]}
      />
    </ConfigRowGroup>
  );
}
