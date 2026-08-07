"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "@/components/workflow-graph/workflow-graph.css";
import { generateWorkflowLayout } from "@/lib/workflow-graph/layout";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionHistoryItem,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowVisualLayout } from "@/lib/workflow-graph/definition-schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { ConflictDecisionInput } from "@/lib/jobs/schemas";
import { Button } from "@/components/ui/Button";
import type { ExecutionMobilePanel } from "../SessionWorkflowPage";
import ArchivedExecutionsList from "./ArchivedExecutionsList";
import ExecutionStatusBar, {
  type ExecutionControlAction,
} from "./ExecutionStatusBar";
import WorkflowExecutionCanvas from "./WorkflowExecutionCanvas";
import ExecutionInspectorPanel, {
  type ContextTabRequest,
} from "./ExecutionInspectorPanel";
import type { AdvisoryOrigin } from "./AdvisoryIndexPanel";
import WorkflowConversationViewer from "./WorkflowConversationViewer";
import { resolveViewingTask } from "./view-task-resolver";
import { deriveUserInputStandings } from "@/hooks/use-user-input-gate";
import ParkedQuestionPanel from "./ParkedQuestionPanel";
import { useValidationCommandOptions } from "@/lib/validation/queries";

interface GraphWorkflowPanelProps {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution | null;
  events: GraphWorkflowExecutionEvent[];
  /**
   * The session's finished runs, newest first. Rendered in the no-active-run
   * state: after a schema cutover empties the active slot, this list is the
   * only place an operator can see that their in-flight run was ended and why.
   */
  archivedExecutions: GraphWorkflowExecutionHistoryItem[];
  layout: GraphWorkflowVisualLayout | null;
  onPause(): void;
  onResume(conflictGuidance?: ConflictDecisionInput[]): void;
  onAbort(): void;
  onClear(): void;
  onApproveDefinition(): void;
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
  /** Reset ONE cohort member's lane, leaving its siblings and the context alone. */
  onResetAssignment?(contextId: string, assignmentId: string): void;
  /** The assignment whose reset is in flight, if any. */
  resettingAssignmentId?: string | null;
  onSaveContextConfig(operations: WorkflowLiveEditOperation[]): void;
  isSavingConfig: boolean;
  isPausingExecution: boolean;
  isResumingExecution: boolean;
  isApprovingDefinition: boolean;
  definitionApprovalError: string | null;
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
  archivedExecutions,
  layout,
  onPause,
  onResume,
  onAbort,
  onClear,
  onApproveDefinition,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
  onResetContext,
  onResetAssignment,
  resettingAssignmentId,
  onSaveContextConfig,
  isSavingConfig,
  isPausingExecution,
  isResumingExecution,
  isApprovingDefinition,
  definitionApprovalError,
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

  // "Edit schema" on an output-schema halt: select the refusing context and
  // open the tab that owns its contract, so the fix is one click from the halt
  // that named it. The counter makes a repeat request distinguishable from a
  // re-render of the previous one.
  const [contextTabRequest, setContextTabRequest] =
    useState<ContextTabRequest | null>(null);
  const tabRequestSeq = useRef(0);
  const handleEditOutputSchema = useCallback(
    (contextId: string) => {
      handleSelectContext(contextId);
      tabRequestSeq.current += 1;
      setContextTabRequest({
        contextId,
        tab: "config",
        seq: tabRequestSeq.current,
      });
    },
    [handleSelectContext],
  );

  // An advisory-index entry's origin link: select the context that raised it and
  // open its history at the ROUND that raised it — an indexed advisory outlives
  // its round, so by the time it is read the context is usually several rounds
  // further on. Shares the one tab-request counter, so a request from either
  // deep link is always distinguishable from the previous one.
  const handleOpenAdvisoryOrigin = useCallback(
    ({ contextId, roundSeq }: AdvisoryOrigin) => {
      handleSelectContext(contextId);
      tabRequestSeq.current += 1;
      setContextTabRequest({
        contextId,
        tab: "history",
        roundSeq,
        seq: tabRequestSeq.current,
      });
    },
    [handleSelectContext],
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
    (
      conversationId: string,
      lane: string,
      contextId: string,
      // The use site the caller opened, when it knows one. With a cohort the
      // lane kind names several conversations at once, so an assignment-labeled
      // header is the only thing that tells two validator transcripts apart.
      assignmentLabel?: string,
    ) => {
      const contextDef = execution?.workingDefinition.executionContexts.find(
        (ctx) => ctx.id === contextId,
      );
      const label =
        assignmentLabel ??
        (lane === "context_validator" ? "Context Validator" : "Implementer");
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

  // One answer panel per lane of the selected context that is waiting on the
  // human: a cohort's validators park independently, so several questions can
  // stand at once and each is answered on its own conversation. Keyed by lane
  // key so a sibling settling never remounts the panel still being filled in.
  const userInputStandings = deriveUserInputStandings(
    execution,
    selectedContextId,
  );
  const userInputPanels =
    userInputStandings.length > 0
      ? userInputStandings.map((standing) => (
          <ParkedQuestionPanel
            key={standing.laneKey}
            projectName={projectName}
            sessionName={sessionName}
            standing={standing}
          />
        ))
      : null;

  // This project's registry, for the config tab's command multi-selects.
  const commandOptions = useValidationCommandOptions(projectName);

  const viewingTask =
    execution && viewingTaskId
      ? resolveViewingTask(execution, viewingTaskId)
      : null;
  const isAwaitingDefinitionApproval =
    execution?.status === "pending" &&
    execution.definitionApproval !== null &&
    execution.definitionApproval.approvedAt === null;

  if (!execution) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-md overflow-y-auto p-lg text-text-tertiary">
        <span className="text-[0.82rem] font-medium">
          No graph workflow execution has started for this session.
        </span>
        <ArchivedExecutionsList executions={archivedExecutions} />
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
      <div
        className="flex min-h-0 flex-1 flex-col"
        data-workflow-execution-id={execution.id}
      >
        <ExecutionStatusBar
          execution={execution}
          events={events}
          onEditSchema={handleEditOutputSchema}
          onPause={onPause}
          onResume={onResume}
          onAbort={onAbort}
          onClear={onClear}
          isMutating={isMutating}
          pendingAction={pendingAction}
        />
        {isAwaitingDefinitionApproval && (
          <section
            aria-label="Definition approval"
            className="flex shrink-0 flex-wrap items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-amber-dim bg-amber-glow px-md py-sm"
          >
            <div>
              <p className="m-0 font-mono text-[0.72rem] font-bold tracking-[0.05em] text-amber uppercase">
                Definition awaiting approval
              </p>
              <p className="mt-[3px] mb-0 text-[0.7rem] text-text-secondary">
                Approve the parked definition to start this workflow.
              </p>
              {definitionApprovalError !== null && (
                <p
                  role="alert"
                  className="mt-xs mb-0 font-mono text-[0.68rem] text-red"
                >
                  {definitionApprovalError}
                </p>
              )}
            </div>
            <Button
              size="sm"
              variant="success"
              touch
              loading={isApprovingDefinition}
              disabled={isMutating}
              onClick={onApproveDefinition}
            >
              Approve definition &amp; start
            </Button>
          </section>
        )}
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
                userInputPanels={userInputPanels}
                onSelectContext={(id) => handleSelectContext(id)}
                onDeselectContext={() => handleSelectContext(null)}
                onAddTask={onAddTask}
                onUpdateTask={onUpdateTask}
                onRemoveTask={onRemoveTask}
                onReorderTask={onReorderTask}
                onResetContext={onResetContext}
                onResetAssignment={onResetAssignment}
                resettingAssignmentId={resettingAssignmentId}
                libraryProjectName={projectName}
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
                onEditSchema={handleEditOutputSchema}
                onOpenAdvisoryOrigin={handleOpenAdvisoryOrigin}
                contextTabRequest={contextTabRequest}
                commandOptions={commandOptions}
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
                userInputPanels={userInputPanels}
                onSelectContext={(id) => handleSelectContext(id)}
                onDeselectContext={() => handleSelectContext(null)}
                onAddTask={onAddTask}
                onUpdateTask={onUpdateTask}
                onRemoveTask={onRemoveTask}
                onReorderTask={onReorderTask}
                onResetContext={onResetContext}
                onResetAssignment={onResetAssignment}
                resettingAssignmentId={resettingAssignmentId}
                libraryProjectName={projectName}
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
                onEditSchema={handleEditOutputSchema}
                onOpenAdvisoryOrigin={handleOpenAdvisoryOrigin}
                contextTabRequest={contextTabRequest}
                commandOptions={commandOptions}
              />
            </>
          )}
        </div>
      </div>
    </ReactFlowProvider>
  );
}
