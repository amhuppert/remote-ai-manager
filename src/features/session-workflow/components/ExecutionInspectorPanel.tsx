"use client";

import type { ReactNode } from "react";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLaneKind,
} from "@/lib/workflow-graph/schemas";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { GraphWorkflowBoundaryResultProjection } from "@/lib/workflow-graph/execution-result-projection";
import type { AdvisoryOrigin } from "./AdvisoryIndexPanel";
import ContextDetail from "./inspector/ContextDetail";
import OverviewSurface from "./inspector/OverviewSurface";
import type { InspectorNavigationRequest } from "./inspector/navigation";
import type { OverviewRowId } from "./inspector/overview-model";

/**
 * The execution inspector rail: the Overview when nothing is selected, the
 * context surfaces when something is (README §11).
 *
 * A thin assembly — every surface it shows lives in `./inspector/`, and this
 * file owns only the props the container passes in and the one decision of
 * which of the two surfaces is showing.
 */

interface ExecutionInspectorPanelProps {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  /** Whether `events` is the whole log; see `ContextDetail`. */
  eventsAreComplete?: boolean;
  /**
   * The loop-ledger view, injected as a slot (D4 R16.2). The ledger reads the
   * cursor-paginated event history, which is a data fetch — the container owns
   * it so this panel stays presentational.
   */
  loopLedger?: ReactNode;
  selectedContextId: string | null;
  /**
   * One answer panel per lane of the selected context that is waiting on the
   * human — a cohort's validators park independently, so a context can be
   * waiting on several answers at once. The container renders them (each panel
   * owns the answer mutation for its own asking conversation); the inspector
   * only decides where they appear.
   */
  userInputPanels?: ReactNode;
  /**
   * The selected context's own approval card, when it has a parked gate. Sits
   * beside the question panels because it is the same kind of wait: one context,
   * one decision, reachable from the row that names it.
   */
  contextApprovalPanel?: ReactNode;
  onSelectContext?: (contextId: string) => void;
  onDeselectContext: () => void;
  onAddTask: (contextId: string, title: string, instructions: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: { title?: string; instructions?: string },
  ) => void;
  onRemoveTask: (taskId: string) => void;
  onReorderTask: (contextId: string, orderedTaskIds: string[]) => void;
  onResetContext?: (contextId: string) => void;
  /** Reset ONE cohort member's lane, leaving its siblings and the context alone. */
  onResetAssignment?: (contextId: string, assignmentId: string) => void;
  /** The assignment whose reset is in flight, if any. */
  resettingAssignmentId?: string | null;
  /** Scopes the agent-profile listing the config tab's pickers offer. */
  libraryProjectName?: string | null;
  onViewTask: (taskId: string) => void;
  viewingTaskId: string | null;
  isMutating: boolean;
  /**
   * Config-tab live editing (doc 06, "UI plan" Goal 2). The container owns the
   * concurrency guard and the dedicated config mutation, so the inspector stays
   * presentational: it forwards the composed op batch and the mutation's
   * pending/conflict/success state.
   */
  onSaveContextConfig?: (operations: WorkflowLiveEditOperation[]) => void;
  onPauseExecution?: () => void;
  onResumeExecution?: () => void;
  isSavingConfig?: boolean;
  isPausingExecution?: boolean;
  isResumingExecution?: boolean;
  configEditConflict?: boolean;
  configEditError?: string | null;
  configSaveSucceeded?: boolean;
  /**
   * Opens one lane's transcript. `label` names the use site the transcript
   * belongs to (`Validator · security`) — with a cohort, "the context
   * validator" no longer identifies a conversation, so a header built from the
   * lane KIND alone would title several transcripts identically.
   */
  onViewConversation?: (
    conversationId: string,
    lane: GraphWorkflowLaneKind,
    contextId: string,
    label?: string,
  ) => void;
  /**
   * "Edit schema" on an output-schema halt shown in the OVERVIEW: no context is
   * selected there, so clearing the halt means selecting the refusing context
   * first. The container owns that navigation; the context view resolves its
   * own action locally (it is already on the context).
   */
  onEditSchema?: (contextId: string) => void;
  /**
   * An advisory-index entry's link back to where it was raised. Same shape and
   * same reason as `onEditSchema`: the overview has no context selected, so the
   * container owns the navigation and the tab request that follows it.
   */
  onOpenAdvisoryOrigin?: (origin: AdvisoryOrigin) => void;
  /**
   * A host's request to open a specific tab for a specific context — the halt
   * dialog's "Edit schema" deep link, and the advisory index's origin link.
   * `seq` distinguishes two identical requests (the operator asking twice) from
   * a re-render of one, so the inspector honours the second without stealing
   * the tab on every render.
   */
  contextTabRequest?: InspectorNavigationRequest | null;
  /**
   * A host's request to open one of the Overview's drill screens — the status
   * bar's gates chip. Same `seq` discipline as `contextTabRequest`, for the
   * same reason: a repeat ask must be distinguishable from a re-render.
   */
  overviewScreenRequest?: { screen: OverviewRowId; seq: number } | null;
  /** Project-scoped registry summaries for the config tab's command
   * multi-selects; undefined = registry unavailable. */
  commandOptions?: readonly ValidationCommandSummary[];
  /**
   * The run's durable boundary result, shown in Overview → Result (README §11).
   * Null until the run reaches a terminal state that recorded one.
   */
  result?: GraphWorkflowBoundaryResultProjection | null;
  /**
   * The saved template's current revision. A run is launched from an immutable
   * snapshot, so a draft that has moved on is the one fact the Overview must
   * state rather than let a reader assume the two agree.
   */
  draftRevision?: number | null;
  /** Historical runs retain every inspection surface but expose no edits. */
  readOnly?: boolean;
}

// ---- Main Component ----

export default function ExecutionInspectorPanel({
  execution,
  events,
  eventsAreComplete = true,
  loopLedger,
  selectedContextId,
  userInputPanels,
  contextApprovalPanel,
  onSelectContext,
  onDeselectContext,
  onAddTask,
  onUpdateTask,
  onRemoveTask,
  onReorderTask,
  onResetContext,
  onResetAssignment,
  resettingAssignmentId,
  libraryProjectName,
  onViewTask,
  viewingTaskId,
  isMutating,
  onSaveContextConfig,
  onPauseExecution,
  onResumeExecution,
  isSavingConfig,
  isPausingExecution,
  isResumingExecution,
  configEditConflict,
  configEditError,
  configSaveSucceeded,
  onViewConversation,
  onEditSchema,
  onOpenAdvisoryOrigin,
  contextTabRequest,
  overviewScreenRequest = null,
  commandOptions,
  result = null,
  draftRevision = null,
  readOnly = false,
}: ExecutionInspectorPanelProps) {
  const selectedContext = selectedContextId
    ? execution.workingDefinition.executionContexts.find(
        (ctx) => ctx.id === selectedContextId,
      )
    : null;

  if (!selectedContext || !selectedContextId) {
    return (
      <OverviewSurface
        execution={execution}
        events={events}
        loopLedger={loopLedger}
        result={result}
        draftRevision={draftRevision}
        screenRequest={overviewScreenRequest}
        {...(onSelectContext ? { onSelectContext } : {})}
        {...(onOpenAdvisoryOrigin !== undefined
          ? { onOpenAdvisoryOrigin }
          : {})}
        {...(!readOnly && onEditSchema !== undefined ? { onEditSchema } : {})}
      />
    );
  }

  return (
    <ContextDetail
      execution={execution}
      events={events}
      eventsAreComplete={eventsAreComplete}
      contextId={selectedContextId}
      userInputPanels={userInputPanels}
      contextApprovalPanel={contextApprovalPanel}
      onDeselectContext={onDeselectContext}
      onAddTask={onAddTask}
      onUpdateTask={onUpdateTask}
      onRemoveTask={onRemoveTask}
      onReorderTask={onReorderTask}
      onResetContext={onResetContext}
      onResetAssignment={onResetAssignment}
      resettingAssignmentId={resettingAssignmentId}
      libraryProjectName={libraryProjectName}
      onViewTask={onViewTask}
      viewingTaskId={viewingTaskId}
      isMutating={isMutating}
      onSaveContextConfig={onSaveContextConfig}
      onPauseExecution={onPauseExecution}
      onResumeExecution={onResumeExecution}
      isSavingConfig={isSavingConfig}
      isPausingExecution={isPausingExecution}
      isResumingExecution={isResumingExecution}
      configEditConflict={configEditConflict}
      configEditError={configEditError}
      configSaveSucceeded={configSaveSucceeded}
      onViewConversation={onViewConversation}
      contextTabRequest={contextTabRequest}
      commandOptions={commandOptions}
      readOnly={readOnly}
    />
  );
}
