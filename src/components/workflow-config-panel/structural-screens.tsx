"use client";

import { BriefScreen } from "./BriefScreen";
import { CharterScreen } from "./CharterScreen";
import { ParametersScreen } from "./ParametersScreen";
import { OutputSchemaScreen } from "./OutputSchemaScreen";
import { PlacementScreen } from "./PlacementScreen";
import { TASK_SCREEN_PREFIX, taskScreenId } from "./navigation-ids";
import { TaskDetailScreen, TasksScreen } from "./TasksScreen";
import type { ConfigScreenDefinition } from "./screen-registry";
import type {
  ContextStructuralEditor,
  WorkflowStructuralEditor,
} from "./structural-editor";

/**
 * The structural screens both hosts register: what a context IS and owes, and
 * the workflow-tier structure every context is run under.
 *
 * They are handed to `createConfigScreenRegistry` alongside the cascade screens
 * rather than composed into a registry here — a host mounts one panel over both
 * families, and only the host knows which cascade it is editing.
 */

export function contextStructuralScreens(
  editor: ContextStructuralEditor,
): ConfigScreenDefinition[] {
  return [
    {
      id: "brief",
      title: "Brief",
      render: ({ navigate }) => (
        <BriefScreen editor={editor} onOpenSchema={() => navigate("schema")} />
      ),
    },
    {
      id: "schema",
      title: "Output schema",
      render: () => <OutputSchemaScreen editor={editor} />,
    },
    {
      id: "placement",
      title: "Placement",
      render: () => <PlacementScreen editor={editor} />,
    },
    {
      id: "tasks",
      title: "Tasks",
      render: ({ navigate }) => (
        <TasksScreen
          editor={editor}
          onOpenTask={(taskId) => navigate(taskScreenId(taskId))}
        />
      ),
    },
    {
      // Parametric: the segment after `task:` is the task id. Titled from the
      // task's own position and title so a back row one level down names the
      // screen the reader actually came from.
      id: TASK_SCREEN_PREFIX,
      title: (taskId) => {
        const task = editor.tasks.find((each) => each.id === taskId);
        return task === undefined ? "Task" : `${task.order} · ${task.title}`;
      },
      render: ({ param }) => (
        <TaskDetailScreen editor={editor} taskId={param} />
      ),
    },
  ];
}

export function workflowStructuralScreens(
  editor: WorkflowStructuralEditor,
): ConfigScreenDefinition[] {
  return [
    {
      id: "charter",
      title: "Charter",
      render: () => <CharterScreen editor={editor} />,
    },
    {
      id: "params",
      title: "Launch parameters",
      render: () => <ParametersScreen editor={editor} />,
    },
  ];
}
