"use client";

import { useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/ui/cn";
import ContextHaltCard from "@/components/workflow-graph/ContextHaltCard";
import { deriveOutputSchemaHaltEvidenceByContext } from "@/components/workflow-graph/derive-output-schema-halt";
import WorkflowEventLog from "@/components/workflow-graph/WorkflowEventLog";
import type { GraphWorkflowExecutionEvent } from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowBoundaryResultProjection } from "@/lib/workflow-graph/execution-result-projection";
import { isTerminalStatus } from "@/lib/workflow-graph/lifecycle-classifier";
import AdvisoryIndexPanel, { type AdvisoryOrigin } from "../AdvisoryIndexPanel";
import { deriveApprovalHistory } from "../approval-history";
import WorkflowApprovalHistory from "../WorkflowApprovalHistory";
import {
  InspectorBody,
  InspectorCard,
  InspectorDrillRow,
  InspectorRail,
  InspectorScreen,
  formatInspectorTimestamp,
  inspectorMetaTextClass,
} from "./chrome";
import { deriveExecutionGates } from "./gates-model";
import GatesList from "./GatesList";
import { useInspectorNavigation } from "./InspectorNavigationContext";
import { GATE_CONTEXT, LANE_RUNTIME } from "./navigation";
import { getHistoryEntries } from "./history-entries";
import {
  deriveOverviewSummary,
  type OverviewRowId,
  type OverviewSummary,
} from "./overview-model";

/**
 * The Overview — what the inspector shows when nothing is selected (E3).
 *
 * Two stated cards (Launch, Shape), one row per drillable destination in the
 * README §11 relocation map, and the durable Result. The rows are a push
 * navigation: each fills the rail and carries a back row naming its parent,
 * the same idiom the config panel's drill uses.
 */

const rowClass =
  "border-x-0 border-t-0 border-b border-solid border-border-dim py-2 last:border-b-0";
const rowHeaderClass = "flex items-center gap-[8px] text-[0.72rem]";
const rowTextClass = "text-text-secondary flex-1 min-w-0";
const rowDetailClass =
  "text-[0.7rem] text-text-tertiary mt-1 pl-[14px] leading-[1.4]";
const rowTimestampClass =
  "text-[0.7rem] text-text-tertiary whitespace-nowrap shrink-0 ml-auto";

export interface OverviewSurfaceProps {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
  /**
   * The loop-ledger view, injected as a slot (D4 R16.2). The ledger reads the
   * cursor-paginated event history, which is a data fetch — the container owns
   * it so this surface stays presentational.
   */
  loopLedger?: ReactNode;
  /** The durable boundary result of a terminal run, when the host has one. */
  result?: GraphWorkflowBoundaryResultProjection | null;
  /** The saved template's revision, so a moved-on draft can be called out. */
  draftRevision?: number | null;
  /**
   * A host's request to open one of the drill screens — the status bar's gates
   * chip is the first. `seq` distinguishes a repeat ask from a re-render of the
   * previous one, so the reader keeps whatever they navigated to afterwards.
   */
  screenRequest?: { screen: OverviewRowId; seq: number } | null;
  onSelectContext?: (contextId: string) => void;
  onOpenAdvisoryOrigin?: (origin: AdvisoryOrigin) => void;
  onEditSchema?: (contextId: string) => void;
}

function formatResultOutputValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "—";
}

function LaunchCard({
  summary,
  liveRevision,
}: {
  summary: OverviewSummary;
  liveRevision: number;
}): React.JSX.Element {
  const { launch } = summary;
  return (
    <InspectorCard label="Launch" testId="overview-launch">
      <span className={inspectorMetaTextClass}>
        <span data-testid="overview-launch-revision">
          {launch.revisionLabel}
        </span>{" "}
        · immutable snapshot
        <br />
        seed <span data-testid="overview-seed">{launch.seedLabel}</span> ·{" "}
        <span data-testid="overview-run">{launch.runLabel}</span> ·{" "}
        <span data-testid="overview-live-revision">liveRev {liveRevision}</span>
        <br />
        origin: {launch.originLabel}
      </span>
      {launch.inputs.length > 0 ? (
        <span
          className="font-mono text-[0.7rem] leading-[1.6] text-text-tertiary"
          data-testid="overview-launch-inputs"
        >
          inputs:{" "}
          {launch.inputs.map((input, index) => (
            <span key={input.name}>
              {index > 0 ? " · " : ""}
              <span>{input.name}</span>=<span>{input.value}</span>
            </span>
          ))}
        </span>
      ) : null}
      {launch.draftNote !== null ? (
        <span
          className="font-mono text-[0.7rem] text-text-tertiary"
          data-testid="overview-draft-note"
        >
          {launch.draftNote}
        </span>
      ) : null}
    </InspectorCard>
  );
}

function ResultCard({
  execution,
  result,
}: {
  execution: GraphWorkflowExecution;
  result: GraphWorkflowBoundaryResultProjection | null;
}): React.JSX.Element {
  if (result === null) {
    return (
      <InspectorCard label="Result" testId="overview-result">
        <span className="font-mono text-[0.72rem] text-text-tertiary">
          {isTerminalStatus(execution.status)
            ? "This run recorded no durable boundary result."
            : "Durable result appears when the run reaches a terminal state."}
        </span>
      </InspectorCard>
    );
  }
  return (
    <InspectorCard label="Result" testId="overview-result">
      <span className={inspectorMetaTextClass}>
        {result.boundaryKind} · {result.status}
      </span>
      {result.outputs.kind === "declared_outputs" ? (
        Object.entries(result.outputs.byContext).flatMap(
          ([contextId, outputs]) =>
            Object.entries(outputs).map(([outputName, value]) => (
              <span
                key={`${contextId}:${outputName}`}
                className="font-mono text-[0.7rem] break-all text-text-secondary"
              >
                <span>
                  {contextId}.{outputName}
                </span>{" "}
                <span className="text-text-primary">
                  {formatResultOutputValue(value)}
                </span>
              </span>
            )),
        )
      ) : (
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          No declared structured result
        </span>
      )}
    </InspectorCard>
  );
}

function GatesScreen({
  execution,
}: {
  execution: GraphWorkflowExecution;
}): React.JSX.Element {
  const navigation = useInspectorNavigation();
  const gates = deriveExecutionGates(execution);
  return (
    <GatesList
      gates={gates}
      // An approval and a parked question are both answered on the context
      // itself — the approval surface and the answering surface sit above its
      // tabs — so those rows open the context through the one navigation handle
      // every deep link uses. A join conflict is resolved in the blocked
      // member's lane instead, so it lands on the same Placement screen the
      // join card's own recovery actions use. A row with no context to open is
      // not rendered as a control, so `contextId` is non-null here.
      onOpenGate={(gate) => {
        if (gate.contextId === null) return;
        navigation.openContext(
          gate.contextId,
          gate.kind === "join" ? LANE_RUNTIME : GATE_CONTEXT,
        );
      }}
    />
  );
}

function ExpansionLedgerScreen({
  receipts,
}: {
  receipts: GraphWorkflowExecution["expansionReceipts"];
}): React.JSX.Element {
  if (receipts.accepted.length === 0 && receipts.refusals.length === 0) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        No runtime expansion in this execution.
      </p>
    );
  }
  return (
    <div data-testid="expansion-ledger">
      {receipts.accepted.map((receipt) => (
        <div
          key={`accepted-${receipt.requestId}`}
          className={rowClass}
          data-testid="expansion-accepted-row"
        >
          <div className={rowHeaderClass}>
            <span className={rowTextClass}>{receipt.rationale}</span>
            <span className={rowTimestampClass}>
              {formatInspectorTimestamp(receipt.acceptedAt)}
            </span>
          </div>
          <div className={cn(rowDetailClass, "font-mono")}>
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
          className={rowClass}
          data-testid="expansion-refusal-row"
        >
          <div className={rowHeaderClass}>
            <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-red shadow-[0_0_0_1px_var(--cc-red-a40),0_0_6px_var(--cc-red-a50)]" />
            <span className={rowTextClass}>{receipt.refusalCode}</span>
            <span className={rowTimestampClass}>
              {formatInspectorTimestamp(receipt.refusedAt)}
            </span>
          </div>
          <div className={cn(rowDetailClass, "font-mono")}>
            {receipt.invokerContextId} · request {receipt.requestId}
          </div>
        </div>
      ))}
    </div>
  );
}

function ApprovalsScreen({
  execution,
  events,
}: {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
}): React.JSX.Element {
  if (deriveApprovalHistory(execution, events).length === 0) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        No approval has been requested on this run.
      </p>
    );
  }
  return <WorkflowApprovalHistory execution={execution} events={events} />;
}

function DocumentsScreen({
  documents,
}: {
  documents: GraphWorkflowExecution["sharedDocuments"];
}): React.JSX.Element {
  if (documents.length === 0) {
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        No agent has shared a document on this run.
      </p>
    );
  }
  return (
    <div data-testid="overview-documents">
      {documents.map((doc) => (
        <div key={doc.id} className={rowClass}>
          <div className={rowHeaderClass}>
            <span className={rowTextClass}>{doc.description}</span>
          </div>
          <div className={rowDetailClass}>{doc.relativePath}</div>
        </div>
      ))}
    </div>
  );
}

export default function OverviewSurface({
  execution,
  events,
  loopLedger,
  result = null,
  draftRevision = null,
  screenRequest = null,
  onSelectContext,
  onOpenAdvisoryOrigin,
  onEditSchema,
}: OverviewSurfaceProps): React.JSX.Element {
  const [screen, setScreen] = useState<OverviewRowId | null>(null);
  const [honouredRequestSeq, setHonouredRequestSeq] = useState<number | null>(
    null,
  );

  // Adjusted during render rather than in an effect: the requested screen is
  // the first thing the reader should see, and honouring the seq once leaves
  // them free to navigate away without the request pulling them back.
  if (screenRequest !== null && screenRequest.seq !== honouredRequestSeq) {
    setHonouredRequestSeq(screenRequest.seq);
    setScreen(screenRequest.screen);
  }

  const summary = useMemo(
    () => deriveOverviewSummary({ execution, events, draftRevision }),
    [execution, events, draftRevision],
  );

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
        validationEvents: getHistoryEntries(events).validationEvents,
      }),
    [execution, events],
  );

  const screenTitle =
    summary.rows.find((row) => row.id === screen)?.label ?? "";

  return (
    <InspectorRail>
      <header className="flex min-h-[44px] shrink-0 flex-col gap-[2px] border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-3">
        <span className="text-[0.72rem] font-semibold tracking-[0.08em] text-text-primary uppercase">
          Overview
        </span>
        <span className="font-mono text-[0.7rem] text-text-tertiary">
          nothing selected · {execution.id}
        </span>
      </header>
      <InspectorBody>
        {screen !== null ? (
          <InspectorScreen
            title={screenTitle}
            parentLabel="Overview"
            onBack={() => setScreen(null)}
          >
            {screen === "gates" ? <GatesScreen execution={execution} /> : null}
            {screen === "advisories" ? (
              execution.advisoryIndex.length === 0 ? (
                <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
                  No advisory has been raised on this run.
                </p>
              ) : (
                <AdvisoryIndexPanel
                  index={execution.advisoryIndex}
                  contextTitles={contextTitles}
                  {...(onOpenAdvisoryOrigin !== undefined
                    ? { onOpenOrigin: onOpenAdvisoryOrigin }
                    : {})}
                />
              )
            ) : null}
            {screen === "loop-ledger"
              ? (loopLedger ?? (
                  <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
                    This execution declares no loops.
                  </p>
                ))
              : null}
            {screen === "expansion-ledger" ? (
              <ExpansionLedgerScreen receipts={execution.expansionReceipts} />
            ) : null}
            {screen === "approvals" ? (
              <ApprovalsScreen execution={execution} events={events} />
            ) : null}
            {screen === "documents" ? (
              <DocumentsScreen documents={execution.sharedDocuments} />
            ) : null}
            {screen === "events" ? (
              <WorkflowEventLog
                execution={execution}
                events={events}
                onSelectContext={onSelectContext}
              />
            ) : null}
          </InspectorScreen>
        ) : (
          <>
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
                className="mb-sm text-[0.72rem] leading-snug text-text-secondary"
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

            <LaunchCard
              summary={summary}
              liveRevision={execution.liveRevision}
            />

            <InspectorCard label="Shape" testId="overview-shape">
              <span className={inspectorMetaTextClass}>
                {summary.shape.label}
              </span>
            </InspectorCard>

            {summary.rows.map((row) => (
              <InspectorDrillRow
                key={row.id}
                label={row.label}
                summary={row.summary}
                tone={row.tone}
                testId={`overview-row-${row.id}`}
                onOpen={() => setScreen(row.id)}
              />
            ))}

            <ResultCard execution={execution} result={result} />
          </>
        )}
      </InspectorBody>
    </InspectorRail>
  );
}
