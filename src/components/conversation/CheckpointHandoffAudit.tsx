"use client";

import type { ReactNode } from "react";
import { ChatIcon } from "@/components/icons";
import { StatusChip } from "@/components/ui/StatusChip";
import type { CheckpointReceipt } from "@/lib/conversation-checkpoints/receipt";
import CheckpointDisclosure from "./CheckpointDisclosure";

const ROW =
  "m-0 font-mono text-[0.72rem] leading-[1.6] text-text-secondary [overflow-wrap:anywhere]";
const CATEGORIES = [
  ["plan", "Plan"],
  ["hypotheses", "Hypotheses"],
  ["failedApproaches", "Failed approaches"],
  ["blockers", "Blockers"],
  ["nextStep", "Next step"],
] as const;
const available = (value: string | number | null | undefined) =>
  value ?? "Unavailable";
const modeLabel = (mode: string | null) =>
  mode === "tool-disabled"
    ? "Tool-disabled"
    : mode === "instruction-only"
      ? "Instruction-only"
      : "Unavailable";

/** Public receipt metadata only; audit viewers remain read-only children. */
export default function CheckpointHandoffAudit({
  receipt,
  children,
}: {
  receipt: CheckpointReceipt;
  children?: ReactNode;
}): React.JSX.Element {
  const handoff = receipt.handoff;
  if (!handoff) return <p className={ROW}>Handoff not requested</p>;
  const included = handoff.stage === "included";
  const omitted = handoff.stage === "omitted";
  const outcome = included
    ? "Handoff included"
    : omitted
      ? "Handoff omitted"
      : "Handoff in progress";
  const usage = handoff.usage;
  const coverage = handoff.sourceCoverage;
  return (
    <div className="flex min-w-0 flex-col gap-sm">
      <div className="flex flex-wrap items-center gap-sm">
        <StatusChip tone={included ? "green" : "neutral"} appearance="flat">
          {outcome}
        </StatusChip>
        {handoff.omissionReason && (
          <span className={ROW}>
            {handoff.omissionReason.replaceAll("_", " ")}
          </span>
        )}
      </div>
      <CheckpointDisclosure
        title="Agent handoff — advisory"
        description="Capture outcome, coverage and usage. Agent claims do not establish approval, validation or completion."
        icon={<ChatIcon size={16} />}
        operationId={receipt.operationId}
      >
        <div className="flex min-w-0 flex-col gap-md">
          <p className={ROW}>
            {included
              ? "Included in the frozen checkpoint as advisory working state."
              : omitted
                ? "Audit only. This handoff is omitted from the frozen checkpoint."
                : "Capture has not been included in a frozen checkpoint."}
          </p>
          <div className="flex flex-col gap-xs">
            <p className={ROW}>
              Requested mode: {modeLabel(handoff.requestedMode)}
            </p>
            <p className={ROW}>
              Established mode:{" "}
              {handoff.modeEstablished
                ? modeLabel(handoff.requestedMode)
                : "Not established"}
            </p>
            {handoff.requestedMode === "instruction-only" && (
              <p className={ROW}>
                Instruction-only: the agent is asked not to use tools. Tools
                remain available.
              </p>
            )}
            {handoff.requestedMode === "tool-disabled" && (
              <p className={ROW}>
                {handoff.modeEstablished
                  ? "Tools were disabled for the handoff."
                  : "Tool-disabled capture was requested; disabling tools has not been established."}
              </p>
            )}
            <p className={ROW}>
              Agent: {handoff.backend} · {handoff.modelSelection.modelId}
            </p>
            <p className={ROW}>Requested: {handoff.requestedAt}</p>
            <p className={ROW}>Started: {available(handoff.startedAt)}</p>
            <p className={ROW}>Settled: {available(handoff.settledAt)}</p>
            <p className={ROW}>Finalized: {available(handoff.finalizedAt)}</p>
          </div>
          <div className="flex flex-col gap-xs">
            <p className={ROW}>Categories in the checkpoint</p>
            {handoff.categoryCounts === null ? (
              <p className={ROW}>
                Category counts unavailable; no counts inferred from an
                unvalidated response.
              </p>
            ) : (
              CATEGORIES.map(([key, label]) => (
                <p className={ROW} key={key}>
                  {label}:{" "}
                  {included
                    ? `${handoff.categoryCounts?.[key]} retained, 0 omitted`
                    : omitted
                      ? `0 retained, ${handoff.categoryCounts?.[key]} omitted`
                      : `${handoff.categoryCounts?.[key]} observed; retention pending`}
                </p>
              ))
            )}
          </div>
          <div className="flex flex-col gap-xs">
            <p className={ROW}>
              Content hash: {available(handoff.contentHash)}
            </p>
            <p className={ROW}>
              Accepted output:{" "}
              {handoff.acceptedOutputBytes === null
                ? "Unavailable"
                : `${handoff.acceptedOutputBytes} bytes`}
            </p>
            <p className={ROW}>
              Source coverage:{" "}
              {coverage
                ? `seq ${coverage.seqStart}–${coverage.seqEnd}`
                : "Unavailable"}
            </p>
            {coverage && (
              <details className={ROW}>
                <summary className="cursor-pointer text-cyan">
                  Archive entry IDs ({coverage.entryIds.length})
                </summary>
                <pre className="max-h-[160px] overflow-auto [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {coverage.entryIds.join("\n")}
                </pre>
              </details>
            )}
            <p className={ROW}>
              Admission boundary: seq{" "}
              {handoff.admissionSourceBasis.capturedThroughSeq} ·{" "}
              {handoff.admissionSourceBasis.sourceHash}
            </p>
            {handoff.finalSourceBasis && (
              <p className={ROW}>
                Final boundary: seq{" "}
                {handoff.finalSourceBasis.capturedThroughSeq} ·{" "}
                {handoff.finalSourceBasis.sourceHash}
              </p>
            )}
            <p className={ROW}>
              Transport coverage: {available(handoff.activity?.transport)}
            </p>
            <p className={ROW}>
              Native coverage: {available(handoff.activity?.native)}
            </p>
            <p className={ROW}>
              Prohibited activity:{" "}
              {handoff.activity?.prohibited === "not_observed"
                ? "Not observed in inspected coverage"
                : available(handoff.activity?.prohibited)}
            </p>
            <p className={ROW}>
              Inspected activity bytes:{" "}
              {available(handoff.activity?.inspectedBytes)}
            </p>
          </div>
          <div className="flex flex-col gap-xs">
            <p className={ROW}>
              Capture usage only — separate from checkpoint generation and
              ordinary turns.
            </p>
            {!usage ? (
              <p className={ROW}>Capture usage unavailable</p>
            ) : (
              <>
                <p className={ROW}>
                  Input tokens: {available(usage.inputTokens)} · cached input:{" "}
                  {available(usage.cachedInputTokens)} · output:{" "}
                  {available(usage.outputTokens)}
                </p>
                <p className={ROW}>
                  Cost:{" "}
                  {usage.costUsd === null
                    ? "Unavailable"
                    : `${usage.costUsd} USD (${usage.costBasis === "pricing_estimate" ? "pricing estimate" : "provider reported"})`}
                </p>
                <p className={ROW}>
                  Execution:{" "}
                  {usage.executionMs === null
                    ? "Unavailable"
                    : `${usage.executionMs} ms`}{" "}
                  · settlement:{" "}
                  {usage.settlementMs === null
                    ? "Unavailable"
                    : `${usage.settlementMs} ms`}
                </p>
              </>
            )}
          </div>
          {children}
        </div>
      </CheckpointDisclosure>
    </div>
  );
}
