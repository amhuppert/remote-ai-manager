"use client";

import { useCallback, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import { generateWorkflowLayout } from "@/lib/workflow-graph/layout";
import type {
  GraphWorkflowExecution,
  GraphWorkflowVisualLayout,
} from "@/types";
import type { ExecutionMobilePanel } from "./page";
import ExecutionStatusBar from "./ExecutionStatusBar";
import WorkflowExecutionCanvas from "./WorkflowExecutionCanvas";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";
import IterationTranscriptViewer from "./IterationTranscriptViewer";

interface GraphWorkflowPanelProps {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution | null;
  archivedExecutions: GraphWorkflowExecution[];
  layout: GraphWorkflowVisualLayout | null;
  onPause(): void;
  onResume(): void;
  onAbort(): void;
  onClear(): void;
  onAddTask(contextId: string, title: string, instructions: string): void;
  onUpdateTask(
    taskId: string,
    updates: { title?: string; instructions?: string },
  ): void;
  onRemoveTask(taskId: string): void;
  onMoveTask(
    taskId: string,
    targetContextId: string,
    targetOrder: number,
  ): void;
  onReorderTask(contextId: string, orderedTaskIds: string[]): void;
  isMutating: boolean;
  isMobile: boolean;
  mobilePanel: ExecutionMobilePanel;
  autoSwitchPanel: (panel: ExecutionMobilePanel) => void;
}

/** Resolve task info needed by the transcript viewer. */
function resolveViewingTask(
  execution: GraphWorkflowExecution,
  taskId: string,
): {
  conversationId: string;
  contextTitle: string;
  taskTitle: string;
  isLive: boolean;
} | null {
  const taskDef = execution.workingDefinition.tasks.find(
    (t) => t.id === taskId,
  );
  const taskState = execution.taskStates[taskId];
  if (!taskDef || !taskState?.lastConversationId) return null;

  const context = execution.workingDefinition.executionContexts.find(
    (ctx) => ctx.id === taskDef.contextId,
  );

  return {
    conversationId: taskState.lastConversationId,
    contextTitle: context?.title ?? taskDef.contextId,
    taskTitle: taskDef.title,
    isLive: taskState.status === "running",
  };
}

export default function GraphWorkflowPanel({
  projectName,
  sessionName,
  execution,
  layout,
  onPause,
  onResume,
  onAbort,
  onClear,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
  isMutating,
  isMobile,
  mobilePanel,
  autoSwitchPanel,
}: GraphWorkflowPanelProps) {
  const [selectedContextId, setSelectedContextId] = useState<string | null>(
    null,
  );
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);

  const handleSelectContext = useCallback(
    (contextId: string | null) => {
      setSelectedContextId(contextId);
      setViewingTaskId(null);
      if (contextId) autoSwitchPanel("inspector");
    },
    [autoSwitchPanel],
  );

  const handleViewTask = useCallback(
    (taskId: string) => {
      setViewingTaskId(taskId);
      autoSwitchPanel("log");
    },
    [autoSwitchPanel],
  );

  const handleCloseTranscript = useCallback(() => {
    setViewingTaskId(null);
    autoSwitchPanel("graph");
  }, [autoSwitchPanel]);

  const mergedLayout = useMemo(() => {
    if (!execution) return null;
    return generateWorkflowLayout(execution.workingDefinition, layout ?? null);
  }, [execution, layout]);

  const viewingTask =
    execution && viewingTaskId
      ? resolveViewingTask(execution, viewingTaskId)
      : null;

  if (!execution) {
    return (
      <div className="wb-empty-state">
        <span className="wb-empty-state-text">
          No graph workflow execution has started for this session.
        </span>
      </div>
    );
  }

  if (!mergedLayout) {
    return (
      <div className="wb-empty-state">
        <span className="wb-empty-state-text">Loading layout...</span>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="wb-execution-viewer">
        <ExecutionStatusBar
          execution={execution}
          onPause={onPause}
          onResume={onResume}
          onAbort={onAbort}
          onClear={onClear}
          isMutating={isMutating}
        />
        <div className="wb-execution-body">
          {isMobile ? (
            <>
              <WorkflowExecutionCanvas
                execution={execution}
                layout={mergedLayout}
                onSelectContext={handleSelectContext}
              />
              <ExecutionInspectorPanel
                execution={execution}
                selectedContextId={selectedContextId}
                onDeselectContext={() => handleSelectContext(null)}
                onAddTask={onAddTask}
                onUpdateTask={onUpdateTask}
                onRemoveTask={onRemoveTask}
                onReorderTask={onReorderTask}
                onViewTask={handleViewTask}
                viewingTaskId={viewingTaskId}
                isMutating={isMutating}
              />
              {mobilePanel === "log" && (
                <div className="wb-transcript-viewer">
                  {viewingTask ? (
                    <IterationTranscriptViewer
                      projectName={projectName}
                      sessionName={sessionName}
                      conversationId={viewingTask.conversationId}
                      isLive={viewingTask.isLive}
                      contextTitle={viewingTask.contextTitle}
                      taskTitle={viewingTask.taskTitle}
                      onClose={handleCloseTranscript}
                    />
                  ) : (
                    <div className="wb-mobile-log-empty">
                      Select a task in Inspector to open its log.
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {viewingTask ? (
                <IterationTranscriptViewer
                  projectName={projectName}
                  sessionName={sessionName}
                  conversationId={viewingTask.conversationId}
                  isLive={viewingTask.isLive}
                  contextTitle={viewingTask.contextTitle}
                  taskTitle={viewingTask.taskTitle}
                  onClose={handleCloseTranscript}
                />
              ) : (
                <WorkflowExecutionCanvas
                  execution={execution}
                  layout={mergedLayout}
                  onSelectContext={handleSelectContext}
                />
              )}
              <ExecutionInspectorPanel
                execution={execution}
                selectedContextId={selectedContextId}
                onDeselectContext={() => handleSelectContext(null)}
                onAddTask={onAddTask}
                onUpdateTask={onUpdateTask}
                onRemoveTask={onRemoveTask}
                onReorderTask={onReorderTask}
                onViewTask={handleViewTask}
                viewingTaskId={viewingTaskId}
                isMutating={isMutating}
              />
            </>
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
