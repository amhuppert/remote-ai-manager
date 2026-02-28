"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import type { FixPlanTask } from "./types";

interface TaskPlanEditorProps {
  tasks: FixPlanTask[];
  readOnly?: boolean;
  showProgress?: boolean;
  showGenerateButton?: boolean;
  isGenerating?: boolean;
  onTaskAdd?: (description: string) => void;
  onTaskRemove?: (taskId: string) => void;
  onTaskEdit?: (taskId: string, description: string) => void;
  onTaskReorder?: (taskIds: string[]) => void;
  onGeneratePlan?: () => void;
}

function getStatusDisplay(status: FixPlanTask["status"]) {
  switch (status) {
    case "completed":
      return { symbol: "\u2713", className: "completed" };
    case "skipped":
      return { symbol: "\u2298", className: "skipped" };
    case "in_progress":
      return { symbol: "\u25CF", className: "in-progress" };
    case "pending":
      return { symbol: "\u25CB", className: "pending" };
  }
}

function isEditable(task: FixPlanTask): boolean {
  return task.status === "pending" || task.status === "in_progress";
}

export default function TaskPlanEditor({
  tasks,
  readOnly = false,
  showProgress = true,
  showGenerateButton = false,
  isGenerating = false,
  onTaskAdd,
  onTaskRemove,
  onTaskEdit,
  onTaskReorder,
  onGeneratePlan,
}: TaskPlanEditorProps) {
  const [newTaskText, setNewTaskText] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragSourceId = useRef<string | null>(null);

  const completed = tasks.filter((t) => t.status === "completed").length;
  const skipped = tasks.filter((t) => t.status === "skipped").length;
  const resolved = completed + skipped;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((resolved / total) * 100) : 0;
  const allResolved = total > 0 && resolved === total;

  // Organize tasks by group
  const tasksByGroup = useMemo(() => {
    const grouped = new Map<number, FixPlanTask[]>();
    for (const task of tasks) {
      const list = grouped.get(task.group) ?? [];
      list.push(task);
      grouped.set(task.group, list);
    }
    return new Map([...grouped.entries()].sort(([a], [b]) => a - b));
  }, [tasks]);

  function handleAddTask() {
    const text = newTaskText.trim();
    if (text) {
      onTaskAdd?.(text);
      setNewTaskText("");
    }
  }

  // --- Inline editing ---

  const startEdit = useCallback(
    (task: FixPlanTask) => {
      if (readOnly || !isEditable(task)) return;
      setEditingTaskId(task.id);
      setEditText(task.description);
    },
    [readOnly],
  );

  const commitEdit = useCallback(() => {
    if (!editingTaskId) return;
    const trimmed = editText.trim();
    if (trimmed) {
      onTaskEdit?.(editingTaskId, trimmed);
    }
    setEditingTaskId(null);
    setEditText("");
  }, [editingTaskId, editText, onTaskEdit]);

  const cancelEdit = useCallback(() => {
    setEditingTaskId(null);
    setEditText("");
  }, []);

  // --- Drag-to-reorder ---

  const handleDragStart = useCallback((e: React.DragEvent, taskId: string) => {
    dragSourceId.current = taskId;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", taskId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, taskId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverId(taskId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      setDragOverId(null);
      const sourceId = dragSourceId.current;
      dragSourceId.current = null;
      if (!sourceId || sourceId === targetId || !onTaskReorder) return;

      const taskIds = tasks.map((t) => t.id);
      const sourceIndex = taskIds.indexOf(sourceId);
      const targetIndex = taskIds.indexOf(targetId);
      if (sourceIndex === -1 || targetIndex === -1) return;

      const reordered = [...taskIds];
      reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, sourceId);
      onTaskReorder(reordered);
    },
    [tasks, onTaskReorder],
  );

  const handleDragEnd = useCallback(() => {
    dragSourceId.current = null;
    setDragOverId(null);
  }, []);

  const canDrag = !readOnly && !!onTaskReorder;

  function renderTask(task: FixPlanTask) {
    const icon = getStatusDisplay(task.status);
    const isDraggable = canDrag && isEditable(task);
    const isBeingEdited = editingTaskId === task.id;
    const isDragOver = dragOverId === task.id;
    return (
      <div
        key={task.id}
        className={`task-plan-item ${task.status}${isDragOver ? " drag-over" : ""}`}
        draggable={isDraggable}
        onDragStart={
          isDraggable ? (e) => handleDragStart(e, task.id) : undefined
        }
        onDragOver={canDrag ? (e) => handleDragOver(e, task.id) : undefined}
        onDragLeave={canDrag ? handleDragLeave : undefined}
        onDrop={canDrag ? (e) => handleDrop(e, task.id) : undefined}
        onDragEnd={canDrag ? handleDragEnd : undefined}
      >
        {isDraggable && (
          <span className="task-plan-drag-handle">{"\u2261"}</span>
        )}
        <div className="task-plan-item-status">
          <span className={`task-check ${icon.className}`}>{icon.symbol}</span>
        </div>
        <div className="task-plan-item-body">
          {isBeingEdited ? (
            <input
              className="task-plan-edit-input"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") cancelEdit();
              }}
              onBlur={commitEdit}
              autoFocus
            />
          ) : (
            <>
              <span
                className={`task-plan-item-description${task.status === "skipped" ? " skipped" : ""}`}
                onDoubleClick={() => startEdit(task)}
              >
                {task.description}
              </span>
              {task.skipReason && (
                <span className="task-plan-skip-reason">
                  Skipped: {task.skipReason}
                </span>
              )}
              {task.addedByIteration !== null && (
                <span className="task-plan-added-by">
                  Added by iteration #{task.addedByIteration}
                </span>
              )}
            </>
          )}
        </div>
        {!readOnly && task.status === "pending" && (
          <button
            className="btn-icon-only task-plan-remove"
            onClick={() => onTaskRemove?.(task.id)}
          >
            {"\u00D7"}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="task-plan">
      <div className="task-plan-header">
        <span className="task-plan-label">Task Plan</span>
        <span className="task-plan-count">
          {resolved} / {total}
        </span>
        {showGenerateButton && (
          <button
            className="btn btn-sm task-plan-generate"
            onClick={onGeneratePlan}
            disabled={isGenerating}
          >
            {isGenerating ? "\u27F3 Generating\u2026" : "\u2726 Generate"}
          </button>
        )}
      </div>

      {showProgress && total > 0 && (
        <div className="task-plan-progress">
          <div className="task-plan-progress-bar">
            <div
              className={`task-plan-progress-fill${allResolved ? " complete" : ""}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="task-plan-progress-pct">{pct}%</span>
        </div>
      )}

      {tasks.length > 0 ? (
        <div className="task-plan-list">
          {tasksByGroup.size > 1
            ? [...tasksByGroup.entries()].map(([group, groupTasks]) => (
                <div key={group} className="task-plan-group-section">
                  <div className="task-plan-group-header">
                    <span className="task-plan-group-label">Group {group}</span>
                  </div>
                  {groupTasks.map((task) => renderTask(task))}
                </div>
              ))
            : tasks.map((task) => renderTask(task))}
        </div>
      ) : (
        <div className="task-plan-empty">
          {showGenerateButton
            ? "No tasks yet. Add manually or generate from conversation context."
            : "No tasks defined."}
        </div>
      )}

      {!readOnly && (
        <div className="task-plan-add">
          <input
            className="task-plan-add-input"
            placeholder={"Add a task\u2026"}
            value={newTaskText}
            onChange={(e) => setNewTaskText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddTask();
            }}
          />
        </div>
      )}
    </div>
  );
}
