"use client";

import { useCallback, useMemo, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import { generateWorkflowLayout } from "@/lib/workflow-graph/layout";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowVisualLayout } from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import type { ExecutionMobilePanel } from "../SessionWorkflowPage";
import ExecutionStatusBar, {
  type ExecutionControlAction,
} from "./ExecutionStatusBar";
import WorkflowExecutionCanvas from "./WorkflowExecutionCanvas";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";
import WorkflowConversationViewer from "./WorkflowConversationViewer";
import { resolveViewingTask } from "./view-task-resolver";
import { useUserInputGate } from "@/hooks/use-user-input-gate";

interface GraphWorkflowPanelProps {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution | null;
  events: GraphWorkflowExecutionEvent[];
  archivedExecutions: GraphWorkflowExecution[];
  layout: GraphWorkflowVisualLayout | null;
  onPause(): void;
  onResume(conflictGuidance?: ConflictDecisionInput[]): void;
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
  onSaveContextConfig(operations: WorkflowLiveEditOperation[]): void;
  isSavingConfig: boolean;
  isPausingExecution: boolean;
  isResumingExecution: boolean;
  configEditConflict: boolean;
  configSaveSucceeded: boolean;
  isMutating: boolean;
  pendingAction: ExecutionControlAction | null;
  isMobile: boolean;
  mobilePanel: ExecutionMobilePanel;
  autoSwitchPanel: (panel: ExecutionMobilePanel) => void;
}

export default function GraphWorkflowPanel({
  projectName,
  sessionName,
  execution,
  events,
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
  onSaveContextConfig,
  isSavingConfig,
  isPausingExecution,
  isResumingExecution,
  configEditConflict,
  configSaveSucceeded,
  isMutating,
  pendingAction,
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

  // Answer panel for the selected context when it is parked awaiting user
  // input. The container owns the answer mutation (QueryClient lives here);
  // the inspector only mounts the panel with these props.
  const userInputPanel = useUserInputGate({
    projectName,
    sessionName,
    execution,
    contextId: selectedContextId,
  });

  const viewingTask =
    execution && viewingTaskId
      ? resolveViewingTask(execution, viewingTaskId)
      : null;

  if (!execution) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-md text-text-tertiary">
        <span className="text-[0.82rem] font-medium">
          No graph workflow execution has started for this session.
        </span>
      </div>
    );
  }

  if (!mergedLayout) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-md text-text-tertiary">
        <span className="text-[0.82rem] font-medium">Loading layout...</span>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="flex min-h-0 flex-1 flex-col">
        <ExecutionStatusBar
          execution={execution}
          onPause={onPause}
          onResume={onResume}
          onAbort={onAbort}
          onClear={onClear}
          isMutating={isMutating}
          pendingAction={pendingAction}
        />
        <div className="flex min-h-0 flex-1 max-768:flex-col">
          {isMobile ? (
            <>
              <WorkflowExecutionCanvas
                execution={execution}
                layout={mergedLayout}
                onSelectContext={handleSelectContext}
              />
              <ExecutionInspectorPanel
                execution={execution}
                events={events}
                selectedContextId={selectedContextId}
                userInputPanel={userInputPanel}
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
                onSaveContextConfig={onSaveContextConfig}
                onPauseExecution={onPause}
                onResumeExecution={() => onResume()}
                isSavingConfig={isSavingConfig}
                isPausingExecution={isPausingExecution}
                isResumingExecution={isResumingExecution}
                configEditConflict={configEditConflict}
                configSaveSucceeded={configSaveSucceeded}
                onViewConversation={handleViewConversation}
              />
              {mobilePanel === "log" && (
                <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-void max-768:[.app[data-page=workflow][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow][data-mobile-panel=inspector]_&]:hidden">
                  {viewingTask ? (
                    <WorkflowConversationViewer
                      projectName={projectName}
                      sessionName={sessionName}
                      conversationId={viewingTask.conversationId}
                      isLive={viewingTask.isLive}
                      contextTitle={viewingTask.contextTitle}
                      taskTitle={viewingTask.taskTitle}
                      onClose={handleCloseTranscript}
                    />
                  ) : viewingConversation ? (
                    <WorkflowConversationViewer
                      projectName={projectName}
                      sessionName={sessionName}
                      conversationId={viewingConversation.conversationId}
                      isLive={false}
                      contextTitle={viewingConversation.contextTitle}
                      taskTitle={viewingConversation.label}
                      onClose={handleCloseTranscript}
                    />
                  ) : (
                    <div className="flex flex-1 flex-col items-center justify-center p-xl text-[0.82rem] text-text-tertiary">
                      Select a task in Inspector to open its log.
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              {viewingTask ? (
                <WorkflowConversationViewer
                  projectName={projectName}
                  sessionName={sessionName}
                  conversationId={viewingTask.conversationId}
                  isLive={viewingTask.isLive}
                  contextTitle={viewingTask.contextTitle}
                  taskTitle={viewingTask.taskTitle}
                  onClose={handleCloseTranscript}
                />
              ) : viewingConversation ? (
                <WorkflowConversationViewer
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
                events={events}
                selectedContextId={selectedContextId}
                userInputPanel={userInputPanel}
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
                onSaveContextConfig={onSaveContextConfig}
                onPauseExecution={onPause}
                onResumeExecution={() => onResume()}
                isSavingConfig={isSavingConfig}
                isPausingExecution={isPausingExecution}
                isResumingExecution={isResumingExecution}
                configEditConflict={configEditConflict}
                configSaveSucceeded={configSaveSucceeded}
                onViewConversation={handleViewConversation}
              />
            </>
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
