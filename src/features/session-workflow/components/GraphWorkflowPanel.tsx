"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
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
import { IconButton } from "@/components/ui/IconButton";
import {
  railOverlayPanelClass,
  RailOverlaySpacer,
} from "@/components/workflow-graph/RailOverlay";
import { useWorkflowRailCollapse } from "@/components/workflow-graph/useWorkflowRailCollapse";
import { MobilePanelVisibility } from "@/components/workflow-graph/mobile-panel-visibility";
import { cn } from "@/lib/ui/cn";
import type { ExecutionMobilePanel } from "../SessionWorkflowPage";
import ExecutionStatusBar, {
  type ExecutionControlAction,
} from "./ExecutionStatusBar";
import { PanelRightIcon } from "./execution-icons";
import WorkflowExecutionCanvas from "./WorkflowExecutionCanvas";
import LoopLedgerPanel from "./LoopLedgerPanel";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";
import {
  InspectorNavigationProvider,
  useInspectorNavigationState,
} from "./inspector/InspectorNavigationContext";
import {
  ADVISORY_ORIGIN,
  LANE_RUNTIME,
  OUTPUT_SCHEMA_REPAIR,
  PLACEMENT_OWNERSHIP,
} from "./inspector/navigation";
import type { OverviewRowId } from "./inspector/overview-model";
import type { AdvisoryOrigin } from "./AdvisoryIndexPanel";
import WorkflowConversationViewer from "./WorkflowConversationViewer";
import { isWorkflowConversationLive } from "./inspector/conversation-history";
import { resolveViewingTask } from "./view-task-resolver";
import { deriveUserInputStandings } from "@/hooks/use-user-input-gate";
import ParkedQuestionPanel from "./ParkedQuestionPanel";
import { useValidationCommandOptions } from "@/lib/validation/queries";
import type { GraphWorkflowBoundaryResultProjection } from "@/lib/workflow-graph/execution-result-projection";
import {
  awaitsDefinitionApproval,
  holdsExecutionLease,
} from "@/lib/workflow-graph/lifecycle-classifier";

export type WorkflowActionCapability = "current" | "read-only";

interface GraphWorkflowPanelProps {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution | null;
  events: GraphWorkflowExecutionEvent[];
  /** Whether `events` is the whole log; see `ContextDetail`. */
  eventsAreComplete?: boolean;
  /** @deprecated History is rendered by the page-level selectable rail. */
  archivedExecutions?: GraphWorkflowExecutionHistoryItem[];
  layout: GraphWorkflowVisualLayout | null;
  /** Page-owned authority: History is inspectable but has no mutation surface. */
  actionCapability?: WorkflowActionCapability;
  /** Durable boundary projection for a selected historical execution. */
  result?: GraphWorkflowBoundaryResultProjection | null;
  /**
   * The saved template's current revision, when this run has a template to
   * compare against. Feeds the Overview's launch note: a run reads its
   * immutable snapshot, so a draft that has moved on must be said out loud.
   */
  draftRevision?: number | null;
  onPause(): void;
  onResume(conflictGuidance?: ConflictDecisionInput[]): void;
  onAbort(): void;
  onAbandon(): void;
  onApproveDefinition(): void;
  onRejectDefinition(): void;
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
  isRejectingDefinition: boolean;
  definitionApprovalError: string | null;
  configEditConflict: boolean;
  configEditError: string | null;
  configSaveSucceeded: boolean;
  isMutating: boolean;
  pendingAction: ExecutionControlAction | null;
  isMobile: boolean;
  mobilePanel: ExecutionMobilePanel;
  autoSwitchPanel: (panel: ExecutionMobilePanel) => void;
  /** M2 execution chip copy — `<exec_id> · Current`/`· History`. */
  executionChipLabel?: string;
  /** The M2 Executions sheet body, given the handle that dismisses it. */
  renderExecutionsSheet?: (close: () => void) => ReactNode;
  /**
   * The approval surface for ONE context, already bound to its mutation.
   *
   * A renderer rather than a pre-built stack: README §10 is explicit that there
   * is no single global gate, so a run with two parked approvals must not show
   * both cards together above the canvas. Each card belongs to the context that
   * parked it and renders inside that context's detail, exactly like a parked
   * question, which is what a gate row navigates to.
   */
  renderContextApproval?: (contextId: string) => ReactNode;
}

export default function GraphWorkflowPanel({
  projectName,
  sessionName,
  execution,
  events,
  eventsAreComplete = true,
  layout,
  actionCapability = "current",
  result = null,
  draftRevision = null,
  onPause,
  onResume,
  onAbort,
  onAbandon,
  onApproveDefinition,
  onRejectDefinition,
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
  isRejectingDefinition,
  definitionApprovalError,
  configEditConflict,
  configEditError,
  configSaveSucceeded,
  isMutating,
  pendingAction,
  isMobile,
  mobilePanel,
  autoSwitchPanel,
  executionChipLabel,
  renderExecutionsSheet,
  renderContextApproval,
}: GraphWorkflowPanelProps) {
  const actionsAvailable = actionCapability === "current";
  const [selectedContextId, setSelectedContextId] = useState<string | null>(
    null,
  );
  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [viewingConversation, setViewingConversation] = useState<{
    conversationId: string;
    /** Kept so liveness can be re-read while the transcript is open. */
    contextId: string;
    contextTitle: string;
    label: string;
  } | null>(null);
  // Desktop-only: below 768px the bottom tab bar owns which panel is visible,
  // so a second, invisible collapse state there would silently hide the panel
  // the tab bar says is showing.
  const {
    collapsed: inspectorCollapsed,
    setCollapsed: setInspectorCollapsed,
    overlay: inspectorOverlay,
  } = useWorkflowRailCollapse();
  const [overviewScreenRequest, setOverviewScreenRequest] = useState<{
    screen: OverviewRowId;
    seq: number;
  } | null>(null);

  const handleSelectContext = useCallback(
    (contextId: string | null) => {
      setSelectedContextId(contextId);
      setViewingTaskId(null);
      if (contextId) autoSwitchPanel("inspector");
    },
    [autoSwitchPanel],
  );

  // Every deep link into the rail goes through the one typed handle, which owns
  // selecting the context and the request counter that makes a repeat ask
  // distinguishable from a re-render of the previous one.
  const { request: contextTabRequest, handle: inspectorNavigation } =
    useInspectorNavigationState(handleSelectContext);

  // The status bar's gates chip: the count opens the list it counts. Nothing on
  // this run is a global gate, so the chip lands on the Overview's gates list
  // rather than on any one context — the rows name the contexts.
  const handleOpenGates = useCallback(() => {
    setSelectedContextId(null);
    setViewingTaskId(null);
    setInspectorCollapsed(false);
    autoSwitchPanel("inspector");
    setOverviewScreenRequest((previous) => ({
      screen: "gates",
      seq: (previous?.seq ?? 0) + 1,
    }));
  }, [autoSwitchPanel, setInspectorCollapsed]);

  // "Edit schema" on an output-schema halt: the fix is one click from the halt
  // that named it.
  const handleEditOutputSchema = useCallback(
    (contextId: string) => {
      inspectorNavigation.openContext(contextId, OUTPUT_SCHEMA_REPAIR);
    },
    [inspectorNavigation],
  );

  // A blocked join member's two ways out: its lane worktree (Config → Runtime)
  // and the ownership that overlapped (Config → Placement). Both are the
  // existing config destinations, reached through the one navigation handle.
  const handleOpenLaneWorktree = useCallback(
    (contextId: string) => {
      inspectorNavigation.openContext(contextId, LANE_RUNTIME);
    },
    [inspectorNavigation],
  );

  const handleEditOwnership = useCallback(
    (contextId: string) => {
      inspectorNavigation.openContext(contextId, PLACEMENT_OWNERSHIP);
    },
    [inspectorNavigation],
  );

  // An advisory-index entry's origin link: an indexed advisory outlives its
  // round, so by the time it is read the context is usually several rounds
  // further on and the tab alone would land in the wrong place.
  const handleOpenAdvisoryOrigin = useCallback(
    ({ contextId, advisory }: AdvisoryOrigin) => {
      inspectorNavigation.openContext(contextId, ADVISORY_ORIGIN(advisory));
    },
    [inspectorNavigation],
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
        contextId,
        contextTitle: contextDef?.title ?? contextId,
        label,
      });
      setViewingTaskId(null);
      autoSwitchPanel("log");
    },
    [execution, autoSwitchPanel],
  );

  /**
   * The repair agent's own transcript. It is not a lane conversation — the
   * repair runs against a halted context that holds no seat — so it opens
   * through the same viewer with a label of its own rather than through the
   * lane-kind default.
   */
  const handleViewRepairConversation = useCallback(
    (conversationId: string, contextId: string) => {
      handleViewConversation(
        conversationId,
        "plan_repair",
        contextId,
        "Plan repair",
      );
    },
    [handleViewConversation],
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
    actionsAvailable && userInputStandings.length > 0
      ? userInputStandings.map((standing) => (
          <ParkedQuestionPanel
            key={standing.laneKey}
            projectName={projectName}
            sessionName={sessionName}
            standing={standing}
          />
        ))
      : null;

  // The approval card for the SELECTED context only. A parked approval is a
  // wait on one context, so its decision surface lives with that context — the
  // gates list is what says a second one exists elsewhere, and its row is how
  // the operator reaches it.
  const contextApprovalPanel =
    actionsAvailable && selectedContextId !== null
      ? (renderContextApproval?.(selectedContextId) ?? null)
      : null;

  // This project's registry, for the config tab's command multi-selects.
  const commandOptions = useValidationCommandOptions(projectName);

  const viewingTask =
    execution && viewingTaskId
      ? resolveViewingTask(execution, viewingTaskId)
      : null;
  // Read at render, exactly like the task transcript above, because the Log
  // header states live/ended and the run can settle while the transcript is
  // open. The answer comes from the lane that owns the conversation rather than
  // being assumed: a seat still validating and a seat that has returned its
  // verdict both open from the same History surface.
  const viewingConversationIsLive =
    execution !== null &&
    viewingConversation !== null &&
    isWorkflowConversationLive(
      execution,
      viewingConversation.contextId,
      viewingConversation.conversationId,
    );
  const isAwaitingDefinitionApproval =
    execution !== null &&
    awaitsDefinitionApproval(execution.status, execution.definitionApproval);
  const canDecideDefinitionApproval =
    actionsAvailable &&
    isAwaitingDefinitionApproval &&
    execution !== null &&
    holdsExecutionLease(
      execution.status,
      execution.haltReason,
      execution.abandonment,
    );

  if (!execution) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-md overflow-y-auto p-lg text-text-tertiary">
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
      <InspectorNavigationProvider handle={inspectorNavigation}>
        <div
          className="flex min-h-0 flex-1 flex-col"
          data-workflow-execution-id={execution.id}
        >
          <ExecutionStatusBar
            // Remounted per execution so a confirmation opened for one run can
            // never be accepted against the run that replaced it.
            key={execution.id}
            execution={execution}
            events={events}
            {...(actionsAvailable
              ? {
                  onEditSchema: handleEditOutputSchema,
                  onOpenGates: handleOpenGates,
                  onOpenLaneWorktree: handleOpenLaneWorktree,
                  onEditOwnership: handleEditOwnership,
                  onViewRepairConversation: handleViewRepairConversation,
                }
              : {})}
            onPause={onPause}
            onResume={onResume}
            onAbort={onAbort}
            onAbandon={onAbandon}
            {...(canDecideDefinitionApproval
              ? {
                  onApproveDefinition,
                  onRejectDefinition,
                  isApprovingDefinition,
                  isRejectingDefinition,
                  definitionApprovalError,
                }
              : {})}
            isMutating={isMutating}
            pendingAction={pendingAction}
            allowActions={actionsAvailable}
            isMobile={isMobile}
            {...(executionChipLabel === undefined
              ? {}
              : { executionChipLabel })}
            {...(renderExecutionsSheet === undefined
              ? {}
              : { renderExecutionsSheet })}
            {...(isMobile || inspectorCollapsed
              ? {}
              : {
                  // Expanding is the strip's job once the rail is collapsed —
                  // two controls with the same name would be two ways to say
                  // the same thing in the same view.
                  trailingControls: (
                    <IconButton
                      variant="square"
                      aria-label="Collapse inspector"
                      title="Collapse inspector"
                      onClick={() => setInspectorCollapsed(true)}
                    >
                      <PanelRightIcon />
                    </IconButton>
                  ),
                })}
          />
          <div className="relative flex min-h-0 flex-1 max-768:flex-col">
            {isMobile ? (
              <>
                <WorkflowExecutionCanvas
                  execution={execution}
                  layout={mergedLayout}
                  onSelectContext={handleSelectContext}
                  preserveLayout={!actionsAvailable}
                  isMobile
                  selectedContextId={selectedContextId}
                  onOpenLaneWorktree={handleOpenLaneWorktree}
                  onEditOwnership={handleEditOwnership}
                />
                <MobilePanelVisibility onScreen={mobilePanel === "inspector"}>
                  <ExecutionInspectorPanel
                    execution={execution}
                    events={events}
                    eventsAreComplete={eventsAreComplete}
                    loopLedger={
                      <LoopLedgerPanel
                        projectName={projectName}
                        sessionName={sessionName}
                        execution={execution}
                        {...(!actionsAvailable ? { events } : {})}
                      />
                    }
                    selectedContextId={selectedContextId}
                    userInputPanels={userInputPanels}
                    contextApprovalPanel={contextApprovalPanel}
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
                    configEditError={configEditError}
                    configSaveSucceeded={configSaveSucceeded}
                    onViewConversation={handleViewConversation}
                    onEditSchema={handleEditOutputSchema}
                    onOpenAdvisoryOrigin={handleOpenAdvisoryOrigin}
                    contextTabRequest={contextTabRequest}
                    overviewScreenRequest={overviewScreenRequest}
                    commandOptions={commandOptions}
                    result={result}
                    draftRevision={draftRevision}
                    readOnly={!actionsAvailable}
                  />
                </MobilePanelVisibility>
                {mobilePanel === "log" && (
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg-void max-768:[.app[data-page=workflow][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow][data-mobile-panel=inspector]_&]:hidden">
                    {viewingTask ? (
                      <WorkflowConversationViewer
                        projectName={projectName}
                        sessionName={sessionName}
                        conversationId={viewingTask.conversationId}
                        isLive={viewingTask.isLive}
                        role="Implementer"
                        contextTitle={viewingTask.contextTitle}
                        taskTitle={viewingTask.taskTitle}
                        onClose={handleCloseTranscript}
                      />
                    ) : viewingConversation ? (
                      <WorkflowConversationViewer
                        projectName={projectName}
                        sessionName={sessionName}
                        conversationId={viewingConversation.conversationId}
                        isLive={viewingConversationIsLive}
                        role={viewingConversation.label}
                        contextTitle={viewingConversation.contextTitle}
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
                    role="Implementer"
                    contextTitle={viewingTask.contextTitle}
                    taskTitle={viewingTask.taskTitle}
                    onClose={handleCloseTranscript}
                  />
                ) : viewingConversation ? (
                  <WorkflowConversationViewer
                    projectName={projectName}
                    sessionName={sessionName}
                    conversationId={viewingConversation.conversationId}
                    isLive={viewingConversationIsLive}
                    role={viewingConversation.label}
                    contextTitle={viewingConversation.contextTitle}
                    onClose={handleCloseTranscript}
                  />
                ) : (
                  <WorkflowExecutionCanvas
                    execution={execution}
                    layout={mergedLayout}
                    onSelectContext={handleSelectContext}
                    preserveLayout={!actionsAvailable}
                    onOpenLaneWorktree={handleOpenLaneWorktree}
                    onEditOwnership={handleEditOwnership}
                  />
                )}
                {inspectorCollapsed ? (
                  // §12: the rail becomes a strip rather than vanishing, so the
                  // way back stays where the rail was.
                  <div className="flex w-[36px] shrink-0 flex-col items-center border-y-0 border-r-0 border-l border-solid border-border-subtle bg-bg-base py-sm">
                    <IconButton
                      variant="square"
                      aria-label="Expand inspector"
                      title="Expand inspector"
                      onClick={() => setInspectorCollapsed(false)}
                    >
                      <PanelRightIcon />
                    </IconButton>
                  </div>
                ) : (
                  <>
                    {inspectorOverlay && (
                      <RailOverlaySpacer side="right" stripWidth="36" />
                    )}
                    <div
                      className={
                        inspectorOverlay
                          ? cn(railOverlayPanelClass("right"), "flex")
                          : "contents"
                      }
                    >
                      <ExecutionInspectorPanel
                        execution={execution}
                        events={events}
                        eventsAreComplete={eventsAreComplete}
                        loopLedger={
                          <LoopLedgerPanel
                            projectName={projectName}
                            sessionName={sessionName}
                            execution={execution}
                            {...(!actionsAvailable ? { events } : {})}
                          />
                        }
                        selectedContextId={selectedContextId}
                        userInputPanels={userInputPanels}
                        contextApprovalPanel={contextApprovalPanel}
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
                        configEditError={configEditError}
                        configSaveSucceeded={configSaveSucceeded}
                        onViewConversation={handleViewConversation}
                        onEditSchema={handleEditOutputSchema}
                        onOpenAdvisoryOrigin={handleOpenAdvisoryOrigin}
                        contextTabRequest={contextTabRequest}
                        overviewScreenRequest={overviewScreenRequest}
                        commandOptions={commandOptions}
                        result={result}
                        draftRevision={draftRevision}
                        readOnly={!actionsAvailable}
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </InspectorNavigationProvider>
    </ReactFlowProvider>
  );
}
