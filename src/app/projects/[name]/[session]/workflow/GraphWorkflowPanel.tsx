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
import { resolveViewingTask } from "./view-task-resolver";

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
  onResetContext(contextId: string): void;
  isMutating: boolean;
  isMobile: boolean;
  mobilePanel: ExecutionMobilePanel;
  autoSwitchPanel: (panel: ExecutionMobilePanel) => void;
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
  onResetContext,
  isMutating,
  isMobile,
  mobilePanel,
  autoSwitchPanel,
}: GraphWorkflowPanelProps) {
  const [selectedContextId, setSelectedContextId] = useState<string | null>(
    null,
  );
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [viewingConversation, setViewingConversation] = useState<{
    conversationId: string;
    contextTitle: string;
    label: string;
  } | null>(null);

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
    setViewingConversation(null);
    autoSwitchPanel("graph");
  }, [autoSwitchPanel]);

  const handleViewConversation = useCallback(
    (conversationId: string, lane: string, contextId: string) => {
      const contextDef = execution?.workingDefinition.executionContexts.find(
        (ctx) => ctx.id === contextId,
      );
      const label =
        lane === "context_validator" ? "Context Validator" : "Implementer";
      setViewingConversation({
        conversationId,
        contextTitle: contextDef?.title ?? contextId,
        label,
      });
      setViewingTaskId(null);
      autoSwitchPanel("log");
    },
    [execution, autoSwitchPanel],
  );

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
                onSelectContext={(id) => handleSelectContext(id)}
                onDeselectContext={() => handleSelectContext(null)}
                onAddTask={onAddTask}
                onUpdateTask={onUpdateTask}
                onRemoveTask={onRemoveTask}
                onReorderTask={onReorderTask}
                onResetContext={onResetContext}
                onViewTask={handleViewTask}
                viewingTaskId={viewingTaskId}
                isMutating={isMutating}
                onViewConversation={handleViewConversation}
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
                  ) : viewingConversation ? (
                    <IterationTranscriptViewer
                      projectName={projectName}
                      sessionName={sessionName}
                      conversationId={viewingConversation.conversationId}
                      isLive={false}
                      contextTitle={viewingConversation.contextTitle}
                      taskTitle={viewingConversation.label}
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
              ) : viewingConversation ? (
                <IterationTranscriptViewer
                  projectName={projectName}
                  sessionName={sessionName}
                  conversationId={viewingConversation.conversationId}
                  isLive={false}
                  contextTitle={viewingConversation.contextTitle}
                  taskTitle={viewingConversation.label}
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
                onSelectContext={(id) => handleSelectContext(id)}
                onDeselectContext={() => handleSelectContext(null)}
                onAddTask={onAddTask}
                onUpdateTask={onUpdateTask}
                onRemoveTask={onRemoveTask}
                onReorderTask={onReorderTask}
                onResetContext={onResetContext}
                onViewTask={handleViewTask}
                viewingTaskId={viewingTaskId}
                isMutating={isMutating}
                onViewConversation={handleViewConversation}
              />
            </>
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
