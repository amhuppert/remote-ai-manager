import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionOrigin,
} from "@/lib/workflow-graph/schemas";
import { deriveExecutionLaneBands } from "@/lib/workflow-graph/lane-bands";
import { deriveLoopLedger } from "@/lib/workflow-graph/loop-ledger";
import { deriveApprovalHistory } from "../approval-history";
import { deriveExecutionGates } from "@/lib/workflow-graph/execution-gates";

/**
 * The Overview surface's vocabulary (design README §11, screen E3).
 *
 * Everything the "nothing selected" surface says — the launch card, the shape
 * counts and each drill row's summary — is derived here, so the numbers and the
 * copy can be pinned without a DOM. The surface component owns layout only.
 */

export type OverviewRowId =
  | "gates"
  | "advisories"
  | "loop-ledger"
  | "expansion-ledger"
  | "approvals"
  | "documents"
  | "events";

export interface OverviewRow {
  id: OverviewRowId;
  label: string;
  summary: string;
  /** Amber marks a row that is waiting on the human. */
  tone: "neutral" | "amber";
}

export interface OverviewLaunchCard {
  revisionLabel: string;
  /** The seed definition's identity — `workflow-1@12`. */
  seedLabel: string;
  /** This run's own id. */
  runLabel: string;
  originLabel: string;
  inputs: readonly { name: string; value: string }[];
  /** Present only while a saved draft has moved past the launched revision. */
  draftNote: string | null;
}

export interface OverviewShapeCard {
  contexts: number;
  tasks: number;
  edges: number;
  joins: number;
  lanes: number;
  label: string;
}

export interface OverviewSummary {
  launch: OverviewLaunchCard;
  shape: OverviewShapeCard;
  rows: readonly OverviewRow[];
}

export interface OverviewSummaryInput {
  execution: GraphWorkflowExecution;
  events: readonly GraphWorkflowExecutionEvent[];
  /**
   * The saved template's current revision, when the host knows one. A run is
   * launched from an immutable snapshot, so a draft that has moved on is the
   * one fact the overview must state rather than let a reader assume.
   */
  draftRevision?: number | null;
}

function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

function originLabel(origin: GraphWorkflowExecutionOrigin): string {
  switch (origin.kind) {
    case "template":
      return `template ${origin.definitionId}`;
    case "one_off":
      return `one-off ${origin.planName}`;
    case "spec_delivery":
      return `spec ${origin.specSlug}`;
  }
}

function launchCard(input: OverviewSummaryInput): OverviewLaunchCard {
  const { execution, draftRevision } = input;
  const launched = execution.seedDefinitionRevision;
  return {
    revisionLabel: `definition r${launched}`,
    seedLabel: `${execution.seedDefinitionId}@${launched}`,
    runLabel: execution.id,
    originLabel: originLabel(execution.origin),
    inputs: Object.entries(execution.boundInputs).map(([name, value]) => ({
      name,
      value,
    })),
    draftNote:
      draftRevision != null && draftRevision !== launched
        ? `The builder draft is r${draftRevision}. Saved edits do not reach this run.`
        : null,
  };
}

function shapeCard(execution: GraphWorkflowExecution): OverviewShapeCard {
  const definition = execution.workingDefinition;
  const counts = {
    contexts: definition.executionContexts.length,
    tasks: definition.tasks.length,
    edges: definition.edges.length,
    joins: Object.keys(execution.joins).length,
    lanes: deriveExecutionLaneBands(execution).length,
  };
  return {
    ...counts,
    label: [
      plural(counts.contexts, "context"),
      plural(counts.tasks, "task"),
      plural(counts.edges, "edge"),
      plural(counts.joins, "join"),
      plural(counts.lanes, "lane"),
    ].join(" · "),
  };
}

function gatesRow(input: OverviewSummaryInput): OverviewRow {
  const gates = deriveExecutionGates(input.execution);
  const approvals = gates.filter((gate) => gate.kind === "approval").length;
  const questions = gates.filter((gate) => gate.kind === "question").length;
  // Counted here too, or the row would read "nothing awaiting you" above a
  // screen holding a join row: this summarises the same derivation the Gates
  // screen renders and the status bar's chip counts. Appended only when there
  // is one, because a healthy run should not be told its joins are fine.
  const joins = gates.filter((gate) => gate.kind === "join").length;
  return {
    id: "gates",
    label: "Gates",
    summary:
      gates.length === 0
        ? "nothing awaiting you"
        : [
            plural(approvals, "context approval"),
            plural(questions, "parked question"),
            ...(joins > 0 ? [plural(joins, "join conflict")] : []),
          ].join(" · "),
    tone: gates.length > 0 ? "amber" : "neutral",
  };
}

function advisoriesRow(execution: GraphWorkflowExecution): OverviewRow {
  const open = execution.advisoryIndex.length;
  // Recertification is a live phase on a context, not an index entry: a seat
  // that answered an advisory is re-reviewing, and the operator reading the
  // index is exactly who needs to know the answer has not landed yet.
  const recertifying = execution.workingDefinition.executionContexts
    .filter(
      (context) =>
        execution.contextStates[context.id]?.advisoryResponse?.phase ===
        "recertifying",
    )
    .map((context) => context.title);
  if (open === 0) {
    return {
      id: "advisories",
      label: "Advisories",
      summary: "none raised",
      tone: "neutral",
    };
  }
  return {
    id: "advisories",
    label: "Advisories",
    summary: [
      `${open} open`,
      recertifying.length === 0
        ? "no recertification pending"
        : `recertifying ${recertifying.join(", ")}`,
    ].join(" · "),
    tone: "neutral",
  };
}

function loopLedgerRow(execution: GraphWorkflowExecution): OverviewRow {
  const entries = deriveLoopLedger({
    loopStates: execution.loopStates,
    // The row states where each loop stands NOW, which lives on the markers.
    // The decision history the drill renders is the paginated reader's job.
    events: [],
    ...(execution.workingDefinition.loopGroups
      ? { loopGroups: execution.workingDefinition.loopGroups }
      : {}),
  });
  const active = entries.filter((entry) => entry.activation === "running");
  const summary =
    entries.length === 0
      ? "no loops in this execution"
      : active.length === 0
        ? `${plural(entries.length, "loop")} · none running`
        : active
            .map((entry) =>
              entry.maxPasses === null
                ? `${entry.loopGroupId} · pass ${entry.passCount}`
                : `${entry.loopGroupId} · pass ${entry.passCount} of ${entry.maxPasses}`,
            )
            .join(" · ");
  return { id: "loop-ledger", label: "Loop ledger", summary, tone: "neutral" };
}

function expansionLedgerRow(execution: GraphWorkflowExecution): OverviewRow {
  const { accepted, refusals } = execution.expansionReceipts;
  return {
    id: "expansion-ledger",
    label: "Expansion ledger",
    summary:
      accepted.length + refusals.length === 0
        ? "no runtime expansion in this execution"
        : `${accepted.length} accepted · ${refusals.length} refused`,
    tone: "neutral",
  };
}

function approvalsRow(input: OverviewSummaryInput): OverviewRow {
  const entries = deriveApprovalHistory(input.execution, input.events);
  const open = deriveExecutionGates(input.execution).filter(
    (gate) => gate.kind === "approval",
  ).length;
  const decided = entries.length;
  return {
    id: "approvals",
    label: "Approvals",
    summary:
      decided === 0 && open === 0
        ? "no approvals recorded"
        : [
            plural(decided, "entry", "entries"),
            `${plural(open, "context approval")} open`,
          ].join(" · "),
    tone: "neutral",
  };
}

function documentsRow(execution: GraphWorkflowExecution): OverviewRow {
  const count = execution.sharedDocuments.length;
  return {
    id: "documents",
    label: "Documents",
    summary: count === 0 ? "none shared" : `${count} shared`,
    tone: "neutral",
  };
}

function eventsRow(
  events: readonly GraphWorkflowExecutionEvent[],
): OverviewRow {
  const trips = events.filter(
    (entry) => entry.event.type === "graph-workflow-circuit-breaker",
  ).length;
  return {
    id: "events",
    label: "Events",
    summary: [
      plural(events.length, "event"),
      plural(trips, "circuit-breaker trip"),
    ].join(" · "),
    tone: "neutral",
  };
}

export function deriveOverviewSummary(
  input: OverviewSummaryInput,
): OverviewSummary {
  const { execution, events } = input;
  return {
    launch: launchCard(input),
    shape: shapeCard(execution),
    rows: [
      gatesRow(input),
      advisoriesRow(execution),
      loopLedgerRow(execution),
      expansionLedgerRow(execution),
      approvalsRow(input),
      documentsRow(execution),
      eventsRow(events),
    ],
  };
}
