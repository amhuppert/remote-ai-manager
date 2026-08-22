"use client";

import { useId, useRef, useState } from "react";
import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import CollapsibleText from "@/components/CollapsibleText";
import { cn } from "@/lib/ui/cn";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { isTaskConversationLive, isTaskEditable } from "../task-runtime-state";
import {
  GroupHeader,
  inspectorFocusRingClass,
  inspectorInsetFocusRingClass,
  inspectorSectionClass,
} from "./chrome";
import {
  ArrowDownIcon,
  ArrowUpIcon,
} from "@/components/workflow-config-panel/icons";
import { DisclosureChevronIcon } from "./icons";
import TaskHistoryList from "./TaskHistoryList";
import { deriveTaskHistory } from "./task-history";

/**
 * Tasks tab → Tasks (§11): the context's ordered tasks with their status,
 * reopened markers and per-task history, plus the inline editor and the
 * add-task form when the context's mutability allows them.
 *
 * Owns its own editing state: which row is open, the draft title/instructions
 * and the add-task draft are all local to this surface, so nothing above it has
 * to hold a keystroke.
 */

const wbBtn = cn(
  "inline-flex cursor-pointer items-center justify-center gap-[6px] rounded-sm border border-border-default font-medium whitespace-nowrap transition-all duration-150",
  inspectorFocusRingClass,
);
const wbBtnXs =
  "text-[0.7rem] py-[3px] px-[8px] h-[22px] max-768:h-auto max-768:min-h-[44px] max-768:min-w-[44px]";
const wbBtnSm =
  "text-[0.72rem] py-[5px] px-[12px] h-[28px] max-768:h-auto max-768:min-h-[44px] max-768:min-w-[44px]";
const wbBtnDefault =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:text-text-primary hover:border-border-strong";
const wbBtnPrimary =
  "bg-[var(--cc-cyan-a12)] text-cyan border-[var(--cyan-glow-strong)] hover:bg-[var(--cc-cyan-a20)] hover:shadow-[0_0_12px_var(--cyan-glow)]";
const wbBtnDanger =
  "bg-bg-raised text-red border-[var(--cc-red-a25)] hover:bg-[var(--cc-red-a10)]";
const wbOverviewSection = inspectorSectionClass;
const wbFieldInput =
  "w-full bg-bg-base border border-border-default rounded-sm text-text-primary text-[0.78rem] py-2 px-[10px] outline-none transition-[border-color] duration-150 focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] max-768:min-h-[44px]";
const wbFieldTextarea = "resize-y min-h-[64px] leading-[1.5]";
const wbTaskDetailInput =
  "w-full bg-bg-base border border-border-default rounded-sm text-text-primary text-[0.75rem] py-[7px] px-[10px] outline-none transition-[border-color] duration-150 box-border focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)] max-768:min-h-[44px]";
const wbTaskDetailTextarea = "resize-y min-h-[56px] mb-[2px]";

// Only the running dot animates, and it stops for a reader who has asked the
// platform for less motion — the colour still carries the status without it.
const taskStatusDotByStatus: Record<string, string> = {
  completed: "bg-green",
  running:
    "bg-cyan [animation:pulse-dot_2s_ease-in-out_infinite] motion-reduce:[animation:none]",
  failed: "bg-red",
  pending: "bg-text-tertiary",
};

const taskDisclosureClass = cn(
  "absolute inset-0 cursor-pointer rounded-sm border-0 bg-transparent p-0 max-768:min-h-[44px]",
  inspectorInsetFocusRingClass,
);

function getTaskStatusDotClass(status?: string): string {
  switch (status) {
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

type ContextTask = GraphWorkflowExecution["workingDefinition"]["tasks"][number];

export default function TasksSection({
  execution,
  contextId,
  tasks,
  completedCount,
  totalCount,
  canAddTasks,
  readOnly,
  isMutating,
  viewingTaskId,
  onViewTask,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
}: {
  execution: GraphWorkflowExecution;
  contextId: string;
  tasks: ContextTask[];
  completedCount: number;
  totalCount: number;
  canAddTasks: boolean;
  readOnly: boolean;
  isMutating: boolean;
  viewingTaskId: string | null;
  onViewTask: (taskId: string) => void;
  onAddTask: (contextId: string, title: string, instructions: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: { title?: string; instructions?: string },
  ) => void;
  onRemoveTask: (taskId: string) => void;
  onReorderTask: (contextId: string, orderedTaskIds: string[]) => void;
}): React.JSX.Element {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [addTitle, setAddTitle] = useState("");
  const [addInstructions, setAddInstructions] = useState("");
  const [addVoiceBusy, setAddVoiceBusy] = useState(false);
  const addInstructionsActionRef = useRef<MultilineInputActionHandle | null>(
    null,
  );
  const editInstructionsActionRefs = useRef<
    Map<string, MultilineInputActionHandle | null>
  >(new Map());
  const addInstructionsId = useId();
  const editInstructionsId = useId();

  const saveTaskEdits = (taskId: string, completedInstructions?: string) => {
    if (isMutating) return;
    onUpdateTask(taskId, {
      title: editTitle,
      instructions: completedInstructions ?? editInstructions,
    });
    setExpandedTaskId(null);
  };

  const addTask = (completedInstructions?: string) => {
    const nextInstructions = completedInstructions ?? addInstructions;
    if (
      isMutating ||
      addTitle.trim().length === 0 ||
      nextInstructions.trim().length === 0
    ) {
      return;
    }
    onAddTask(contextId, addTitle, nextInstructions);
    setAddTitle("");
    setAddInstructions("");
  };

  function handleExpandTask(taskId: string) {
    if (expandedTaskId === taskId) {
      setExpandedTaskId(null);
    } else {
      setExpandedTaskId(taskId);
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        setEditTitle(task.title);
        setEditInstructions(task.instructions);
      }
    }
  }

  function handleSwapTask(index: number, direction: "up" | "down") {
    const editableTasks = tasks.filter((task) =>
      isTaskEditable(execution, task.id),
    );
    const currentTask = tasks[index];
    if (!currentTask) {
      return;
    }

    const editableIndex = editableTasks.findIndex(
      (task) => task.id === currentTask.id,
    );
    const targetIndex =
      direction === "up" ? editableIndex - 1 : editableIndex + 1;
    const reordered = [...editableTasks];
    const curr = reordered[editableIndex];
    const target = reordered[targetIndex];
    if (curr && target) {
      reordered[editableIndex] = target;
      reordered[targetIndex] = curr;
      onReorderTask(
        contextId,
        reordered.map((t) => t.id),
      );
    }
  }

  return (
    <>
      <section className={wbOverviewSection}>
        <GroupHeader label="Tasks" meta={`${completedCount}/${totalCount}`} />
        <div>
          {tasks.map((task, index) => {
            const taskState = execution.taskStates[task.id];
            const isExpanded = expandedTaskId === task.id;
            const isEditable = !readOnly && isTaskEditable(execution, task.id);
            const hasConversation = !!taskState?.lastConversationId;
            const isRunning = isTaskConversationLive(execution, task.id);
            const isViewing = viewingTaskId === task.id;
            const hasErrors = !!taskState?.failureMessage;
            const taskHistory = deriveTaskHistory(taskState);

            return (
              <div
                key={task.id}
                className={cn(
                  "mb-[2px] rounded-sm border",
                  isExpanded
                    ? "border-border-dim bg-bg-base"
                    : "border-transparent",
                )}
              >
                <div
                  className={cn(
                    "relative flex items-center gap-[8px] rounded-sm px-[10px] py-2 transition-[background] duration-150 hover:bg-bg-elevated max-768:min-h-[44px]",
                    hasErrors && "border-l-2 border-l-red",
                    isViewing && "border-l-2 border-l-cyan bg-bg-raised",
                  )}
                >
                  {/* The row carries its own Watch control, so the disclosure
                      cannot wrap it. It covers the row instead: a real button
                      with the row's expanded state on it, ringed in place, and
                      Watch sits above it rather than inside it. */}
                  <button
                    type="button"
                    data-testid="wf-task-item"
                    className={taskDisclosureClass}
                    aria-expanded={isExpanded}
                    aria-label={`Task ${index + 1}: ${task.title}`}
                    onClick={() => handleExpandTask(task.id)}
                  />
                  <span className="w-4 shrink-0 text-center text-[0.7rem] font-semibold text-text-tertiary">
                    {index + 1}
                  </span>
                  <span className="flex-1 overflow-hidden text-[0.75rem] text-ellipsis whitespace-nowrap text-text-primary">
                    {task.title}
                  </span>
                  {taskHistory.reopenedCount > 0 && (
                    // Visible without expanding: a task sent back three
                    // times reads nothing like one sent back once.
                    <span
                      data-testid="task-reopened-marker"
                      className="shrink-0 font-mono text-[0.7rem] text-blue"
                    >
                      reopened {taskHistory.reopenedCount}×
                    </span>
                  )}
                  {hasConversation && (
                    <button
                      className={cn(
                        "relative shrink-0 cursor-pointer rounded-[3px] border bg-transparent px-[6px] py-[2px] font-mono text-[0.7rem] font-semibold tracking-[0.04em] whitespace-nowrap uppercase transition-all duration-150 max-768:min-h-[44px] max-768:min-w-[44px]",
                        inspectorFocusRingClass,
                        isRunning
                          ? "border-[var(--cyan-glow-strong)] text-cyan hover:bg-[var(--cc-cyan-a08)]"
                          : "border-border-default text-text-tertiary hover:border-border-strong hover:bg-bg-elevated hover:text-text-secondary",
                      )}
                      onClick={() => onViewTask(task.id)}
                      type="button"
                    >
                      {isRunning ? "Watch" : "View"}
                    </button>
                  )}
                  {taskState?.failureMessage && (
                    <span className="mr-1 ml-auto h-[6px] w-[6px] shrink-0 rounded-full bg-red" />
                  )}
                  <span
                    data-testid="task-status-dot"
                    className={cn(
                      "h-[6px] w-[6px] shrink-0 rounded-full",
                      taskStatusDotByStatus[
                        getTaskStatusDotClass(taskState?.status)
                      ],
                    )}
                  />
                  <span
                    className={cn(
                      "flex shrink-0 text-text-tertiary transition-transform duration-150",
                      isExpanded && "rotate-90",
                    )}
                  >
                    <DisclosureChevronIcon />
                  </span>
                </div>
                <div
                  className={cn(
                    isExpanded
                      ? "block pt-2 pr-[10px] pb-[10px] pl-[34px] text-[0.72rem] leading-[1.5] text-text-secondary"
                      : "hidden",
                  )}
                >
                  <div className="mb-[10px]">
                    <span className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                      Instructions
                    </span>
                    <CollapsibleText maxCollapsedHeight={100}>
                      <CompactMarkdown content={task.instructions} />
                    </CollapsibleText>
                  </div>
                  {taskState?.failureMessage && (
                    <div className="mb-[10px]">
                      <span className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                        Failure
                      </span>
                      <span style={{ color: "var(--red)" }}>
                        {taskState.failureMessage}
                      </span>
                    </div>
                  )}
                  <TaskHistoryList view={taskHistory} />
                  {isEditable && isExpanded && (
                    <>
                      <div className="mb-[10px]">
                        <span className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                          Edit Title
                        </span>
                        <input
                          className={wbTaskDetailInput}
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                        />
                      </div>
                      <div className="mb-[10px]">
                        <label
                          htmlFor={`${editInstructionsId}-${task.id}`}
                          className="mb-1 block text-[0.7rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase"
                        >
                          Edit Instructions
                        </label>
                        <MultilineInput
                          id={`${editInstructionsId}-${task.id}`}
                          className={cn(
                            wbTaskDetailInput,
                            wbTaskDetailTextarea,
                          )}
                          rows={3}
                          value={editInstructions}
                          onValueChange={setEditInstructions}
                          onPrimaryAction={(instructions) =>
                            saveTaskEdits(task.id, instructions)
                          }
                          actionRef={(handle) => {
                            if (handle) {
                              editInstructionsActionRefs.current.set(
                                task.id,
                                handle,
                              );
                            } else {
                              editInstructionsActionRefs.current.delete(
                                task.id,
                              );
                            }
                          }}
                          disabled={isMutating}
                        />
                      </div>
                      <div className="mt-2 flex gap-[6px] border-t border-border-dim pt-2">
                        <button
                          className={cn(wbBtn, wbBtnXs, wbBtnPrimary)}
                          onClick={() =>
                            runMultilinePrimaryAction(
                              [editInstructionsActionRefs.current.get(task.id)],
                              () => saveTaskEdits(task.id),
                            )
                          }
                          disabled={isMutating}
                          type="button"
                        >
                          Save
                        </button>
                        {index > 0 && (
                          <button
                            className={cn(wbBtn, wbBtnXs, wbBtnDefault)}
                            onClick={() => handleSwapTask(index, "up")}
                            disabled={isMutating}
                            type="button"
                          >
                            <ArrowUpIcon size={11} /> Up
                          </button>
                        )}
                        {index < tasks.length - 1 && (
                          <button
                            className={cn(wbBtn, wbBtnXs, wbBtnDefault)}
                            onClick={() => handleSwapTask(index, "down")}
                            disabled={isMutating}
                            type="button"
                          >
                            <ArrowDownIcon size={11} /> Down
                          </button>
                        )}
                        <button
                          className={cn(wbBtn, wbBtnXs, wbBtnDanger)}
                          onClick={() => onRemoveTask(task.id)}
                          disabled={isMutating}
                          type="button"
                        >
                          Remove
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {canAddTasks && (
        <section className={wbOverviewSection}>
          <GroupHeader label="Add Task" />
          <label className="mb-md">
            <span className="mb-xs block text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
              Title
            </span>
            <input
              className={wbFieldInput}
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              placeholder="Task title"
            />
          </label>
          <div className="mb-md">
            <label
              className="mb-xs block text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
              htmlFor={addInstructionsId}
            >
              Instructions
            </label>
            <MultilineInput
              id={addInstructionsId}
              className={cn(wbFieldInput, wbFieldTextarea)}
              rows={3}
              value={addInstructions}
              onValueChange={setAddInstructions}
              onPrimaryAction={addTask}
              actionRef={addInstructionsActionRef}
              onVoiceStateChange={setAddVoiceBusy}
              placeholder="Task instructions"
            />
          </div>
          <button
            className={cn(wbBtn, wbBtnSm, wbBtnPrimary)}
            onClick={() =>
              runMultilinePrimaryAction(
                [addInstructionsActionRef.current],
                addTask,
              )
            }
            disabled={
              isMutating ||
              addTitle.trim().length === 0 ||
              (addInstructions.trim().length === 0 && !addVoiceBusy)
            }
            type="button"
          >
            + Add Task
          </button>
        </section>
      )}
    </>
  );
}
