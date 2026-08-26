"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ContextHaltCard from "@/components/workflow-graph/ContextHaltCard";
import { deriveOutputSchemaHaltEvidenceByContext } from "@/components/workflow-graph/derive-output-schema-halt";
import { derivePlanRepairActivity } from "@/components/workflow-graph/derive-plan-repair-activity";
import {
  deriveContextLoopDisplay,
  deriveContextProvenanceDisplay,
  deriveContextRouteRows,
  deriveContextSkipDisplay,
} from "@/components/workflow-graph/derive-graph";
import { resolveUpstreamInputs } from "@/lib/workflow-graph/context-outputs";
import { acceptanceCriteriaText } from "@/lib/workflow-graph/criteria/criterion-records";
import type { WorkflowAdvisoryIdentity } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import CapturedOutputSection, {
  resolveCapturedOutputView,
} from "../CapturedOutputSection";
import LiveContextConfigPanel from "../live-config/LiveContextConfigPanel";
import BriefFocusSheet from "../BriefFocusSheet";
import BriefSection, { type BriefField } from "./BriefSection";
import ContextHeader from "./ContextHeader";
import ContextTabs from "./ContextTabs";
import LoopSection from "./LoopSection";
import ProvenanceSection from "./ProvenanceSection";
import RoutingSection from "./RoutingSection";
import TasksSection from "./TasksSection";
import { deriveContextHeader } from "./context-header-model";
import { getHistoryEntries } from "./history-entries";
import { ResolvedSetupStrip } from "./ResolvedSetup";
import {
  assignmentTranscriptLabel,
  cohortAssignmentsFor,
  computeReusedSessions,
  type ViewConversation,
} from "./ValidationRounds";
import ConversationHistoryList, {
  type OpenTranscript,
} from "./ConversationHistoryList";
import ValidationRoundsCard from "./ValidationRoundsCard";
import {
  contextIterationReader,
  deriveConversationHistory,
} from "./conversation-history";
import { deriveValidationRoundRows } from "./validation-rounds-model";
import {
  OUTPUT_SCHEMA_REPAIR,
  resolveNavigationRequest,
  type InspectorDestination,
  type InspectorNavigationRequest,
  type InspectorTab,
} from "./navigation";
import { GroupHeader, InspectorRail, inspectorSectionClass } from "./chrome";

/**
 * The inspector with a context selected (design E1): the context header, the
 * Tasks · Config · History tab shell, and the surfaces each tab hosts.
 *
 * Everything visible here is owned by a focused module — the header, the tab
 * shell, each Tasks-tab section, the validation rounds. This assembles them and
 * holds only what spans them: which tab is open, the deep link being honoured,
 * and the dialog the header opens. Context reset is NOT here: README section 11
 * lands it in the Config tab's danger footer, which the config panel owns.
 */

const wbOverviewSection = inspectorSectionClass;
const wbOverviewStatGrid = "grid grid-cols-2 gap-sm mb-lg";
const wbOverviewStat = "bg-bg-raised border border-border-dim rounded-md p-3";
const wbOverviewStatValue =
  "text-[1.4rem] font-bold text-text-primary leading-none mb-1";
const wbOverviewStatLabel =
  "text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

function findContextHaltReason(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowHaltReason | null {
  const all = [execution.haltReason, ...execution.secondaryHaltReasons].filter(
    (r): r is GraphWorkflowHaltReason => r != null,
  );
  for (const reason of all) {
    if ("contextId" in reason && reason.contextId === contextId) {
      return reason;
    }
  }
  return null;
}

type DetailTab = InspectorTab;

function getContextTasks(execution: GraphWorkflowExecution, contextId: string) {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order);
}

export default function ContextDetail({
  execution,
  events,
  eventsAreComplete = true,
  contextId,
  userInputPanels,
  contextApprovalPanel,
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
  contextTabRequest,
  commandOptions,
  readOnly = false,
}: {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  /**
   * Whether `events` is the execution's whole log rather than a part of it.
   *
   * The History tab reads absence as evidence — a round nothing named did not
   * run, a conversation nothing mentions was never worked in — which only holds
   * over a complete stream. A caller reading the log through bounded windows
   * says so, and the tab waits rather than describing what it half sees.
   */
  eventsAreComplete?: boolean;
  contextId: string;
  userInputPanels?: ReactNode;
  /** This context's own parked approval decision, when it holds one. */
  contextApprovalPanel?: ReactNode;
  onDeselectContext: () => void;
  onAddTask: (contextId: string, title: string, instructions: string) => void;
  onUpdateTask: (
    taskId: string,
    updates: { title?: string; instructions?: string },
  ) => void;
  onRemoveTask: (taskId: string) => void;
  onReorderTask: (contextId: string, orderedTaskIds: string[]) => void;
  onResetContext?: (contextId: string) => void;
  onResetAssignment?: (contextId: string, assignmentId: string) => void;
  resettingAssignmentId?: string | null;
  libraryProjectName?: string | null;
  onViewTask: (taskId: string) => void;
  viewingTaskId: string | null;
  isMutating: boolean;
  onSaveContextConfig?: (operations: WorkflowLiveEditOperation[]) => void;
  onPauseExecution?: () => void;
  onResumeExecution?: () => void;
  isSavingConfig?: boolean;
  isPausingExecution?: boolean;
  isResumingExecution?: boolean;
  configEditConflict?: boolean;
  configEditError?: string | null;
  configSaveSucceeded?: boolean;
  onViewConversation?: ViewConversation;
  contextTabRequest?: InspectorNavigationRequest | null;
  commandOptions?: readonly ValidationCommandSummary[];
  readOnly?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<DetailTab>("tasks");
  // Honour a host's deep link exactly once per request, adjusting state during
  // render rather than in an effect so the requested tab is the first thing
  // painted. Keyed on `seq`, so a re-render never re-steals the tab from an
  // operator who has since switched away, while a repeat request still lands.
  const [honouredTabRequestSeq, setHonouredTabRequestSeq] = useState<
    number | null
  >(null);
  // The advisory a honoured request aimed at, held as a fresh object per request
  // so that asking twice for the same one scrolls back to it rather than
  // reading as unchanged state.
  const [focusedAdvisory, setFocusedAdvisory] =
    useState<WorkflowAdvisoryIdentity | null>(null);
  // The screen inside the Config tab a request aimed at, held as a fresh array
  // per request for the same reason as the round below.
  const [configScreen, setConfigScreen] = useState<readonly string[] | null>(
    null,
  );
  // One way to reach a destination, whether the request came from outside the
  // inspector or from a card inside this very context: a tab alone is not the
  // destination, and a caller that sets only the tab silently loses the screen.
  const openDestination = (destination: InspectorDestination) => {
    setActiveTab(destination.tab);
    setConfigScreen(
      destination.screen === undefined ? null : [...destination.screen],
    );
    setFocusedAdvisory(
      destination.advisory === undefined ? null : { ...destination.advisory },
    );
  };
  const destination = resolveNavigationRequest(
    contextTabRequest ?? null,
    contextId,
    honouredTabRequestSeq,
  );
  if (destination !== null && contextTabRequest != null) {
    setHonouredTabRequestSeq(contextTabRequest.seq);
    openDestination(destination);
  }
  const [sheetField, setSheetField] = useState<BriefField | null>(null);

  const context = execution.workingDefinition.executionContexts.find(
    (ctx) => ctx.id === contextId,
  );
  const contextState = execution.contextStates[contextId];
  const tasks = useMemo(
    () => getContextTasks(execution, contextId),
    [execution, contextId],
  );
  const history = useMemo(
    () => getHistoryEntries(events, contextId),
    [events, contextId],
  );
  const contextHaltReason = useMemo(
    () => findContextHaltReason(execution, contextId),
    [execution, contextId],
  );
  const capturedOutputView = useMemo(
    () =>
      resolveCapturedOutputView(execution, contextId, history.validationEvents),
    [execution, contextId, history.validationEvents],
  );
  const upstreamInputs = useMemo(
    () => resolveUpstreamInputs(execution, contextId),
    [execution, contextId],
  );
  const outputSchemaHaltEvidence = useMemo(
    () =>
      deriveOutputSchemaHaltEvidenceByContext({
        execution,
        haltReasons: [contextHaltReason],
        validationEvents: history.validationEvents,
      }),
    [execution, contextHaltReason, history.validationEvents],
  );
  // Scoped to THIS context: the run-level activity names the context its round
  // is filed against, and a repair working some other halt is not this
  // context's answer.
  const planRepairActivity = useMemo(() => {
    const activity = derivePlanRepairActivity(execution);
    return activity.rounds.some((round) => round.contextId === contextId)
      ? activity
      : null;
  }, [execution, contextId]);
  // The cohort as configured NOW: the engine reads a seat's authority the same
  // way, so a live authority edit moves every badge on this tab with it — the
  // live round's rows and the rows of every round already in the history.
  const cohortAssignments = useMemo(
    () => cohortAssignmentsFor(execution, contextId),
    [execution, contextId],
  );
  const routeRows = useMemo(
    () => deriveContextRouteRows(execution, contextId),
    [execution, contextId],
  );
  const skipDisplay = useMemo(
    () => deriveContextSkipDisplay(execution, contextId),
    [execution, contextId],
  );
  const loopDisplay = useMemo(
    () =>
      deriveContextLoopDisplay(
        execution.workingDefinition,
        execution,
        contextId,
      ),
    [execution, contextId],
  );
  const provenanceDisplay = useMemo(
    () => deriveContextProvenanceDisplay(execution, contextId),
    [execution, contextId],
  );
  // The context's history as conversations, and the rounds card beneath them.
  // Both read the same iteration timeline, so a round and the conversation that
  // hosted it can never name different iterations.
  const conversationHistory = useMemo(
    () => deriveConversationHistory({ execution, events, contextId }),
    [execution, events, contextId],
  );
  const roundRows = useMemo(
    () =>
      deriveValidationRoundRows({
        execution,
        contextId,
        validationEvents: history.validationEvents,
        // A concluded aggregate names only the lanes that reported, so the
        // seats a round lost are recovered from its incidents.
        incidentEvents: history.incidentEvents,
        iteration: contextIterationReader(
          events,
          contextId,
          execution.contextStates[contextId]?.iterationCount ?? 1,
        ),
      }),
    [execution, events, contextId, history],
  );
  // A result that belongs to no round keeps its card rather than disappearing
  // with the round list it was never part of.
  const unroundedRecords = useMemo(
    () =>
      history.validationEvents.filter(
        (event) => event.roundSeq === null || event.roundSeq === undefined,
      ),
    [history.validationEvents],
  );
  const reusedRecords = useMemo(() => {
    const indices = computeReusedSessions(history.validationEvents);
    return new Set(
      history.validationEvents.filter((_, index) => indices.has(index)),
    );
  }, [history.validationEvents]);

  const focusedRoundAnchorId = useId();
  const landedOn = useRef<object | null>(null);
  // Deliberately unkeyed: the anchor belongs to a surface that may not have
  // rendered when the request is honoured — the History evidence can still be
  // loading — so landing is RETRIED on later renders rather than abandoned the
  // first time the anchor is missing. `focusedAdvisory` is a fresh object per
  // request, so this lands once per link and asking again lands again.
  useEffect(() => {
    if (focusedAdvisory === null || landedOn.current === focusedAdvisory)
      return;
    const target = document.getElementById(focusedRoundAnchorId);
    if (target === null) return;
    landedOn.current = focusedAdvisory;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  });

  // A conversation row opens the implementer transcript; a verdict opens the
  // seat's own. Both go through the host's one Log handle, which is why the
  // rail names the owner rather than a lane the caller had to spell.
  const openTranscript: OpenTranscript | undefined =
    onViewConversation === undefined
      ? undefined
      : (conversationId, owner) =>
          onViewConversation(
            conversationId,
            owner.kind === "validator" ? "context_validator" : "implementer",
            contextId,
            owner.kind === "validator"
              ? assignmentTranscriptLabel(owner.seat)
              : undefined,
          );

  const headerView = useMemo(
    () => deriveContextHeader(execution, contextId),
    [execution, contextId],
  );

  if (!context || headerView === null) return null;

  const completedCount = contextState?.completedTaskCount ?? 0;
  const totalCount = contextState?.totalTaskCount ?? tasks.length;
  const iterationCount = contextState?.iterationCount ?? 0;

  const canAddTasks =
    !readOnly &&
    contextState?.status !== "completed" &&
    context.mutability?.allowAgentTaskAdd;

  return (
    <InspectorRail>
      <ContextHeader view={headerView} onBack={onDeselectContext} />

      <ResolvedSetupStrip context={context} />

      <ContextTabs
        activeTab={activeTab}
        onTabChange={setActiveTab}
        above={
          <>
            {contextApprovalPanel && (
              <section className={wbOverviewSection}>
                {contextApprovalPanel}
              </section>
            )}
            {userInputPanels && (
              // No group header: each parked-question card names its own lane
              // and batch, so a "Questions" label above them only repeats what
              // every card already says.
              <section className={wbOverviewSection}>{userInputPanels}</section>
            )}
            {contextHaltReason && (
              <ContextHaltCard
                primary={contextHaltReason}
                outputSchemaEvidence={outputSchemaHaltEvidence}
                planRepairActivity={planRepairActivity}
                // Already inside the refusing context, so selection is settled
                // and only the destination is left to honour — the same typed
                // one the canvas and the status dialog send, which lands on the
                // contract that refused the run rather than on the tab holding
                // it.
                {...(!readOnly
                  ? {
                      onEditSchema: () => openDestination(OUTPUT_SCHEMA_REPAIR),
                    }
                  : {})}
              />
            )}

            <div className={wbOverviewStatGrid}>
              <div className={wbOverviewStat}>
                <div className={wbOverviewStatValue}>
                  {completedCount}/{totalCount}
                </div>
                <div className={wbOverviewStatLabel}>Tasks</div>
              </div>
              <div className={wbOverviewStat}>
                <div className={wbOverviewStatValue}>{iterationCount}</div>
                <div className={wbOverviewStatLabel}>Iterations</div>
              </div>
            </div>
          </>
        }
        tasks={
          <>
            <BriefSection
              description={context.description}
              acceptanceCriteria={context.acceptanceCriteria}
              upstreamInputs={upstreamInputs}
              onOpenField={setSheetField}
            />

            <RoutingSection routes={routeRows} skip={skipDisplay} />
            <LoopSection loop={loopDisplay} />
            <ProvenanceSection provenance={provenanceDisplay} />

            <CapturedOutputSection view={capturedOutputView} />

            <TasksSection
              execution={execution}
              contextId={contextId}
              tasks={tasks}
              completedCount={completedCount}
              totalCount={totalCount}
              canAddTasks={canAddTasks}
              readOnly={readOnly}
              isMutating={isMutating}
              viewingTaskId={viewingTaskId}
              onViewTask={onViewTask}
              onAddTask={onAddTask}
              onUpdateTask={onUpdateTask}
              onRemoveTask={onRemoveTask}
              onReorderTask={onReorderTask}
            />
          </>
        }
        config={
          // One surface for both tenures. A history selection carries no live
          // mutation handles, and the panel's own affordance classifier is what
          // states why — so the reader gets the same configuration, read-only,
          // with the reason named rather than a raw dump of the stored document.
          <LiveContextConfigPanel
            // Both halves of the selection: the same context id appears in
            // every run of a plan, and the inspector keeps its selection when
            // the execution rail moves — so a contextId-only key would hand one
            // run's unsaved draft to another run's snapshot.
            key={`${execution.id}/${contextId}`}
            execution={execution}
            contextId={contextId}
            libraryProjectName={libraryProjectName}
            commandOptions={commandOptions}
            {...(readOnly
              ? {}
              : {
                  onSaveContextConfig,
                  onPauseExecution,
                  onResumeExecution,
                  ...(onResetAssignment ? { onResetAssignment } : {}),
                  resettingAssignmentId,
                  ...(onResetContext ? { onResetContext } : {}),
                  isMutating,
                  isSaving: isSavingConfig,
                  isPausing: isPausingExecution,
                  isResuming: isResumingExecution,
                  editConflict: configEditConflict,
                  editError: configEditError,
                  saveSucceeded: configSaveSucceeded,
                })}
            {...(configScreen === null ? {} : { focusScreen: configScreen })}
          />
        }
        history={
          !eventsAreComplete ? (
            // Nothing partial is drawn. Every line of this tab is a statement
            // about the whole log — which rounds ran, which conversations the
            // context worked in — and a half-read log answers all of them
            // wrongly rather than incompletely.
            <section className={wbOverviewSection}>
              <GroupHeader label="History" />
              <p
                data-testid="history-evidence-pending"
                className="m-0 font-mono text-[0.72rem] text-text-tertiary"
              >
                Reading the execution log...
              </p>
            </section>
          ) : (
            <>
              <section className={wbOverviewSection}>
                <GroupHeader
                  label="Conversations"
                  meta={`${conversationHistory.rows.length} ${
                    conversationHistory.rows.length === 1
                      ? "conversation"
                      : "conversations"
                  } · every transcript kept`}
                />
                <ConversationHistoryList
                  rows={conversationHistory.rows}
                  {...(openTranscript === undefined
                    ? {}
                    : { onOpenTranscript: openTranscript })}
                />
              </section>
              <ValidationRoundsCard
                rows={roundRows}
                contextId={contextId}
                cohortAssignments={cohortAssignments}
                incidents={history.incidentEvents}
                advisoryResponse={contextState?.advisoryResponse ?? null}
                reusedRecords={reusedRecords}
                unroundedRecords={unroundedRecords}
                focusedAdvisory={focusedAdvisory}
                focusAnchorId={focusedRoundAnchorId}
                onViewConversation={onViewConversation}
              />
            </>
          )
        }
      />
      <BriefFocusSheet
        open={sheetField !== null}
        onOpenChange={(open) => {
          if (!open) setSheetField(null);
        }}
        fieldLabel={
          sheetField === "acceptanceCriteria"
            ? "Acceptance criteria"
            : "Description"
        }
        contextTitle={context.title}
        content={
          sheetField === "acceptanceCriteria"
            ? acceptanceCriteriaText(context.acceptanceCriteria)
            : (context.description ?? "")
        }
      />
    </InspectorRail>
  );
}
