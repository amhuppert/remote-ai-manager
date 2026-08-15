"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  MultilineInput,
  runMultilinePrimaryAction,
  type MultilineInputActionHandle,
} from "@/components/MultilineInput";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from "@/components/ui/Tabs";
import { SectionLabel } from "@/components/ui/SectionHeader";
import { StatusChip } from "@/components/ui/StatusChip";
import {
  ApprovalGlyphIcon,
  BackendChip,
  ExpandGlyphIcon,
  GateChip,
  QuestionGlyphIcon,
  ScriptGlyphIcon,
  implementerChipLabel,
  validatorChipLabel,
} from "@/components/workflow-config/InspectorChips";
import { cn } from "@/lib/ui/cn";

const wbBtn =
  "inline-flex items-center justify-center gap-[6px] font-medium rounded-sm cursor-pointer transition-all duration-150 border border-border-default whitespace-nowrap";
const wbBtnXs = "text-[0.7rem] py-[3px] px-[8px] h-[22px]";
const wbBtnSm = "text-[0.72rem] py-[5px] px-[12px] h-[28px]";
const wbBtnDefault =
  "bg-bg-raised text-text-secondary hover:bg-bg-elevated hover:text-text-primary hover:border-border-strong";
const wbBtnPrimary =
  "bg-[var(--cc-cyan-a12)] text-cyan border-[var(--cyan-glow-strong)] hover:bg-[var(--cc-cyan-a20)] hover:shadow-[0_0_12px_var(--cyan-glow)]";
const wbBtnDanger =
  "bg-bg-raised text-red border-[var(--cc-red-a25)] hover:bg-[var(--cc-red-a10)]";

const wbInspector =
  "w-[500px] min-w-[500px] bg-bg-surface border-l border-border-subtle flex flex-col overflow-hidden max-1180:w-[420px] max-1180:min-w-[420px] max-768:w-full max-768:min-w-0 max-768:flex-1 max-768:border-l-0 max-768:[.app[data-page=workflow][data-mobile-panel=graph]_&]:hidden max-768:[.app[data-page=workflow][data-mobile-panel=log]_&]:hidden";
const wbInspectorHeader =
  "flex items-center gap-sm py-3 px-md border-b border-border-dim min-h-[44px]";
const wbInspectorTitle =
  "text-[0.72rem] font-semibold uppercase tracking-[0.08em] text-text-primary";
const wbInspectorBody = "flex-1 overflow-y-auto p-lg";
const wbOverviewSection = "mb-lg";
const wbOverviewStatGrid = "grid grid-cols-2 gap-sm mb-lg";
const wbOverviewStat = "bg-bg-raised border border-border-dim rounded-md p-3";
const wbOverviewStatValue =
  "text-[1.4rem] font-bold text-text-primary leading-none mb-1";
const wbOverviewStatLabel =
  "text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

const wbExecEvent =
  "py-2 border-b border-border-dim last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_32px]";
const wbExecEventHeader = "flex items-center gap-[8px] text-[0.72rem]";
const wbExecEventText = "text-text-secondary flex-1 min-w-0";
const wbExecEventDetail =
  "text-[0.7rem] text-text-tertiary mt-1 pl-[14px] leading-[1.4]";
const wbExecEventTimestamp =
  "text-[0.7rem] text-text-tertiary whitespace-nowrap shrink-0 ml-auto";
const wbExecEventDotBreaker =
  "w-[6px] h-[6px] rounded-full shrink-0 bg-red shadow-[0_0_0_1px_var(--cc-red-a40),0_0_6px_var(--cc-red-a50)]";

const wbValidationSectionLabel =
  "text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-text-tertiary mb-1 mt-2 first:mt-0";
const wbValidationBody = "mt-2 pl-[14px]";
const wbValidationIssuesList =
  "list-none p-0 m-0 border-l-2 border-border-default pl-[10px]";
const wbValidationIssue =
  "py-1 [&:not(:first-child)]:border-t [&:not(:first-child)]:border-border-dim";
const wbValidationIssueTitle =
  "text-[0.72rem] font-semibold text-text-primary leading-[1.3]";
const wbValidationIssueDesc = "mt-px";

const graphNodeBadgeBase =
  "text-[0.7rem] font-semibold uppercase tracking-[0.06em] py-1 px-[10px] rounded-[20px] whitespace-nowrap shrink-0 mt-[2px]";
const graphNodeBadgeByStatus: Record<string, string> = {
  pending: "bg-transparent text-text-tertiary border border-border-default",
  running:
    "bg-[var(--cc-cyan-a08)] text-cyan border border-[var(--cyan-glow-strong)]",
  completed:
    "bg-[var(--cc-green-a08)] text-green border border-[var(--cc-green-border)]",
  halted: "bg-[var(--cc-red-a08)] text-red border border-[var(--cc-red-a25)]",
  "awaiting-approval":
    "bg-[var(--cc-amber-a10)] text-amber border border-[var(--cc-amber-a30)]",
  // A not-taken branch is terminal-with-nothing, not merely unstarted: dashed
  // and dimmed, so it reads as inert rather than still-to-come (D4 R4).
  skipped:
    "bg-transparent text-text-tertiary border border-dashed border-border-default opacity-80",
};

const taskStatusDotByStatus: Record<string, string> = {
  completed: "bg-green",
  running: "bg-cyan animate-[pulse-dot_2s_ease-in-out_infinite]",
  failed: "bg-red",
  pending: "bg-text-tertiary",
};

const wbFieldInput =
  "w-full bg-bg-base border border-border-default rounded-sm text-text-primary text-[0.78rem] py-2 px-[10px] outline-none transition-[border-color] duration-150 focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";
const wbFieldTextarea = "resize-y min-h-[64px] leading-[1.5]";
const wbTaskDetailInput =
  "w-full bg-bg-base border border-border-default rounded-sm text-text-primary text-[0.75rem] py-[7px] px-[10px] outline-none transition-[border-color] duration-150 box-border focus:border-cyan focus:shadow-[0_0_0_1px_var(--cyan-glow)]";
const wbTaskDetailTextarea = "resize-y min-h-[56px] mb-[2px]";

import { CompactMarkdown } from "@/components/markdown/Markdown";
import CollapsibleText from "@/components/CollapsibleText";
import ConfirmDialog from "@/components/ConfirmDialog";
import ContextHaltCard from "@/components/workflow-graph/ContextHaltCard";
import { deriveOutputSchemaHaltEvidenceByContext } from "@/components/workflow-graph/derive-output-schema-halt";
import CapturedOutputSection, {
  resolveCapturedOutputView,
} from "./CapturedOutputSection";
import { UpstreamInputsList } from "@/components/workflow-config/UpstreamInputsList";
import { resolveUpstreamInputs } from "@/lib/workflow-graph/context-outputs";
import {
  deriveContextLoopDisplay,
  deriveContextProvenanceDisplay,
  deriveContextRouteRows,
  deriveContextSkipDisplay,
  type ContextLoopDisplay,
  type ContextProvenanceDisplay,
  type ContextRouteRow,
  type ContextSkipDisplay,
} from "@/components/workflow-graph/derive-graph";
import WorkflowEventLog from "@/components/workflow-graph/WorkflowEventLog";
import type {
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationIncidentEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
import {
  formatAgentProfileRef,
  type AgentProfileSnapshot,
} from "@/lib/agent-profiles/schemas";
import AdvisoryIndexPanel, { type AdvisoryOrigin } from "./AdvisoryIndexPanel";
import CohortRoundCard, { AuthorityChip } from "./CohortRoundCard";
import {
  authorityOfSeat,
  deriveCohortRoundView,
  type CohortMemberAuthority,
  type CohortMemberView,
} from "./cohort-round-view";
import type { ValidatorAuthority } from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
  GraphWorkflowLaneKind,
  GraphWorkflowValidationReviewArtifact,
} from "@/lib/workflow-graph/schemas";
import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import { isTaskConversationLive, isTaskEditable } from "./task-runtime-state";
import ContextConfigTab from "./ContextConfigTab";
import BriefFocusSheet from "./BriefFocusSheet";

// Small inline affordance in a brief field's label row (opens the focus sheet).
const wbFieldAction =
  "inline-flex cursor-pointer items-center gap-[5px] rounded-sm border-0 bg-transparent px-[6px] py-[2px] font-mono text-[0.7rem] text-text-tertiary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

// Rendered-Markdown read view for the long-form brief fields; click (or
// Enter/Space) opens the focus sheet.
const wbReadView =
  "w-full box-border cursor-pointer rounded-sm border border-solid border-border-default bg-bg-base px-[14px] py-[10px] text-left font-[inherit] text-[0.8rem] leading-[1.6] text-text-primary transition-[border-color] duration-150 hover:border-border-strong focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2";

const wbFieldLabelInline =
  "block text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary";

// Hairline-ruled group header (Brief / Tasks / Events / …).
function GroupHeader({
  label,
  meta,
}: {
  label: string;
  meta?: string;
}): React.JSX.Element {
  return (
    <div className="mb-[10px] flex items-center gap-sm">
      <SectionLabel>{label}</SectionLabel>
      {meta !== undefined ? (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          {meta}
        </span>
      ) : null}
      <span aria-hidden="true" className="h-px flex-1 bg-border-dim" />
    </div>
  );
}

// Read view for a Markdown brief field. The whole box is a click target that
// opens the focus sheet; keyboard users get the same via Enter/Space. Long
// content is clamped — the focus sheet shows it in full.
function MarkdownReadView({
  value,
  ariaLabel,
  onOpen,
}: {
  value: string;
  ariaLabel: string;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      className={wbReadView}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="max-h-[220px] overflow-hidden">
        <CompactMarkdown content={value} />
      </div>
    </div>
  );
}

type ResolvedContextDefinition =
  GraphWorkflowExecution["workingDefinition"]["executionContexts"][number];

// `tier:id@revision` for a seeded assignment. The snapshot is the side that
// ran: after the library moves on, only these bytes identify what the lane was
// actually given.
function seededProfileLabel(snapshot: AgentProfileSnapshot): string {
  return `${formatAgentProfileRef(snapshot)}@${snapshot.revision}`;
}

// At-a-glance summary of the selected context's resolved configuration:
// implementer + enabled gates as compact chips. Everything renders straight
// from the execution's already-resolved working definition.
function ResolvedSetupStrip({
  context,
}: {
  context: ResolvedContextDefinition;
}): React.JSX.Element {
  const cohort = context.contextValidator;
  const hasScriptGate = context.scriptValidator.commands.length > 0;
  return (
    <div
      className="flex flex-shrink-0 flex-wrap items-center gap-[6px] border-b border-solid border-border-dim bg-bg-base px-lg py-[10px]"
      data-section="resolved-setup"
    >
      <BackendChip backend={context.implementer.agent.backend}>
        {/* The implementer's PROFILE identity, not just its runtime: after a
            library edit only the seeded revision says which instructions this
            context's implementer actually received (R12.3). */}
        <span data-testid="setup-implementer-profile">
          {seededProfileLabel(context.implementer.profileSnapshot)}
        </span>
        {" · "}
        {implementerChipLabel(context.implementer.agent)}
      </BackendChip>
      {cohort.enabled
        ? cohort.assignments.map((assignment) => (
            <BackendChip key={assignment.id} backend={assignment.agent.backend}>
              Validator · {validatorChipLabel(assignment)}
            </BackendChip>
          ))
        : null}
      {hasScriptGate ? (
        <GateChip tone="neutral" icon={<ScriptGlyphIcon size={13} />}>
          Script
        </GateChip>
      ) : null}
      {context.humanApprovalGate.enabled ? (
        <GateChip tone="amber" icon={<ApprovalGlyphIcon size={13} />}>
          Approval
        </GateChip>
      ) : null}
      {context.askUserQuestions.enabled ? (
        <GateChip tone="amber" icon={<QuestionGlyphIcon size={13} />}>
          Questions
        </GateChip>
      ) : null}
    </div>
  );
}

function HistoricalContextConfiguration({
  context,
}: {
  context: ResolvedContextDefinition;
}) {
  return (
    <section
      aria-label="Historical context configuration"
      className="flex flex-col gap-sm"
    >
      <p className="m-0 text-[0.72rem] text-text-secondary">
        Historical configuration from the execution snapshot.
      </p>
      <pre className="m-0 overflow-x-auto rounded-md border border-solid border-border-subtle bg-bg-raised p-md font-mono text-[0.7rem] leading-relaxed whitespace-pre-wrap text-text-secondary">
        {JSON.stringify(context, null, 2)}
      </pre>
    </section>
  );
}

interface ExecutionInspectorPanelProps {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
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
  contextTabRequest?: ContextTabRequest | null;
  /** Project-scoped registry summaries for the config tab's command
   * multi-selects; undefined = registry unavailable. */
  commandOptions?: readonly ValidationCommandSummary[];
  /** Historical runs retain every inspection surface but expose no edits. */
  readOnly?: boolean;
}

export interface ContextTabRequest {
  contextId: string;
  tab: DetailTab;
  seq: number;
  /**
   * The validation round the request is aimed at, when it has one. A context's
   * History tab holds every round it has run, so a deep link that named only
   * the tab would leave the reader at whichever round the context has since
   * reached — so the advisory index's links carry the round that raised them.
   */
  roundSeq?: number;
}

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

function countMerges(execution: GraphWorkflowExecution): {
  merged: number;
  total: number;
} {
  let merged = 0;
  let total = 0;
  for (const state of Object.values(execution.contextStates)) {
    if (state.mergeStatus === "not-applicable") continue;
    total++;
    if (state.mergeStatus === "merged-success") merged++;
  }
  return { merged, total };
}

type DetailTab = "tasks" | "config" | "history";

type Timestamped<T> = T & { occurredAt: string };

function getContextTasks(execution: GraphWorkflowExecution, contextId: string) {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order);
}

function getHistoryEntries(
  events: GraphWorkflowExecutionEvent[],
  contextId?: string,
) {
  const validationEvents = events
    .filter(
      (
        entry,
      ): entry is {
        occurredAt: string;
        event: GraphWorkflowValidationResultEvent;
        preReset: boolean;
      } =>
        entry.event.type === "graph-workflow-validation-result" &&
        entry.preReset !== true &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map(
      (entry): Timestamped<GraphWorkflowValidationResultEvent> => ({
        ...entry.event,
        occurredAt: entry.occurredAt,
      }),
    )
    .reverse();
  const circuitBreakerEvents = events
    .filter(
      (
        entry,
      ): entry is {
        occurredAt: string;
        event: GraphWorkflowCircuitBreakerEvent;
        preReset: boolean;
      } =>
        entry.event.type === "graph-workflow-circuit-breaker" &&
        entry.preReset !== true &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map(
      (entry): Timestamped<GraphWorkflowCircuitBreakerEvent> => ({
        ...entry.event,
        occurredAt: entry.occurredAt,
      }),
    )
    .reverse();
  // Oldest-first, unlike the two above: incidents are read against ONE round,
  // where the order they happened in is the diagnosis.
  const incidentEvents = events
    .filter(
      (
        entry,
      ): entry is {
        occurredAt: string;
        event: GraphWorkflowValidationIncidentEvent;
        preReset: boolean;
      } =>
        entry.event.type === "graph-workflow-validation-incident" &&
        entry.preReset !== true &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map(
      (entry): Timestamped<GraphWorkflowValidationIncidentEvent> => ({
        ...entry.event,
        occurredAt: entry.occurredAt,
      }),
    );

  // The rounds a context reset retired. They are deliberately absent from the
  // lists above — the visible history is the current attempt — but an advisory
  // raised before the reset outlives it in the execution's index, and its
  // origin link has nowhere else to land.
  const clearedValidationEvents = events
    .filter(
      (
        entry,
      ): entry is {
        occurredAt: string;
        event: GraphWorkflowValidationResultEvent;
        preReset: boolean;
      } =>
        entry.event.type === "graph-workflow-validation-result" &&
        entry.preReset === true &&
        (contextId == null || entry.event.contextId === contextId),
    )
    .map(
      (entry): Timestamped<GraphWorkflowValidationResultEvent> => ({
        ...entry.event,
        occurredAt: entry.occurredAt,
      }),
    )
    .reverse();

  return {
    validationEvents,
    clearedValidationEvents,
    circuitBreakerEvents,
    incidentEvents,
  };
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getStatusBadgeClass(status?: string): string {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "halted":
      return "halted";
    case "awaiting_approval":
      return "awaiting-approval";
    case "skipped":
      return "skipped";
    default:
      return "pending";
  }
}

function getStatusLabel(status?: string): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "halted":
      return "Halted";
    case "ready":
      return "Ready";
    case "awaiting_approval":
      return "Awaiting Approval";
    case "skipped":
      return "Skipped";
    default:
      return "Pending";
  }
}

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

function computeReusedSessions(
  events: Timestamped<GraphWorkflowValidationResultEvent>[],
): Set<number> {
  const seenByLane = new Map<string, string>();
  const reusedIndices = new Set<number>();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const ref = event.sessionRef;
    if (!ref) continue;
    const sessionId = ref.workflowConversationId ?? ref.ref;
    const laneKey = `${ref.lane}:${ref.backend}`;
    const seen = seenByLane.get(laneKey);
    if (seen !== undefined && seen === sessionId) {
      reusedIndices.add(i);
    } else {
      seenByLane.set(laneKey, sessionId);
    }
  }
  return reusedIndices;
}

// ---- Validator response parsing ----

interface ParsedValidatorResponse {
  summary: string;
  issues: Array<{ title: string; description: string }>;
}

function parseValidatorResponseArtifact(
  response: string,
): ParsedValidatorResponse | null {
  try {
    const parsed: unknown = JSON.parse(response);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "summary" in parsed &&
      typeof (parsed as Record<string, unknown>).summary === "string"
    ) {
      const obj = parsed as Record<string, unknown>;
      const issues = Array.isArray(obj.issues)
        ? (obj.issues as unknown[]).filter(
            (item): item is { title: string; description: string } =>
              typeof item === "object" &&
              item !== null &&
              "title" in item &&
              typeof (item as Record<string, unknown>).title === "string" &&
              "description" in item &&
              typeof (item as Record<string, unknown>).description === "string",
          )
        : [];
      return { summary: obj.summary as string, issues };
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Structured Validation Result Card ----

function getLaneBadgeLabel(lane: GraphWorkflowLaneKind | undefined): string {
  if (lane === "context_validator") return "Context";
  return "";
}

function formatBackendName(backend: string): string {
  return `${backend.slice(0, 1).toUpperCase()}${backend.slice(1)}`;
}

function ResponseArtifactSection({
  reviewArtifact,
}: {
  reviewArtifact: Extract<
    GraphWorkflowValidationReviewArtifact,
    { kind: "response" }
  >;
}) {
  const parsed = useMemo(
    () => parseValidatorResponseArtifact(reviewArtifact.response),
    [reviewArtifact.response],
  );

  return (
    <div className="mt-2 pl-[14px]">
      <div className={wbValidationSectionLabel}>
        {formatBackendName(reviewArtifact.backend)} Review
      </div>
      <div className="mb-1 text-[0.68rem] text-text-tertiary">
        Reference:{" "}
        <code className="font-mono text-[0.65rem] text-text-secondary">
          {reviewArtifact.ref}
        </code>
      </div>
      {reviewArtifact.response && (
        <CollapsibleText maxCollapsedHeight={120}>
          {parsed ? (
            <>
              <CompactMarkdown content={parsed.summary} />
              {parsed.issues.length > 0 && (
                <div className={wbValidationBody}>
                  <div className={wbValidationSectionLabel}>
                    Issues ({parsed.issues.length})
                  </div>
                  <ul className={wbValidationIssuesList}>
                    {parsed.issues.map((issue, idx) => (
                      <li key={idx} className={wbValidationIssue}>
                        <div className={wbValidationIssueTitle}>
                          {issue.title}
                        </div>
                        <div className={wbValidationIssueDesc}>
                          <CompactMarkdown content={issue.description} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <CompactMarkdown content={reviewArtifact.response} />
          )}
        </CollapsibleText>
      )}
      {reviewArtifact.usage && (
        <div className="mt-1 text-[0.65rem] text-text-tertiary">
          {reviewArtifact.usage.inputTokens}↑{" "}
          {reviewArtifact.usage.cachedInputTokens}⊙{" "}
          {reviewArtifact.usage.outputTokens}↓ tokens
        </div>
      )}
    </div>
  );
}

/** The header a cohort member's transcript opens under. */
function assignmentTranscriptLabel(assignmentId: string): string {
  return `Validator · ${assignmentId}`;
}

/**
 * ONE cohort member's verdict, nested inside the aggregate round result.
 *
 * Nested rather than listed as a sibling: the aggregate is the deterministic
 * outcome the engine acted on, and a member card floating beside it would read
 * as a second, competing result. Everything here is the member's own —
 * identity, verdict, issues, artifact and lane — so no reader has to attribute
 * a finding by position.
 */
function SpecialistCard({
  specialist,
  contextId,
  authority,
  onViewConversation,
}: {
  specialist: GraphWorkflowValidationSpecialistEntry;
  contextId: string;
  /** This seat's blocking power, read from the cohort as configured now. */
  authority: CohortMemberAuthority;
  onViewConversation?: ExecutionInspectorPanelProps["onViewConversation"];
}): React.JSX.Element {
  const sessionRef = specialist.sessionRef;
  const conversationId = sessionRef?.workflowConversationId;
  const reviewArtifact = specialist.reviewArtifact;

  return (
    <div
      className="border-x-0 border-t border-b-0 border-solid border-border-dim py-[8px] first:border-t-0"
      data-testid="validation-specialist"
      data-assignment-id={specialist.assignmentId}
      data-verdict={specialist.pass ? "pass" : "fail"}
      data-authority={authority}
    >
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
          {specialist.assignmentId}
        </span>
        <span
          className="font-mono text-[0.66rem] text-text-tertiary"
          data-testid="validation-specialist-profile"
        >
          {`${formatAgentProfileRef(specialist.profile)}@${specialist.profile.revision}`}
        </span>
        <AuthorityChip authority={authority} />
        <StatusChip tone={specialist.pass ? "green" : "red"}>
          {specialist.pass ? "Passed" : "Rejected"}
        </StatusChip>
        {conversationId !== undefined && sessionRef && onViewConversation && (
          <button
            className={cn(
              wbBtn,
              wbBtnXs,
              wbBtnDefault,
              "ml-auto text-[0.68rem]",
            )}
            onClick={() =>
              onViewConversation(
                conversationId,
                sessionRef.lane,
                contextId,
                assignmentTranscriptLabel(specialist.assignmentId),
              )
            }
            type="button"
          >
            View Transcript
          </button>
        )}
      </div>
      <div className="mt-[4px] min-w-0 text-[0.72rem]">
        <CompactMarkdown content={specialist.summary} />
      </div>
      {reviewArtifact?.kind === "response" && (
        <ResponseArtifactSection reviewArtifact={reviewArtifact} />
      )}
      {specialist.issues.length > 0 && (
        <div className={wbValidationBody}>
          <div className={wbValidationSectionLabel}>
            Issues ({specialist.issues.length})
          </div>
          <CollapsibleText maxCollapsedHeight={140}>
            <ul className={wbValidationIssuesList}>
              {specialist.issues.map((issue, idx) => (
                <li key={idx} className={wbValidationIssue}>
                  <div className={wbValidationIssueTitle}>
                    {issue.path !== undefined ? (
                      <code className="mr-[6px] font-mono text-amber">
                        {issue.path}
                      </code>
                    ) : (
                      issue.title
                    )}
                  </div>
                  <div className={wbValidationIssueDesc}>
                    <CompactMarkdown content={issue.description} />
                  </div>
                </li>
              ))}
            </ul>
          </CollapsibleText>
        </div>
      )}
    </div>
  );
}

/**
 * The attributes that mark a round record as the one a deep link landed on.
 *
 * The ring is driven by the data attribute rather than by `:focus-visible`,
 * because the focus that put the reader here was programmatic — the browser
 * heuristic would leave the destination unmarked exactly when it matters most.
 */
const focusedRoundClass =
  "rounded-sm [outline:2px_solid_var(--color-cyan)] outline-offset-2";

function focusedRoundAttrs(anchorId: string) {
  return { id: anchorId, tabIndex: -1, "data-focused-round": "true" } as const;
}

/**
 * The cohort seats of the context an event belongs to, as configured NOW. The
 * event froze a roster; authority is deliberately not read from it, exactly as
 * `deriveCohortRoundView` does for the live round — a seat holds the blocking
 * power it holds now, and the two round surfaces must not disagree.
 */
function cohortAssignmentsFor(
  execution: GraphWorkflowExecution,
  contextId: string,
): readonly { id: string; authority: ValidatorAuthority }[] {
  return (
    execution.workingDefinition.executionContexts.find(
      (ctx) => ctx.id === contextId,
    )?.contextValidator?.assignments ?? []
  );
}

function ValidationCard({
  event,
  cohortAssignments,
  isReusedSession,
  onViewConversation,
  focusAnchorId,
}: {
  event: Timestamped<GraphWorkflowValidationResultEvent>;
  cohortAssignments: readonly { id: string; authority: ValidatorAuthority }[];
  isReusedSession?: boolean;
  onViewConversation?: ExecutionInspectorPanelProps["onViewConversation"];
  /** Set on the ONE card a round deep link is aimed at; absent on the rest. */
  focusAnchorId?: string;
}) {
  const specialists = event.specialists ?? [];
  // A rejecting cohort publishes each finding TWICE: `concludeCohort`
  // concatenates every failing lane's findings onto the aggregate, and each
  // lane's entry carries its own copy. Rendering both lists would show every
  // finding twice, and the aggregate copy carries no visible attribution — so
  // an attributed finding is rendered only in its assignment's group.
  //
  // Filtered by attribution rather than by "a cohort is present": a finding
  // that names no listed assignment (a round-level objection, an
  // output-schema rejection) has no group to fall into, and dropping it would
  // lose a real finding rather than a duplicate.
  const specialistIds = new Set(
    specialists.map((specialist) => specialist.assignmentId),
  );
  const aggregateIssues =
    specialists.length === 0
      ? event.issues
      : event.issues.filter(
          (issue) =>
            issue.assignmentId === undefined ||
            !specialistIds.has(issue.assignmentId),
        );
  const hasIssues = aggregateIssues.length > 0;
  const sessionRef = event.sessionRef;
  const reviewArtifact = event.reviewArtifact;
  // An output-schema rejection is the engine's own verdict on a format turn,
  // not a lane agent's review: it has no validator lane to badge and no
  // validator transcript to open, so both affordances are withheld rather than
  // pointed at the implementer conversation that happened to host the turn.
  const isOutputSchema = event.kind === "output_schema";
  const workflowConversationId = isOutputSchema
    ? undefined
    : sessionRef?.workflowConversationId;

  const laneBadge = isOutputSchema ? "" : getLaneBadgeLabel(sessionRef?.lane);

  return (
    <div
      className={cn(
        "border-x-0 border-t-0 border-b border-solid border-border-dim py-[10px] last:border-b-0",
        focusAnchorId !== undefined && focusedRoundClass,
      )}
      data-testid="validation-aggregate"
      data-round-seq={event.roundSeq ?? undefined}
      {...(focusAnchorId !== undefined ? focusedRoundAttrs(focusAnchorId) : {})}
    >
      <div className="flex items-start gap-[8px] text-[0.72rem]">
        <span
          className={cn(
            "mt-[5px] h-[6px] w-[6px] shrink-0 rounded-full",
            event.pass
              ? "bg-green shadow-[0_0_6px_var(--green-glow)]"
              : "bg-red",
          )}
        />
        <div className="min-w-0 flex-1">
          <CompactMarkdown content={event.summary} />
        </div>
        {event.roundSeq !== null && event.roundSeq !== undefined && (
          <span className="shrink-0 font-mono text-[0.68rem] whitespace-nowrap text-text-tertiary">
            Round {event.roundSeq}
          </span>
        )}
        <span className="shrink-0 text-[0.7rem] whitespace-nowrap text-text-tertiary">
          {formatTimestamp(event.occurredAt)}
        </span>
      </div>
      {(sessionRef || isOutputSchema) && (
        <div className="mt-[5px] flex flex-wrap items-center gap-[5px] pl-[14px]">
          {isOutputSchema && (
            <span className="rounded-[3px] border border-solid border-[var(--cc-red-a25)] bg-red-glow px-[5px] py-px text-[0.64rem] font-bold tracking-[0.06em] text-red uppercase">
              Output schema
            </span>
          )}
          {laneBadge && (
            <span className="rounded-[3px] bg-blue-glow px-[5px] py-px text-[0.64rem] font-bold tracking-[0.06em] text-blue uppercase">
              {laneBadge}
            </span>
          )}
          {sessionRef && (
            <span className="rounded-[3px] bg-bg-raised px-[5px] py-px text-[0.64rem] text-text-tertiary">
              {sessionRef.backend}
            </span>
          )}
          {isReusedSession && (
            <span className="text-[0.64rem] text-text-tertiary opacity-80">
              ↺ continued
            </span>
          )}
          {workflowConversationId && sessionRef && onViewConversation && (
            <button
              className={cn(
                wbBtn,
                wbBtnXs,
                wbBtnDefault,
                "ml-auto text-[0.68rem]",
              )}
              onClick={() =>
                onViewConversation(
                  workflowConversationId,
                  sessionRef.lane,
                  event.contextId,
                )
              }
              type="button"
            >
              View Transcript
            </button>
          )}
        </div>
      )}
      {reviewArtifact?.kind === "response" && (
        <ResponseArtifactSection reviewArtifact={reviewArtifact} />
      )}
      {hasIssues && (
        <div
          className={wbValidationBody}
          data-testid="validation-aggregate-issues"
        >
          <div className={wbValidationSectionLabel}>
            {specialists.length > 0 ? "Unattributed Issues" : "Issues"} (
            {aggregateIssues.length})
          </div>
          <CollapsibleText maxCollapsedHeight={140}>
            <ul className={wbValidationIssuesList}>
              {aggregateIssues.map((issue, idx) => (
                <li key={idx} className={wbValidationIssue}>
                  <div className={wbValidationIssueTitle}>
                    {/* This list is the one place a finding can appear outside
                        its assignment group, so a finding that DOES name a
                        raiser carries it inline rather than reading as
                        anonymous. */}
                    {issue.assignmentId !== undefined && (
                      <span className="mr-[6px] font-mono text-[0.66rem] text-text-tertiary">
                        {issue.assignmentId}
                      </span>
                    )}
                    {/* A path-carrying issue titles itself with a machine
                        locator; an agent validator's issues are prose. Mono
                        + amber is the same locator recipe the halt surfaces
                        use, so one instance path reads alike everywhere. */}
                    {issue.path !== undefined ? (
                      <code className="mr-[6px] font-mono text-amber">
                        {issue.path}
                      </code>
                    ) : (
                      issue.title
                    )}
                  </div>
                  <div className={wbValidationIssueDesc}>
                    <CompactMarkdown content={issue.description} />
                  </div>
                </li>
              ))}
            </ul>
          </CollapsibleText>
        </div>
      )}
      {specialists.length > 0 && (
        <div className={wbValidationBody}>
          <div className={wbValidationSectionLabel}>
            Cohort ({specialists.length})
          </div>
          {specialists.map((specialist) => (
            <SpecialistCard
              key={specialist.assignmentId}
              specialist={specialist}
              contextId={event.contextId}
              authority={authorityOfSeat(
                cohortAssignments,
                specialist.assignmentId,
              )}
              {...(onViewConversation ? { onViewConversation } : {})}
            />
          ))}
        </div>
      )}
      {event.reopenTaskIds.length > 0 && (
        <div className={wbValidationBody}>
          <div className={wbValidationSectionLabel}>
            Reopened Tasks ({event.reopenTaskIds.length})
          </div>
          <ul className={wbValidationIssuesList}>
            {event.reopenTaskIds.map((taskId) => (
              <li key={taskId} className={wbValidationIssue}>
                <div className={wbValidationIssueTitle}>
                  <code>{taskId}</code>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---- D4 routing / loop / expansion read surfaces (R13) ----

// Every one of these renders from the SAME derivations the graph nodes and
// edges use (`derive-graph.ts`), so the inspector and the canvas cannot report
// different routing.

const wbRoutingRow =
  "flex flex-wrap items-center gap-[6px] border-b border-border-dim py-[6px] text-[0.72rem] last:border-b-0";

const routeResolutionTone: Record<
  ContextRouteRow["resolution"],
  "neutral" | "cyan" | "amber" | "red"
> = {
  active: "cyan",
  inactive: "neutral",
  omitted: "neutral",
  unresolved: "amber",
  unevaluable: "red",
};

function RoutingSection({
  routes,
  skip,
}: {
  routes: ContextRouteRow[];
  skip: ContextSkipDisplay | null;
}): React.JSX.Element | null {
  const hasGuard = routes.some((route) => route.guard !== "none");
  if (!hasGuard && !skip) return null;

  return (
    <section className={wbOverviewSection} data-testid="context-routing">
      <GroupHeader label="Routing" />
      {skip && (
        <div
          data-testid="context-skip-reason"
          className="mb-sm rounded-sm border border-border-dim bg-bg-raised p-3 text-[0.72rem] text-text-secondary"
        >
          <div className="mb-1 font-medium text-text-primary">
            Branch not taken
          </div>
          <div className="text-text-tertiary">
            Decided {formatTimestamp(skip.at)} — recorded verdicts:
          </div>
          <ul className="mt-1 list-none p-0">
            {skip.edgeEvaluations.map((evaluation) => (
              <li key={evaluation.edgeId} className="font-mono text-[0.7rem]">
                {evaluation.edgeId} · {evaluation.verdict}
              </li>
            ))}
          </ul>
        </div>
      )}
      {routes.map((route) => (
        <div
          key={route.edgeId}
          className={wbRoutingRow}
          data-testid="context-route-row"
          data-edge-id={route.edgeId}
          data-guard={route.guard}
          data-resolution={route.resolution}
        >
          <span className="font-mono text-[0.7rem] text-text-secondary">
            {route.logicalSourceId}
          </span>
          {route.effectiveSourceId !== null &&
            route.effectiveSourceId !== route.logicalSourceId && (
              <span className="font-mono text-[0.68rem] text-text-tertiary">
                via {route.effectiveSourceId}
              </span>
            )}
          {route.guard !== "none" && (
            <StatusChip tone="violet">
              {route.guard === "else" ? "else" : "when"}
            </StatusChip>
          )}
          <StatusChip tone={routeResolutionTone[route.resolution]}>
            {route.resolution}
          </StatusChip>
        </div>
      ))}
    </section>
  );
}

function LoopSection({
  loop,
}: {
  loop: ContextLoopDisplay | null;
}): React.JSX.Element | null {
  if (!loop) return null;
  return (
    <section className={wbOverviewSection} data-testid="context-loop">
      <GroupHeader label="Loop" meta={loop.loopGroupId} />
      <div className="flex flex-wrap items-center gap-[6px] text-[0.72rem] text-text-secondary">
        <StatusChip tone="violet">
          Pass {loop.pass} of {loop.maxPasses}
        </StatusChip>
        <StatusChip tone={loop.activation === "running" ? "cyan" : "neutral"}>
          {loop.activation}
        </StatusChip>
        {loop.templateVersion !== null && (
          <StatusChip tone="neutral">
            template v{loop.templateVersion}
          </StatusChip>
        )}
      </div>
      <div className="mt-1 font-mono text-[0.7rem] text-text-tertiary">
        cloned from {loop.authoredContextId}
      </div>
    </section>
  );
}

function ProvenanceSection({
  provenance,
}: {
  provenance: ContextProvenanceDisplay | null;
}): React.JSX.Element | null {
  if (!provenance) return null;
  return (
    <section className={wbOverviewSection} data-testid="context-provenance">
      <GroupHeader label="Provenance" />
      <div className="text-[0.72rem] leading-snug text-text-secondary">
        <div>
          Added at runtime by{" "}
          <span className="font-mono text-text-primary">
            {provenance.invokerContextId}
          </span>{" "}
          on {formatTimestamp(provenance.acceptedAt)}
        </div>
        <div className="mt-1 text-text-primary">{provenance.rationale}</div>
        <div className="mt-1 font-mono text-[0.68rem] text-text-tertiary">
          request {provenance.requestId} · payload{" "}
          {provenance.payloadHash.slice(0, 12)}…
        </div>
      </div>
    </section>
  );
}

/**
 * The execution-wide expansion audit (R8/R13): what was accepted, and what was
 * refused. Both ledgers are durable — a refusal receipt is the only record that
 * an attempt was made and declined — so the overview reports them together.
 */
function ExpansionLedgerSection({
  receipts,
}: {
  receipts: GraphWorkflowExecution["expansionReceipts"];
}): React.JSX.Element | null {
  if (receipts.accepted.length === 0 && receipts.refusals.length === 0) {
    return null;
  }
  return (
    <section className={wbOverviewSection} data-testid="expansion-ledger">
      <GroupHeader
        label="Runtime expansions"
        meta={`${receipts.accepted.length} accepted · ${receipts.refusals.length} refused`}
      />
      {receipts.accepted.map((receipt) => (
        <div
          key={`accepted-${receipt.requestId}`}
          className={wbExecEvent}
          data-testid="expansion-accepted-row"
        >
          <div className={wbExecEventHeader}>
            <span className={wbExecEventText}>{receipt.rationale}</span>
            <span className={wbExecEventTimestamp}>
              {formatTimestamp(receipt.acceptedAt)}
            </span>
          </div>
          <div className={cn(wbExecEventDetail, "font-mono")}>
            {receipt.invokerContextId} → {receipt.addedContextIds.join(", ")}
            {receipt.addedTaskIds.length > 0
              ? ` · ${receipt.addedTaskIds.length} tasks`
              : ""}
            {receipt.rejoinContextIds.length > 0
              ? ` · rejoins ${receipt.rejoinContextIds.join(", ")}`
              : ""}
          </div>
        </div>
      ))}
      {receipts.refusals.map((receipt) => (
        <div
          key={`refused-${receipt.requestId}-${receipt.payloadHash}`}
          className={wbExecEvent}
          data-testid="expansion-refusal-row"
        >
          <div className={wbExecEventHeader}>
            <span className={wbExecEventDotBreaker} />
            <span className={wbExecEventText}>{receipt.refusalCode}</span>
            <span className={wbExecEventTimestamp}>
              {formatTimestamp(receipt.refusedAt)}
            </span>
          </div>
          <div className={cn(wbExecEventDetail, "font-mono")}>
            {receipt.invokerContextId} · request {receipt.requestId}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---- Overview View (no context selected) ----

function OverviewView({
  execution,
  events,
  loopLedger,
  onSelectContext,
  onOpenAdvisoryOrigin,
  onEditSchema,
  onViewConversation,
}: {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  loopLedger?: ReactNode;
  onSelectContext?: (contextId: string) => void;
  /** Opens an indexed advisory's originating context at the round that raised it. */
  onOpenAdvisoryOrigin?: (origin: AdvisoryOrigin) => void;
  onEditSchema?: (contextId: string) => void;
  onViewConversation?: ExecutionInspectorPanelProps["onViewConversation"];
}) {
  const totalContexts = execution.workingDefinition.executionContexts.length;
  const completedContexts = Object.values(execution.contextStates).filter(
    (cs) => cs.status === "completed",
  ).length;
  const totalTasks = execution.workingDefinition.tasks.length;
  const completedTasks = Object.values(execution.taskStates).filter(
    (ts) => ts.status === "completed",
  ).length;
  const edgeCount = execution.workingDefinition.edges.length;
  const mergeCounts = countMerges(execution);

  const history = useMemo(() => getHistoryEntries(events), [events]);
  const contextTitles = useMemo(
    () =>
      Object.fromEntries(
        execution.workingDefinition.executionContexts.map((ctx) => [
          ctx.id,
          ctx.title,
        ]),
      ),
    [execution.workingDefinition.executionContexts],
  );
  // The overview is the first halt surface an operator sees, and it renders
  // every reason on the run — so it derives evidence for all of them, not just
  // the primary one.
  const outputSchemaHaltEvidence = useMemo(
    () =>
      deriveOutputSchemaHaltEvidenceByContext({
        execution,
        haltReasons: [execution.haltReason, ...execution.secondaryHaltReasons],
        validationEvents: history.validationEvents,
      }),
    [execution, history.validationEvents],
  );

  return (
    <aside className={wbInspector}>
      <header className={wbInspectorHeader}>
        <span className={wbInspectorTitle}>Overview</span>
        <span className="ml-auto flex items-center gap-sm font-mono text-[0.68rem] whitespace-nowrap text-text-tertiary">
          <span data-testid="overview-live-revision">
            liveRev {execution.liveRevision}
          </span>
          <span data-testid="overview-seed">
            {execution.seedDefinitionId}@{execution.seedDefinitionRevision}
          </span>
        </span>
      </header>
      <div className={cn(wbInspectorBody, "wb-inspector-body")}>
        {execution.haltReason && (
          <ContextHaltCard
            primary={execution.haltReason}
            secondary={execution.secondaryHaltReasons}
            outputSchemaEvidence={outputSchemaHaltEvidence}
            {...(onEditSchema !== undefined ? { onEditSchema } : {})}
          />
        )}

        {execution.charterAmendments.length > 0 && (
          <div
            data-testid="overview-charter-amendments"
            className="text-[0.72rem] leading-snug text-text-secondary"
          >
            <span className="font-medium text-text-primary">
              Charter amended ×{execution.charterAmendments.length}
            </span>{" "}
            — latest:{" "}
            {
              execution.charterAmendments[
                execution.charterAmendments.length - 1
              ]?.rationale
            }
          </div>
        )}

        <div className={wbOverviewStatGrid}>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>
              {completedContexts}/{totalContexts}
            </div>
            <div className={wbOverviewStatLabel}>Contexts</div>
          </div>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>
              {completedTasks}/{totalTasks}
            </div>
            <div className={wbOverviewStatLabel}>Tasks</div>
          </div>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>{edgeCount}</div>
            <div className={wbOverviewStatLabel}>Edges</div>
          </div>
          <div className={wbOverviewStat}>
            <div className={wbOverviewStatValue}>
              {mergeCounts.merged}/{mergeCounts.total}
            </div>
            <div className={wbOverviewStatLabel}>Merges</div>
          </div>
        </div>

        {Object.keys(execution.boundInputs).length > 0 && (
          <section className={wbOverviewSection}>
            <GroupHeader label="Launch Inputs" />
            {Object.entries(execution.boundInputs).map(([name, value]) => (
              <div key={name} className={wbExecEvent}>
                <div className={wbExecEventHeader}>
                  <span className={wbExecEventText}>{name}</span>
                </div>
                {/* whitespace-pre-line preserves newlines in `text` values. */}
                <div className={cn(wbExecEventDetail, "whitespace-pre-line")}>
                  {value}
                </div>
              </div>
            ))}
          </section>
        )}

        {loopLedger ? (
          <section className={wbOverviewSection}>{loopLedger}</section>
        ) : null}

        <ExpansionLedgerSection receipts={execution.expansionReceipts} />

        <section className={wbOverviewSection}>
          <GroupHeader label="Events" />
          <WorkflowEventLog
            execution={execution}
            events={events}
            onSelectContext={onSelectContext}
          />
        </section>

        {execution.advisoryIndex.length > 0 && (
          <section className={wbOverviewSection} data-section="advisories">
            <GroupHeader
              label="Advisories"
              meta={`${execution.advisoryIndex.length}`}
            />
            <AdvisoryIndexPanel
              index={execution.advisoryIndex}
              contextTitles={contextTitles}
              {...(onOpenAdvisoryOrigin !== undefined
                ? { onOpenOrigin: onOpenAdvisoryOrigin }
                : {})}
            />
          </section>
        )}

        {history.validationEvents.length > 0 && (
          <section className={wbOverviewSection}>
            <GroupHeader label="Recent Validations" />
            {(() => {
              const reused = computeReusedSessions(history.validationEvents);
              return history.validationEvents
                .slice(0, 5)
                .map((event, index) => (
                  <ValidationCard
                    key={`val-${index}`}
                    event={event}
                    cohortAssignments={cohortAssignmentsFor(
                      execution,
                      event.contextId,
                    )}
                    isReusedSession={reused.has(index)}
                    onViewConversation={onViewConversation}
                  />
                ));
            })()}
          </section>
        )}

        {history.circuitBreakerEvents.length > 0 && (
          <section className={wbOverviewSection}>
            <GroupHeader label="Circuit Breakers" />
            {history.circuitBreakerEvents.slice(0, 5).map((event, index) => {
              const ctxTitle =
                execution.workingDefinition.executionContexts.find(
                  (ctx) => ctx.id === event.contextId,
                )?.title ?? event.contextId;
              return (
                <div key={`cb-${index}`} className={wbExecEvent}>
                  <div className={wbExecEventHeader}>
                    <span className={wbExecEventDotBreaker} />
                    <span className={wbExecEventText}>
                      {ctxTitle}: {event.failureCount} failures (
                      {event.condition})
                    </span>
                    <span className={wbExecEventTimestamp}>
                      {formatTimestamp(event.occurredAt)}
                    </span>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {execution.sharedDocuments.length > 0 && (
          <section className={wbOverviewSection}>
            <GroupHeader label="Shared Documents" />
            {execution.sharedDocuments.map((doc) => (
              <div key={doc.id} className={wbExecEvent}>
                <div className={wbExecEventHeader}>
                  <span className={wbExecEventText}>{doc.description}</span>
                </div>
                <div className={wbExecEventDetail}>{doc.relativePath}</div>
              </div>
            ))}
          </section>
        )}
      </div>
    </aside>
  );
}

// ---- Detail View (context selected) ----

function DetailView({
  execution,
  events,
  contextId,
  userInputPanels,
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
  contextTabRequest,
  commandOptions,
  readOnly = false,
}: {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  contextId: string;
  userInputPanels?: ReactNode;
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
  onResetAssignment?: ExecutionInspectorPanelProps["onResetAssignment"];
  resettingAssignmentId?: string | null;
  libraryProjectName?: string | null;
  onViewTask: (taskId: string) => void;
  viewingTaskId: string | null;
  isMutating: boolean;
  onSaveContextConfig?: ExecutionInspectorPanelProps["onSaveContextConfig"];
  onPauseExecution?: ExecutionInspectorPanelProps["onPauseExecution"];
  onResumeExecution?: ExecutionInspectorPanelProps["onResumeExecution"];
  isSavingConfig?: boolean;
  isPausingExecution?: boolean;
  isResumingExecution?: boolean;
  configEditConflict?: boolean;
  configEditError?: string | null;
  configSaveSucceeded?: boolean;
  onViewConversation?: ExecutionInspectorPanelProps["onViewConversation"];
  contextTabRequest?: ContextTabRequest | null;
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
  // The round a honoured request aimed at, held as a fresh object per request so
  // that asking twice for the same round scrolls back to it rather than reading
  // as unchanged state.
  const [focusedRound, setFocusedRound] = useState<{ seq: number } | null>(
    null,
  );
  if (
    contextTabRequest != null &&
    contextTabRequest.contextId === contextId &&
    honouredTabRequestSeq !== contextTabRequest.seq
  ) {
    setHonouredTabRequestSeq(contextTabRequest.seq);
    setActiveTab(contextTabRequest.tab);
    setFocusedRound(
      contextTabRequest.roundSeq === undefined
        ? null
        : { seq: contextTabRequest.roundSeq },
    );
  }
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
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [sheetField, setSheetField] = useState<
    "description" | "acceptanceCriteria" | null
  >(null);

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
  const cohortRoundView = useMemo(() => {
    const state = execution.contextStates[contextId];
    return deriveCohortRoundView({
      round: state?.validationRound,
      incidents: history.incidentEvents,
      assignments: cohortAssignments,
      advisoryResponse: state?.advisoryResponse ?? null,
    });
  }, [execution, contextId, cohortAssignments, history.incidentEvents]);

  // Which round record a deep link is aimed at. The context state keeps only
  // the LATEST round, so a superseded one is read off its validation-result
  // event — which is where an advisory older than the current round still is.
  const focusedRoundSeq = focusedRound?.seq ?? null;
  const liveRoundFocused =
    cohortRoundView !== null &&
    focusedRoundSeq !== null &&
    cohortRoundView.seq === focusedRoundSeq;
  const focusedValidationIndex =
    focusedRoundSeq === null || liveRoundFocused
      ? -1
      : history.validationEvents.findIndex(
          (event) => event.roundSeq === focusedRoundSeq,
        );
  // Neither the live round nor the visible history holds it: the round was
  // retired by a context reset, or concluded without leaving an aggregate. The
  // link still has to land ON that round, so it gets a section of its own —
  // carrying the retired record when one survives, and naming the round either
  // way. Nothing here rejoins the ordinary history: it is one round, shown
  // because it was asked for.
  const unlistedFocusRound =
    focusedRoundSeq !== null && !liveRoundFocused && focusedValidationIndex < 0
      ? {
          seq: focusedRoundSeq,
          record:
            history.clearedValidationEvents.find(
              (event) => event.roundSeq === focusedRoundSeq,
            ) ?? null,
        }
      : null;
  const focusedRoundAnchorId = useId();
  useEffect(() => {
    if (focusedRound === null) return;
    const target = document.getElementById(focusedRoundAnchorId);
    if (target === null) return;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [focusedRound, focusedRoundAnchorId]);

  if (!context) return null;

  const status = contextState?.status;
  const completedCount = contextState?.completedTaskCount ?? 0;
  const totalCount = contextState?.totalTaskCount ?? tasks.length;
  const iterationCount = contextState?.iterationCount ?? 0;

  const canAddTasks =
    !readOnly &&
    contextState?.status !== "completed" &&
    context.mutability?.allowAgentTaskAdd;

  const canResetContext =
    !readOnly &&
    onResetContext != null &&
    (execution.status === "paused" || execution.status === "halted") &&
    contextState?.status !== "completed";

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
    <aside className={wbInspector}>
      <header className={wbInspectorHeader}>
        <button
          className="-mx-2 -my-1 flex shrink-0 cursor-pointer appearance-none items-center gap-[6px] rounded-sm border-0 bg-transparent px-2 py-1 text-[0.72rem] font-medium text-text-secondary transition-all duration-150 hover:bg-bg-elevated hover:text-text-primary"
          onClick={onDeselectContext}
          type="button"
        >
          ◂ Back
        </button>
        <span className="min-w-0 flex-1 overflow-hidden text-[0.78rem] font-semibold text-ellipsis whitespace-nowrap text-text-primary">
          {context.title}
        </span>
        <span
          className={cn(
            graphNodeBadgeBase,
            graphNodeBadgeByStatus[getStatusBadgeClass(status)],
          )}
        >
          {getStatusLabel(status)}
        </span>
        {canResetContext && (
          <button
            className={cn(wbBtn, wbBtnXs, wbBtnDanger)}
            onClick={() => setResetConfirmOpen(true)}
            disabled={isMutating}
            type="button"
          >
            Reset Context
          </button>
        )}
      </header>

      <ResolvedSetupStrip context={context} />

      <TabsRoot
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as DetailTab)}
        layoutClassName="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0 border-b border-solid border-border-dim px-md py-[8px]">
          <TabsList aria-label="Context inspector sections">
            <TabsTrigger value="tasks">Tasks</TabsTrigger>
            <TabsTrigger value="config">Config</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
        </div>

        <div className={cn(wbInspectorBody, "wb-inspector-body", "min-h-0")}>
          {userInputPanels && (
            <section className={wbOverviewSection}>
              <GroupHeader label="Questions" />
              {userInputPanels}
            </section>
          )}
          {contextHaltReason && (
            <ContextHaltCard
              primary={contextHaltReason}
              outputSchemaEvidence={outputSchemaHaltEvidence}
              // Already inside the refusing context: the action only has to
              // move the operator to the tab that owns the contract.
              {...(!readOnly
                ? { onEditSchema: () => setActiveTab("config") }
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

          <TabsContent value="tasks">
            <section className={wbOverviewSection} data-section="brief">
              <GroupHeader label="Brief" />
              <div className="flex flex-col gap-md">
                {context.description && (
                  <div>
                    <div className="mb-xs flex items-center justify-between">
                      <span className={wbFieldLabelInline}>Description</span>
                      <button
                        type="button"
                        className={wbFieldAction}
                        onClick={() => setSheetField("description")}
                      >
                        <ExpandGlyphIcon /> Open
                      </button>
                    </div>
                    <MarkdownReadView
                      value={context.description}
                      ariaLabel="View description"
                      onOpen={() => setSheetField("description")}
                    />
                  </div>
                )}
                <div>
                  <div className="mb-xs flex items-center justify-between">
                    <span className={wbFieldLabelInline}>
                      Acceptance criteria
                    </span>
                    <button
                      type="button"
                      className={wbFieldAction}
                      onClick={() => setSheetField("acceptanceCriteria")}
                    >
                      <ExpandGlyphIcon /> Open
                    </button>
                  </div>
                  <MarkdownReadView
                    value={context.acceptanceCriteria}
                    ariaLabel="View acceptance criteria"
                    onOpen={() => setSheetField("acceptanceCriteria")}
                  />
                </div>
                <UpstreamInputsList inputs={upstreamInputs} />
              </div>
            </section>

            <RoutingSection routes={routeRows} skip={skipDisplay} />
            <LoopSection loop={loopDisplay} />
            <ProvenanceSection provenance={provenanceDisplay} />

            <CapturedOutputSection view={capturedOutputView} />

            <section className={wbOverviewSection}>
              <GroupHeader
                label="Tasks"
                meta={`${completedCount}/${totalCount}`}
              />
              <div>
                {tasks.map((task, index) => {
                  const taskState = execution.taskStates[task.id];
                  const isExpanded = expandedTaskId === task.id;
                  const isEditable =
                    !readOnly && isTaskEditable(execution, task.id);
                  const hasConversation = !!taskState?.lastConversationId;
                  const isRunning = isTaskConversationLive(execution, task.id);
                  const isViewing = viewingTaskId === task.id;
                  const hasErrors = !!taskState?.failureMessage;

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
                          "flex cursor-pointer items-center gap-[8px] rounded-sm px-[10px] py-2 transition-[background] duration-150 hover:bg-bg-elevated",
                          hasErrors && "border-l-2 border-l-red",
                          isViewing && "border-l-2 border-l-cyan bg-bg-raised",
                        )}
                        data-testid="wf-task-item"
                        onClick={() => handleExpandTask(task.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleExpandTask(task.id);
                          }
                        }}
                      >
                        <span className="w-4 shrink-0 text-center text-[0.7rem] font-semibold text-text-tertiary">
                          {index + 1}
                        </span>
                        <span className="flex-1 overflow-hidden text-[0.75rem] text-ellipsis whitespace-nowrap text-text-primary">
                          {task.title}
                        </span>
                        {hasConversation && (
                          <button
                            className={cn(
                              "shrink-0 cursor-pointer rounded-[3px] border bg-transparent px-[6px] py-[2px] font-mono text-[0.65rem] font-semibold tracking-[0.04em] whitespace-nowrap uppercase transition-all duration-150",
                              isRunning
                                ? "border-[var(--cyan-glow-strong)] text-cyan hover:bg-[var(--cc-cyan-a08)]"
                                : "border-border-default text-text-tertiary hover:border-border-strong hover:bg-bg-elevated hover:text-text-secondary",
                            )}
                            onClick={(e) => {
                              e.stopPropagation();
                              onViewTask(task.id);
                            }}
                            type="button"
                          >
                            {isRunning ? "Watch" : "View"}
                          </button>
                        )}
                        {taskState?.failureMessage && (
                          <span className="mr-1 ml-auto h-[6px] w-[6px] shrink-0 rounded-full bg-red" />
                        )}
                        <span
                          className={cn(
                            "h-[6px] w-[6px] shrink-0 rounded-full",
                            taskStatusDotByStatus[
                              getTaskStatusDotClass(taskState?.status)
                            ],
                          )}
                        />
                        <span
                          className={cn(
                            "shrink-0 text-[0.7rem] text-text-tertiary transition-transform duration-150",
                            isExpanded && "rotate-90",
                          )}
                        >
                          ▸
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
                                    [
                                      editInstructionsActionRefs.current.get(
                                        task.id,
                                      ),
                                    ],
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
                                  ▴ Up
                                </button>
                              )}
                              {index < tasks.length - 1 && (
                                <button
                                  className={cn(wbBtn, wbBtnXs, wbBtnDefault)}
                                  onClick={() => handleSwapTask(index, "down")}
                                  disabled={isMutating}
                                  type="button"
                                >
                                  ▾ Down
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
          </TabsContent>

          <TabsContent value="config">
            {readOnly ? (
              <HistoricalContextConfiguration context={context} />
            ) : (
              <ContextConfigTab
                key={contextId}
                execution={execution}
                contextId={contextId}
                onSaveContextConfig={onSaveContextConfig}
                libraryProjectName={libraryProjectName}
                {...(onResetAssignment ? { onResetAssignment } : {})}
                resettingAssignmentId={resettingAssignmentId}
                onPauseExecution={onPauseExecution}
                onResumeExecution={onResumeExecution}
                isSaving={isSavingConfig}
                isPausing={isPausingExecution}
                isResuming={isResumingExecution}
                editConflict={configEditConflict}
                editError={configEditError}
                saveSucceeded={configSaveSucceeded}
                commandOptions={commandOptions}
              />
            )}
          </TabsContent>

          <TabsContent value="history">
            <section className={wbOverviewSection}>
              <GroupHeader label="Events" />
              <WorkflowEventLog
                execution={execution}
                events={events}
                contextId={contextId}
                onSelectContext={onSelectContext}
              />
            </section>
            {cohortRoundView && (
              <section
                className={cn(
                  wbOverviewSection,
                  liveRoundFocused && focusedRoundClass,
                )}
                data-testid="cohort-round"
                data-round-seq={cohortRoundView.seq}
                {...(liveRoundFocused
                  ? focusedRoundAttrs(focusedRoundAnchorId)
                  : {})}
              >
                <GroupHeader
                  label="Validation Round"
                  meta={`#${cohortRoundView.seq}`}
                />
                <CohortRoundCard
                  view={cohortRoundView}
                  {...(onViewConversation
                    ? {
                        onOpenTranscript: (member: CohortMemberView) => {
                          if (member.conversationId === null) return;
                          onViewConversation(
                            member.conversationId,
                            "context_validator",
                            contextId,
                            assignmentTranscriptLabel(member.assignmentId),
                          );
                        },
                      }
                    : {})}
                />
              </section>
            )}
            {unlistedFocusRound && (
              <section
                className={cn(wbOverviewSection, focusedRoundClass)}
                data-testid="linked-round"
                data-round-seq={unlistedFocusRound.seq}
                {...focusedRoundAttrs(focusedRoundAnchorId)}
              >
                <GroupHeader
                  label="Linked Round"
                  meta={`#${unlistedFocusRound.seq}`}
                />
                <div className={wbExecEvent}>
                  <div className={wbExecEventHeader}>
                    <span className={wbExecEventText}>
                      {unlistedFocusRound.record === null
                        ? `Round ${unlistedFocusRound.seq} left no record in this context's history.`
                        : `Round ${unlistedFocusRound.seq} was retired when this context was reset, so it is not part of the current attempt below.`}
                    </span>
                  </div>
                </div>
                {unlistedFocusRound.record !== null && (
                  <ValidationCard
                    event={unlistedFocusRound.record}
                    cohortAssignments={cohortAssignments}
                    onViewConversation={onViewConversation}
                  />
                )}
              </section>
            )}
            <section className={wbOverviewSection}>
              <GroupHeader label="Validations" />
              {history.validationEvents.length > 0 ? (
                (() => {
                  const reused = computeReusedSessions(
                    history.validationEvents,
                  );
                  return history.validationEvents.map((event, index) => (
                    <ValidationCard
                      key={`val-${index}`}
                      event={event}
                      cohortAssignments={cohortAssignments}
                      isReusedSession={reused.has(index)}
                      onViewConversation={onViewConversation}
                      {...(index === focusedValidationIndex
                        ? { focusAnchorId: focusedRoundAnchorId }
                        : {})}
                    />
                  ));
                })()
              ) : (
                <div className={wbExecEvent}>
                  <div className={wbExecEventHeader}>
                    <span className={wbExecEventText}>No validations yet</span>
                  </div>
                </div>
              )}
            </section>

            {history.circuitBreakerEvents.length > 0 && (
              <section className={wbOverviewSection}>
                <GroupHeader label="Circuit Breakers" />
                {history.circuitBreakerEvents.map((event, index) => (
                  <div key={`cb-${index}`} className={wbExecEvent}>
                    <div className={wbExecEventHeader}>
                      <span className={wbExecEventDotBreaker} />
                      <span className={wbExecEventText}>
                        {event.failureCount} failures ({event.condition})
                      </span>
                      <span className={wbExecEventTimestamp}>
                        {formatTimestamp(event.occurredAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </section>
            )}
          </TabsContent>
        </div>
      </TabsRoot>
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
            ? context.acceptanceCriteria
            : (context.description ?? "")
        }
      />
      <ConfirmDialog
        open={resetConfirmOpen}
        title="Reset context?"
        message="Clear implementer and validator conversations, unmark completed tasks, and reset runtime state for this context. The workflow will remain paused until you resume it."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          setResetConfirmOpen(false);
          onResetContext?.(contextId);
        }}
        onCancel={() => setResetConfirmOpen(false)}
      />
    </aside>
  );
}

// ---- Main Component ----

export default function ExecutionInspectorPanel({
  execution,
  events,
  loopLedger,
  selectedContextId,
  userInputPanels,
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
  commandOptions,
  readOnly = false,
}: ExecutionInspectorPanelProps) {
  const selectedContext = selectedContextId
    ? execution.workingDefinition.executionContexts.find(
        (ctx) => ctx.id === selectedContextId,
      )
    : null;

  if (!selectedContext || !selectedContextId) {
    return (
      <OverviewView
        execution={execution}
        events={events}
        loopLedger={loopLedger}
        onSelectContext={onSelectContext}
        {...(onOpenAdvisoryOrigin !== undefined
          ? { onOpenAdvisoryOrigin }
          : {})}
        {...(!readOnly && onEditSchema !== undefined ? { onEditSchema } : {})}
        onViewConversation={onViewConversation}
      />
    );
  }

  return (
    <DetailView
      execution={execution}
      events={events}
      contextId={selectedContextId}
      userInputPanels={userInputPanels}
      onSelectContext={onSelectContext}
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
