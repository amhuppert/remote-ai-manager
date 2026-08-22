"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  graphWorkflowEventWindowsMeet,
  graphWorkflowLogIsWhole,
  graphWorkflowWalkIsVouched,
  graphWorkflowWalkMissedRetirement,
  graphWorkflowWalkNeedsReread,
  graphWorkflowWalkProvenance,
  mergeGraphWorkflowEventWindows,
  type GraphWorkflowWalkProvenance,
} from "@/lib/workflows/graph-workflow-event-window";
import {
  orderGraphWorkflowEventPages,
  useGraphWorkflowEventPagesQuery,
  useGraphWorkflowEventsQuery,
  useGraphWorkflowExecutionByIdQuery,
  useGraphWorkflowExecutionQuery,
  useGraphWorkflowLatestExecutionResultQuery,
  useScopedWorkflowDefinitionQuery,
} from "@/lib/workflows/queries";
import {
  useAbortGraphWorkflowMutation,
  useAbandonGraphWorkflowMutation,
  useApproveGraphWorkflowDefinitionMutation,
  usePauseGraphWorkflowMutation,
  useResetExecutionContextAssignmentMutation,
  useResetExecutionContextMutation,
  useResumeGraphWorkflowMutation,
  useRejectGraphWorkflowDefinitionMutation,
  useResolveApprovalMutation,
  useRuntimeEditGraphWorkflowMutation,
} from "@/lib/workflows/mutations";
import type { WorkflowDefinitionScope } from "@/lib/workflows/definition-scope";
import { ApiCallError } from "@/lib/api/errors";
import { createClientLogger } from "@/lib/logging/client-logger";
import { pushToast } from "@/stores/toast.store";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { ExecutionMobilePanel } from "../SessionWorkflowPage";
import type { ExecutionControlAction } from "./ExecutionStatusBar";
import GraphWorkflowPanel from "./GraphWorkflowPanel";
import ApprovalGatePanel from "@/components/ApprovalGatePanel";
import { useApprovalScopedChanges } from "@/hooks/use-approval-scoped-changes";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { originFallbackName } from "@/lib/workflow-graph/execution-origin";
import { holdsExecutionLease } from "@/lib/workflow-graph/lifecycle-classifier";

const logger = createClientLogger("session-workflow");

function definitionApprovalErrorMessage(error: Error | null): string | null {
  if (!(error instanceof ApiCallError)) return error?.message ?? null;

  const unmetConditions = error.details?.unmetConditions;
  const instruction = error.details?.instruction;
  const recoveryGuidance = [
    ...(Array.isArray(unmetConditions)
      ? unmetConditions.filter(
          (condition): condition is string => typeof condition === "string",
        )
      : []),
    ...(typeof instruction === "string" ? [instruction] : []),
  ];

  return recoveryGuidance.length > 0
    ? recoveryGuidance.join(" ")
    : error.message;
}

function pauseFailureMessage(error: Error): string {
  if (
    error instanceof ApiCallError &&
    error.code === "workflow_transition_conflict" &&
    error.details?.action === "pause" &&
    error.details.currentStatus === "completed"
  ) {
    return "Workflow completed before pause could be applied.";
  }
  return `Couldn't pause workflow: ${error.message}`;
}

function configEditErrorMessage(error: Error | null): string | null {
  if (!error) return null;
  if (error instanceof ApiCallError && error.code === "revision_conflict") {
    return null;
  }

  if (!(error instanceof ApiCallError)) return error.message;

  const issueMessages = (error.issues ?? []).map((issue) => issue.message);
  const instruction = error.details?.instruction;
  const messages = [
    ...(issueMessages.length > 0 ? issueMessages : [error.message]),
    ...(typeof instruction === "string" ? [instruction] : []),
  ];
  return [...new Set(messages)].join(" ");
}

interface ConnectedGraphWorkflowPanelProps {
  projectName: string;
  sessionName: string;
  selectedExecutionId?: string | null;
  isMobile: boolean;
  mobilePanel: ExecutionMobilePanel;
  autoSwitchPanel: (panel: ExecutionMobilePanel) => void;
  /** M2 execution chip copy, supplied by the page that partitions the rail. */
  executionChipLabel?: string;
  /** The M2 Executions sheet body, given the handle that dismisses it. */
  renderExecutionsSheet?: (close: () => void) => React.ReactNode;
}

interface CurrentContextApproval {
  contextId: string;
  contextTitle: string | null;
  requestedAt: string;
}

function CurrentContextApprovalPanel({
  projectName,
  sessionName,
  execution,
  approval,
}: {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  approval: CurrentContextApproval;
}) {
  const resolveMutation = useResolveApprovalMutation(projectName, sessionName);
  const scopedChanges = useApprovalScopedChanges(
    projectName,
    sessionName,
    approval,
  );

  return (
    <ApprovalGatePanel
      contextTitle={approval.contextTitle}
      iteration={
        execution.contextStates[approval.contextId]?.iterationCount ?? null
      }
      workflowName={
        execution.launchDocument?.name ?? originFallbackName(execution.origin)
      }
      requestedAt={approval.requestedAt}
      isSubmitting={resolveMutation.isPending}
      conversationBusy={false}
      executionSuspended={
        execution.status === "paused" || execution.status === "halted"
      }
      scopedChanges={scopedChanges}
      voiceProjectName={projectName}
      onApprove={() =>
        resolveMutation.mutate({
          executionId: execution.id,
          contextId: approval.contextId,
          decision: "approve",
        })
      }
      onReject={(message) =>
        resolveMutation.mutate({
          executionId: execution.id,
          contextId: approval.contextId,
          decision: "reject",
          message,
        })
      }
    />
  );
}

export default function ConnectedGraphWorkflowPanel({
  projectName,
  sessionName,
  selectedExecutionId,
  isMobile,
  mobilePanel,
  autoSwitchPanel,
  executionChipLabel,
  renderExecutionsSheet,
}: ConnectedGraphWorkflowPanelProps) {
  const executionQuery = useGraphWorkflowExecutionQuery(
    projectName,
    sessionName,
  );
  const currentExecution = executionQuery.data ?? null;
  const resolvedSelectionId =
    selectedExecutionId === undefined
      ? (currentExecution?.id ?? null)
      : selectedExecutionId;
  // Two different questions, deliberately kept apart. Identity says whose bytes
  // we already hold; TENURE says who may act. The active-execution endpoint goes
  // on answering with a run after it releases the lease, and the rail already
  // files that run under History — so reading authority off identity would leave
  // an aborted or non-resumably halted run with the mutable inspector, live
  // event stream and task editing of a live one.
  const selectedIsActiveRecord =
    resolvedSelectionId !== null &&
    resolvedSelectionId === currentExecution?.id;
  const selectedIsCurrent =
    selectedIsActiveRecord &&
    currentExecution !== null &&
    holdsExecutionLease(
      currentExecution.status,
      currentExecution.haltReason,
      currentExecution.abandonment,
    );
  const selectedExecutionQuery = useGraphWorkflowExecutionByIdQuery(
    projectName,
    sessionName,
    resolvedSelectionId,
    { enabled: resolvedSelectionId !== null && !selectedIsActiveRecord },
  );
  // Identity, not tenure, chooses the SOURCE: a demoted run is the same record
  // we already hold, so it needs no second fetch to be read.
  const execution = selectedIsActiveRecord
    ? currentExecution
    : (selectedExecutionQuery.data ?? null);
  const executionId = execution?.id ?? null;
  const isHistoricalSelection = executionId !== null && !selectedIsCurrent;
  // The saved template a live template-origin run was launched from. It answers
  // two questions the run cannot answer about itself: which revision the builder
  // draft has since reached, and — for a run predating launch documents — the
  // layout it was drawn with.
  //
  // History is self-contained. Passing null once tenure ends is deliberate: even
  // a template-origin run must never rejoin mutable definition storage after it
  // releases the session lease.
  const seedDefinitionId =
    selectedIsCurrent && execution?.origin.kind === "template"
      ? execution.seedDefinitionId
      : null;
  // `origin.tier` is the persisted record of which library the run was launched
  // from, and the two libraries are separate id spaces — a global template and a
  // project workflow may share an id. Reading the wrong tier does not merely
  // 404: it can answer with an unrelated definition and state a revision that
  // was never this run's draft.
  const seedDefinitionScope: WorkflowDefinitionScope =
    execution?.origin.kind === "template" && execution.origin.tier === "global"
      ? { kind: "global" }
      : { kind: "project", projectName };
  const seedDefinitionQuery = useScopedWorkflowDefinitionQuery(
    seedDefinitionScope,
    seedDefinitionId,
  );
  const pauseMutation = usePauseGraphWorkflowMutation(projectName, sessionName);
  const resumeMutation = useResumeGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  const abortMutation = useAbortGraphWorkflowMutation(projectName, sessionName);
  const abandonMutation = useAbandonGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  const approveDefinitionMutation = useApproveGraphWorkflowDefinitionMutation(
    projectName,
    sessionName,
  );
  const rejectDefinitionMutation = useRejectGraphWorkflowDefinitionMutation(
    projectName,
    sessionName,
  );
  const previousApprovalExecutionId = useRef(executionId);
  const resetDefinitionApprovalMutation = approveDefinitionMutation.reset;
  useEffect(() => {
    const previousExecutionId = previousApprovalExecutionId.current;
    if (previousExecutionId === executionId) return;

    previousApprovalExecutionId.current = executionId;
    resetDefinitionApprovalMutation();
    logger.info("session_workflow.definition_approval.identity_changed", {
      projectName,
      sessionName,
      previousExecutionId,
      executionId,
    });
  }, [executionId, projectName, resetDefinitionApprovalMutation, sessionName]);
  const runtimeEditMutation = useRuntimeEditGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  // A dedicated instance for config-tab saves so its pending/conflict/success
  // state drives the Config tab's affordances without being conflated with
  // task-edit runs on the same endpoint.
  const configEditMutation = useRuntimeEditGraphWorkflowMutation(
    projectName,
    sessionName,
  );
  // Same identity rule as the approval mutation above: a settled result
  // describes ONE execution's edit. The rail can move to another run of the
  // same plan, whose contexts carry the same ids, and a retained success or
  // refusal would then be attributed to a run that was never edited.
  const previousConfigEditExecutionId = useRef(executionId);
  const resetConfigEditMutation = configEditMutation.reset;
  useEffect(() => {
    const previousExecutionId = previousConfigEditExecutionId.current;
    if (previousExecutionId === executionId) return;

    previousConfigEditExecutionId.current = executionId;
    resetConfigEditMutation();
    logger.info("session_workflow.context_config_save.identity_changed", {
      projectName,
      sessionName,
      previousExecutionId,
      executionId,
    });
  }, [executionId, projectName, resetConfigEditMutation, sessionName]);
  const resetContextMutation = useResetExecutionContextMutation(
    projectName,
    sessionName,
  );
  const resetAssignmentMutation = useResetExecutionContextAssignmentMutation(
    projectName,
    sessionName,
  );

  // Live edits carry the concurrency guard (executionId + the current
  // liveRevision) read from the fetched execution; the mutation self-identifies
  // as source "ui" (doc 06, D15). Guard on a present execution — the task-edit
  // affordances only render once one exists.
  const handleAddTask = useCallback(
    (contextId: string, title: string, instructions: string) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [{ type: "add-task", contextId, title, instructions }],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleUpdateTask = useCallback(
    (taskId: string, updates: { title?: string; instructions?: string }) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [
          {
            type: "update-task",
            taskId,
            ...(updates.title ? { title: updates.title } : {}),
            ...(updates.instructions
              ? { instructions: updates.instructions }
              : {}),
          },
        ],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleRemoveTask = useCallback(
    (taskId: string) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [{ type: "remove-task", taskId }],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleMoveTask = useCallback(
    (taskId: string, targetContextId: string, targetOrder: number) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [
          {
            type: "move-task",
            taskId,
            targetContextId,
            // The server owns the numeric order; a relative position is the
            // live-edit contract (doc 06). Order 1 → start, else append.
            position: targetOrder <= 1 ? { at: "start" } : { at: "end" },
          },
        ],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleReorderTask = useCallback(
    (contextId: string, orderedTaskIds: string[]) => {
      if (!execution) return;
      runtimeEditMutation.mutate({
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations: [{ type: "reorder-tasks", contextId, orderedTaskIds }],
      });
    },
    [execution, runtimeEditMutation],
  );

  const handleSaveContextConfig = useCallback(
    (operations: WorkflowLiveEditOperation[]) => {
      if (!execution || operations.length === 0) return;
      const contextIds = operations.flatMap((operation) =>
        "contextId" in operation ? [operation.contextId] : [],
      );
      const input = {
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operations,
      };
      logger.info("session_workflow.context_config_save.requested", {
        projectName,
        sessionName,
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        operationCount: operations.length,
        contextIds,
      });
      configEditMutation.mutate(input, {
        onSuccess: () => {
          logger.info("session_workflow.context_config_save.completed", {
            projectName,
            sessionName,
            executionId: execution.id,
            baseLiveRevision: execution.liveRevision,
            operationCount: operations.length,
            contextIds,
          });
        },
        onError: (error) => {
          logger.warn("session_workflow.context_config_save.failed", {
            projectName,
            sessionName,
            executionId: execution.id,
            baseLiveRevision: execution.liveRevision,
            operationCount: operations.length,
            contextIds,
            error: error.message,
            errorCode: error instanceof ApiCallError ? error.code : undefined,
            status: error instanceof ApiCallError ? error.status : undefined,
            issueCount:
              error instanceof ApiCallError ? (error.issues?.length ?? 0) : 0,
          });
        },
      });
    },
    [configEditMutation, execution, projectName, sessionName],
  );

  const configEditConflict =
    configEditMutation.error instanceof ApiCallError &&
    configEditMutation.error.code === "revision_conflict";

  // The bounded, always-current read of the selection's log. It follows the
  // SELECTION, not the lease: the walk below is frozen at the moment it ran, so
  // the tail is the only window that can say the walk is still the whole log,
  // and dropping it when tenure ends would leave that question unanswerable for
  // exactly the run whose last rows are the ones at risk.
  const eventsQuery = useGraphWorkflowEventsQuery(
    projectName,
    sessionName,
    executionId,
  );
  // Whether this panel is watching the run write, which is what SSE refreshes
  // the tail for.
  const tailIsLive = selectedIsCurrent && executionId !== null;
  // Walked for every selection, not only historical ones: the History tab reads
  // conversations and validation rounds off this stream, and the tail above is
  // a bounded window — in a long run the conversation that opened the context,
  // and the aggregate of every older round, fall out of it. A round missing
  // from the evidence reads as a round that left no record, which is a
  // different and false claim.
  const eventPagesQuery = useGraphWorkflowEventPagesQuery(
    projectName,
    sessionName,
    executionId,
  );
  useEffect(() => {
    if (!eventPagesQuery.hasNextPage || eventPagesQuery.isFetchingNextPage) {
      return;
    }
    void eventPagesQuery.fetchNextPage();
  }, [
    eventPagesQuery.fetchNextPage,
    eventPagesQuery.hasNextPage,
    eventPagesQuery.isFetchingNextPage,
  ]);
  // The walk is complete but frozen at the moment it ran (SSE deliberately does
  // not invalidate it), and the tail is bounded but always current. Joined,
  // they are the whole log as of now — WHEN the walk has finished and the two
  // still touch.
  const walkedEvents = useMemo(
    () => orderGraphWorkflowEventPages(eventPagesQuery.data?.pages),
    [eventPagesQuery.data?.pages],
  );
  const tailEvents = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data]);
  // Pages alone are not a complete walk. `isFetching`, because a walk being
  // taken AGAIN — to close a gap, or because a reset has rewritten what it
  // holds — is holding rows the panel already knows are out of date. `isError`,
  // because a walk that FAILED leaves those same rows in the cache: reading
  // them after the read that would have corrected them fell over is how a
  // retired round comes back as a current one.
  const walkIsComplete =
    eventPagesQuery.data !== undefined &&
    !eventPagesQuery.hasNextPage &&
    !eventPagesQuery.isFetching &&
    !eventPagesQuery.isError;
  const events = useMemo(
    () => mergeGraphWorkflowEventWindows(walkedEvents, tailEvents),
    [walkedEvents, tailEvents],
  );
  const windowsMeet = useMemo(
    () => graphWorkflowEventWindowsMeet(walkedEvents, tailEvents),
    [walkedEvents, tailEvents],
  );
  // The tail is the only window that reads what the run appended after the walk
  // froze, so a walk finishing first — off a warm cache, or simply faster —
  // proves nothing on its own, and neither does an empty tail that is empty
  // because the request has not landed or has failed.
  const tailIsRead =
    eventsQuery.data !== undefined &&
    !eventsQuery.isError &&
    !eventsQuery.isFetching;
  // The reset's own evidence, and the earliest of it: the tail is re-read on the
  // SSE that follows and returns rows the walk holds as live already retired.
  // Rows too old for the tail were retired in the same sweep and live in the
  // walk alone, so a disagreement anywhere condemns the whole walk — and it
  // arrives without waiting for the execution record to be read again.
  const walkMissedRetirement = useMemo(
    () => graphWorkflowWalkMissedRetirement(walkedEvents, tailEvents),
    [walkedEvents, tailEvents],
  );
  // Whether a reset could be rewriting THIS run's rows at all.
  //
  // Two conditions, and the run's status is only one of them. A reset is
  // refused for any execution that is not the session's active record — the
  // endpoint answers 409 rather than resetting a run it was not handed — so a
  // historical selection, read by id, can never be reset however it is halted.
  //
  // This decides one thing only: whether the record's READ STATE is worth
  // waiting on. It says nothing about the walk. The reset that poisons a cached
  // walk ran in the past, and a run that has since resumed or finished is no
  // safer for having stopped being resettable — so where the record has been
  // since the walk was read is asked of the two records themselves, in
  // `graphWorkflowWalkIsVouched`, and never of the status standing now.
  const resetIsAdmissible =
    selectedIsActiveRecord &&
    execution !== null &&
    (execution.status === "paused" || execution.status === "halted");
  // The query that actually SUPPLIES the record on screen — the same choice
  // `execution` is made by, so the panel can never hold one query's record and
  // ask another whether it is current.
  const recordQuery = selectedIsActiveRecord
    ? executionQuery
    : selectedExecutionQuery;
  // While a reset is admissible, the walk and the RECORD have to be one reading.
  //
  // The disagreement above is the reset's own evidence, but it needs an
  // overlapping row to be evidence of anything, and a context quiet for longer
  // than the tail window leaves none: its retired rows sit in the walk alone.
  // The reset reaches this panel through the record instead — and the SSE that
  // carries it invalidates the record and the tail together, so the tail can
  // land first and leave the walk looking whole while the read that would
  // condemn it is still in flight. A record being re-read is therefore a record
  // this panel knows it may be behind on, and the log is not described until it
  // lands. The same for a read that FAILED: the panel then holds a record it
  // knows is unverified, and a retired round would otherwise stand in the list
  // for as long as the failure persists.
  const recordIsRead = !recordQuery.isError && !recordQuery.isFetching;
  // Which record the walk in hand was taken against.
  //
  // Remembered PER EXECUTION, because that is what the walk is cached under and
  // this panel outlives any one selection. A single slot would be rewritten on
  // the way to another run and then, on the way back, find a read stamp it did
  // not recognise and attribute the cached pre-reset walk to whatever record is
  // on screen by then — blessing exactly the walk a reset had invalidated while
  // the reader was away.
  //
  // The map does NOT outlive the panel, and deliberately so: only a read this
  // mount watched land tells it anything, and a walk cached before it existed
  // is one it watched nothing of. The cache long predates any one mount, and
  // other observers of the execution record go on refreshing that record while
  // this panel is closed — so the walk waiting for a remount may have been read
  // on either side of a reset, and an empty map on mount is the truth rather
  // than a gap. It reads as unproven, which withholds the walk and re-reads it,
  // and the re-read is what this mount can actually vouch for.
  //
  // Read during RENDER rather than in an effect. A reset moves the record first
  // and the walk only once this panel re-reads it, and an effect runs AFTER the
  // render that used the walk has been committed — so a record landing would
  // paint one frame of the retired round as current before the re-walk it
  // triggers had even started.
  // Held as state rather than a ref because it is read while rendering, and a
  // ref read during render is exactly the value React cannot promise is current.
  // The page count travels with the stamp because finishing a walk moves the
  // stamp too: `fetchNextPage` appends the next older page and leaves every
  // page already held untouched. Only the count tells that append apart from a
  // re-read of the whole walk.
  const walkReadAt = eventPagesQuery.dataUpdatedAt;
  const walkPageCount = eventPagesQuery.data?.pages.length ?? 0;
  const [walkProvenance, setWalkProvenance] = useState<
    ReadonlyMap<
      string,
      GraphWorkflowWalkProvenance<GraphWorkflowExecution | null>
    >
  >(() => new Map());
  const remembered =
    executionId === null ? undefined : walkProvenance.get(executionId);
  const provenance = graphWorkflowWalkProvenance(remembered, {
    readAt: walkReadAt,
    pageCount: walkPageCount,
    record: execution,
  });
  // Only when the attribution actually changed, so this settles on the next
  // render instead of queueing an update every time the panel draws.
  if (executionId !== null && provenance !== remembered) {
    const next = new Map(walkProvenance);
    next.set(executionId, provenance);
    setWalkProvenance(next);
  }
  // React Query keeps the same record object where a re-read changed nothing,
  // so an unmoved record is recognised by identity: a refresh that returned the
  // same bytes is not a reset. Where it HAS moved, the two records are compared
  // for the excursion a reset needs — see `graphWorkflowRecordMoveAdmitsReset`.
  const walkIsVouched = graphWorkflowWalkIsVouched(provenance, execution);
  const walkNeedsReread = graphWorkflowWalkNeedsReread(
    provenance,
    execution,
    walkIsComplete,
  );
  const eventsAreComplete = graphWorkflowLogIsWhole({
    walkIsComplete,
    tailIsRead,
    windowsMeet,
    walkMissedRetirement,
    walkIsVouched,
    resetIsAdmissible,
    recordIsRead,
  });
  // A run that appends more rows than the tail holds while the frozen walk sits
  // there leaves a span of the log in neither window. Only a fresh walk can
  // recover it, so the gap re-walks itself — once per gap, keyed on the tail row
  // that opened it, rather than every render for as long as it stands.
  const tailStartedAt = tailEvents[0]?.occurredAt ?? null;
  // Carries the execution, so selecting a different run never reads as a gap
  // this panel has already walked.
  const gapKey =
    walkIsComplete && !windowsMeet && tailStartedAt !== null
      ? `${executionId ?? ""} ${tailStartedAt}`
      : null;
  const rewalkedGap = useRef<string | null>(null);
  const refetchEventPages = eventPagesQuery.refetch;
  useEffect(() => {
    if (gapKey === null || rewalkedGap.current === gapKey) return;
    rewalkedGap.current = gapKey;
    logger.info("session_workflow.event_window.gap_rewalk", {
      projectName,
      sessionName,
      executionId,
      tailStartedAt,
    });
    void refetchEventPages();
  }, [
    executionId,
    gapKey,
    projectName,
    refetchEventPages,
    sessionName,
    tailStartedAt,
  ]);
  // The walk the tail has just contradicted, taken again. Keyed on the TAIL's
  // read rather than on the walk's: a fresh walk that somehow still disagrees
  // waits for the next tail before asking again, so the two reads can never
  // chase each other.
  const rewalkedRetirement = useRef<number | null>(null);
  const tailUpdatedAt = eventsQuery.dataUpdatedAt;
  useEffect(() => {
    if (!walkMissedRetirement || !walkIsComplete) return;
    if (rewalkedRetirement.current === tailUpdatedAt) return;
    rewalkedRetirement.current = tailUpdatedAt;
    logger.info("session_workflow.event_window.retired_row_rewalk", {
      projectName,
      sessionName,
      executionId,
    });
    void refetchEventPages();
  }, [
    executionId,
    projectName,
    refetchEventPages,
    sessionName,
    tailUpdatedAt,
    walkIsComplete,
    walkMissedRetirement,
  ]);
  // A context reset is the one operation that rewrites rows already written: it
  // retires EVERY row its context ever wrote, however far back. SSE refreshes
  // the bounded tail, and the merge takes the tail's fresher copy where the two
  // windows overlap — but a retired row older than the tail is in the walk
  // alone, and the walk is deliberately never invalidated. Left there it says
  // `preReset: false` forever, and the round it carries would be listed as part
  // of an attempt that has already ended.
  //
  // The disagreement above catches this whenever the reset reached a row the
  // tail still holds. It cannot when the reset context has been quiet for
  // longer than the tail window — no shared row, nothing to disagree about — so
  // the record is watched as well.
  //
  // A reset cannot happen without moving the execution record — it rebuilds the
  // context state, the task states and the lane bindings. So a record move is
  // the moment the walk may have been rewritten underneath, and the walk is
  // taken again. Nothing about attempt MEMBERSHIP is decided from this: the
  // placement stays the server's `preReset` mark, read fresh. A false positive
  // costs one walk; there is no false negative.
  //
  // Which moves count is decided from the two records rather than from the
  // status standing now, because the reset being looked for happened BETWEEN
  // them: another client can pause, reset and resume while this one's record
  // read is in flight, and both ends then read "running". A move through a park
  // is on the record either way — the status changed, or the loop generation
  // did — while an ordinary live update moves neither, which is what keeps a
  // running execution from re-walking its whole log every few seconds.
  //
  // The INHERITED walk is the other half, and it is asked of every run whatever
  // its status: the reset that poisons a cached walk ran in the PAST and its
  // retirements are permanent, so a run that has since been resumed, or has
  // finished and become historical, is no safer to trust — it has merely
  // stopped being resettable.
  //
  // The withholding above is what keeps the stale walk off the screen; this is
  // what replaces it. It covers the walk a MOUNT inherited as well as the one a
  // reset overtook: neither is a walk this panel can vouch for, and the answer
  // to both is the same read. The re-walk moves the walk's read stamp, which
  // re-derives the provenance against the record standing then — so this fires
  // once per record move rather than once per render for as long as it stands.
  //
  // The panel can never re-read a walk it is still showing: everything this
  // fires on is withheld above. The converse is deliberately not true — a walk
  // still ARRIVING is withheld without being re-read, because the read that
  // will attribute it is already in flight.
  useEffect(() => {
    if (!walkNeedsReread) return;
    logger.info("session_workflow.event_window.retirement_rewalk", {
      projectName,
      sessionName,
      executionId,
    });
    void refetchEventPages();
  }, [
    executionId,
    projectName,
    refetchEventPages,
    sessionName,
    walkNeedsReread,
  ]);
  // The rows a run writes as it finishes — its closing verdict, its settlement
  // — land in the same moment it releases the lease, and the SSE refresh that
  // would have read them races that release. So the end of tenure is itself a
  // reason to read: the tail is taken once more, and until it lands the log is
  // not described. A selection this panel never watched live needs no such read
  // — nothing has been appended to it since before the walk began.
  const watchedLive = useRef<string | null>(null);
  const refetchTail = eventsQuery.refetch;
  useEffect(() => {
    if (executionId === null) return;
    if (tailIsLive) {
      watchedLive.current = executionId;
      return;
    }
    if (watchedLive.current !== executionId) return;
    watchedLive.current = null;
    logger.info("session_workflow.event_window.tenure_reread", {
      projectName,
      sessionName,
      executionId,
    });
    void refetchTail();
  }, [executionId, projectName, refetchTail, sessionName, tailIsLive]);
  const resultQuery = useGraphWorkflowLatestExecutionResultQuery(
    projectName,
    sessionName,
    executionId,
    { enabled: isHistoricalSelection },
  );
  const handleResetContext = useCallback(
    (contextId: string) => {
      if (!executionId) return;
      resetContextMutation.mutate({ executionId, contextId });
    },
    [executionId, resetContextMutation],
  );
  const handleResetAssignment = useCallback(
    (contextId: string, assignmentId: string) => {
      if (!executionId) return;
      resetAssignmentMutation.mutate({ executionId, contextId, assignmentId });
    },
    [executionId, resetAssignmentMutation],
  );
  // Execution-addressed: gating on a seed definition id would dead-end the
  // button for a one-off park, which has none (D7 R14.2).
  const handleApproveDefinition = useCallback(() => {
    if (!executionId) return;

    logger.info("session_workflow.definition_approval.requested", {
      projectName,
      sessionName,
      executionId,
    });
    approveDefinitionMutation.mutate(
      { executionId },
      {
        onSuccess: () => {
          logger.info("session_workflow.definition_approval.completed", {
            projectName,
            sessionName,
            executionId,
          });
        },
        onError: (error) => {
          logger.warn("session_workflow.definition_approval.failed", {
            projectName,
            sessionName,
            executionId,
            error: error.message,
          });
        },
      },
    );
  }, [approveDefinitionMutation, executionId, projectName, sessionName]);

  const pendingAction: ExecutionControlAction | null = pauseMutation.isPending
    ? "pause"
    : resumeMutation.isPending
      ? "resume"
      : abortMutation.isPending
        ? "abort"
        : abandonMutation.isPending
          ? "abandon"
          : null;

  const contextApprovals = useMemo(() => {
    // `selectedIsCurrent` already carries the lease question, so asking it again
    // here would give the tenure decision a second owner that could drift.
    if (!selectedIsCurrent || execution === null) return [];
    const approvals: CurrentContextApproval[] = [];
    for (const state of Object.values(execution.contextStates)) {
      if (
        state.status !== "awaiting_approval" ||
        state.pendingApproval === null ||
        state.pendingApproval.decision !== null
      ) {
        continue;
      }
      const context = execution.workingDefinition.executionContexts.find(
        (candidate) => candidate.id === state.contextId,
      );
      approvals.push({
        contextId: state.contextId,
        contextTitle: context?.title ?? null,
        requestedAt: state.pendingApproval.requestedAt,
      });
    }
    return approvals;
  }, [execution, selectedIsCurrent]);

  const handlePause = useCallback(() => {
    pauseMutation.mutate(undefined, {
      onError: (error) => {
        const transitionConflict =
          error instanceof ApiCallError &&
          error.code === "workflow_transition_conflict";
        const fields = {
          projectName,
          sessionName,
          executionId,
          error: error.message,
          currentStatus:
            error instanceof ApiCallError
              ? error.details?.currentStatus
              : undefined,
        };
        if (transitionConflict) {
          logger.info("session_workflow.pause.transition_rejected", fields);
        } else {
          logger.warn("session_workflow.pause.failed", fields);
        }
        pushToast(pauseFailureMessage(error));
      },
    });
  }, [executionId, pauseMutation, projectName, sessionName]);

  return (
    <GraphWorkflowPanel
      projectName={projectName}
      sessionName={sessionName}
      execution={execution}
      events={events}
      eventsAreComplete={eventsAreComplete}
      layout={
        execution?.launchDocument?.layout ??
        seedDefinitionQuery.data?.item.layout ??
        null
      }
      actionCapability={selectedIsCurrent ? "current" : "read-only"}
      result={resultQuery.data ?? null}
      draftRevision={seedDefinitionQuery.data?.item.revision ?? null}
      onPause={handlePause}
      onResume={(conflictGuidance) =>
        resumeMutation.mutate(
          conflictGuidance && conflictGuidance.length > 0
            ? { conflictGuidance }
            : undefined,
        )
      }
      onAbort={() => abortMutation.mutate()}
      onAbandon={() => {
        if (executionId === null) return;
        abandonMutation.mutate({
          executionId,
          reason:
            "Operator abandoned the resumably halted execution from Current detail.",
        });
      }}
      onApproveDefinition={handleApproveDefinition}
      onRejectDefinition={() => {
        if (executionId === null) return;
        rejectDefinitionMutation.mutate({ executionId });
      }}
      onAddTask={handleAddTask}
      onUpdateTask={handleUpdateTask}
      onRemoveTask={handleRemoveTask}
      onMoveTask={handleMoveTask}
      onReorderTask={handleReorderTask}
      onResetContext={handleResetContext}
      onResetAssignment={handleResetAssignment}
      resettingAssignmentId={
        resetAssignmentMutation.isPending
          ? (resetAssignmentMutation.variables?.assignmentId ?? null)
          : null
      }
      onSaveContextConfig={handleSaveContextConfig}
      isSavingConfig={configEditMutation.isPending}
      isPausingExecution={pauseMutation.isPending}
      isResumingExecution={resumeMutation.isPending}
      isApprovingDefinition={approveDefinitionMutation.isPending}
      isRejectingDefinition={rejectDefinitionMutation.isPending}
      definitionApprovalError={definitionApprovalErrorMessage(
        approveDefinitionMutation.error ?? rejectDefinitionMutation.error,
      )}
      configEditConflict={configEditConflict}
      configEditError={configEditErrorMessage(configEditMutation.error)}
      configSaveSucceeded={configEditMutation.isSuccess}
      isMutating={
        pauseMutation.isPending ||
        resumeMutation.isPending ||
        abortMutation.isPending ||
        approveDefinitionMutation.isPending ||
        rejectDefinitionMutation.isPending ||
        abandonMutation.isPending ||
        runtimeEditMutation.isPending ||
        configEditMutation.isPending ||
        resetContextMutation.isPending ||
        resetAssignmentMutation.isPending
      }
      pendingAction={pendingAction}
      isMobile={isMobile}
      mobilePanel={mobilePanel}
      autoSwitchPanel={autoSwitchPanel}
      {...(executionChipLabel === undefined ? {} : { executionChipLabel })}
      {...(renderExecutionsSheet === undefined
        ? {}
        : { renderExecutionsSheet })}
      renderContextApproval={(contextId) => {
        // One context, one card. Handing the panel every parked approval at
        // once rebuilt the single global gate surface README §10 removes: a run
        // with two gates showed both decisions stacked above the canvas, and
        // opening one gate row changed nothing about what was on screen.
        const approval = contextApprovals.find(
          (candidate) => candidate.contextId === contextId,
        );
        if (approval === undefined || execution === null) return null;
        return (
          <CurrentContextApprovalPanel
            key={`${approval.contextId}:${approval.requestedAt}`}
            projectName={projectName}
            sessionName={sessionName}
            execution={execution}
            approval={approval}
          />
        );
      }}
    />
  );
}
