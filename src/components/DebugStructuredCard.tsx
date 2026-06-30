"use client";

import type { DebugModePhase } from "@/lib/debug-log/schemas";
import {
  debugEvidenceAnalysisSchema,
  type DebugCleanupResultOutput,
  type DebugEvidenceAnalysisOutput,
  type DebugHypothesisOutput,
} from "@/lib/workflows/conversation/debug-schemas";

interface Props {
  phase: DebugModePhase;
  payload: unknown;
}

const PHASE_LABELS: Record<DebugModePhase, string> = {
  hypothesizing: "Hypotheses",
  awaiting_reproduction: "Awaiting reproduction",
  analyzing_evidence: "Evidence analysis",
  awaiting_verification: "Awaiting verification",
  cleanup_instrumentation: "Cleanup result",
};

// `debug-structured-card` survives as a bare structural hook (no own CSS rule):
// the card's own merge rule (below) and DebugActionCard's adjacency rule reference
// it from the surrounding message DOM. The last-child merge folds the bottom of
// this card into the action card that follows it (legacy session.css adjacency).
const CARD_CLASS =
  "my-md rounded-sm border border-l-[3px] border-solid border-[var(--cc-amber-a20)] border-l-amber bg-[var(--cc-amber-a04)] p-md " +
  "[[data-debug-mode]_.message.assistant:has(.debug-action-card)_.message-content_&:last-child]:mb-0 " +
  "[[data-debug-mode]_.message.assistant:has(.debug-action-card)_.message-content_&:last-child]:rounded-b-none";
const HEADER_CLASS =
  "mb-sm font-mono text-[0.72rem] font-bold uppercase tracking-[0.04em] text-amber";
const SECTION_CLASS = "mt-sm";
const FIELD_LABEL_CLASS =
  "font-mono text-[0.7rem] font-semibold uppercase tracking-[0.04em] text-amber-dim";
const SUMMARY_CLASS = "mt-[4px]";
const CODE_CLASS =
  "rounded-[3px] bg-[var(--amber-glow)] px-[6px] py-px font-mono text-[0.85em] text-amber";
const HYP_LIST_CLASS = "m-0 list-none pl-0";
// The amber row-divider (1px var(--cc-amber-a08) top border, suppressed on the
// first row) and step dividers are token-backed utilities. Same divider for the
// `<ol>` step rows in STEPS_CLASS below. `border-x-0 border-b-0` are required:
// `border-solid` sets border-style on all four edges, and with Preflight off
// nothing resets the un-widthed sides, so they fall back to the CSS default
// `border-width: medium` (~3px) in currentColor — a thick light border around
// every row. Zeroing the other three sides leaves only the intended top divider.
const HYP_CLASS =
  "flex gap-sm border-x-0 border-b-0 border-t border-solid border-t-[var(--cc-amber-a08)] py-[6px] first:border-t-0";
const HYP_ID_CLASS = "flex-[0_0_auto] font-mono font-bold text-amber";
const HYP_BODY_CLASS = "flex-[1_1_auto]";
const HYP_PLAN_CLASS = "mt-[2px] text-[0.9em] opacity-[0.85]";
const STEPS_CLASS =
  "mt-[4px] list-none pl-0 [counter-reset:debug-step] " +
  "[&>li]:relative [&>li]:[counter-increment:debug-step] [&>li]:border-x-0 [&>li]:border-b-0 [&>li]:border-t [&>li]:border-solid [&>li]:border-t-[var(--cc-amber-a08)] [&>li]:py-[6px] [&>li]:pr-0 [&>li]:pl-[2em] [&>li:first-child]:border-t-0 " +
  "[&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:font-mono [&>li]:before:font-semibold [&>li]:before:text-amber [&>li]:before:content-[counter(debug-step)_'.']";
const VERDICTS_CLASS = "mb-sm flex flex-wrap gap-sm";
const VERDICT_CLASS =
  "flex min-w-[100px] flex-col gap-[2px] rounded-[3px] border border-solid border-[var(--amber-glow)] bg-[var(--cc-amber-a04)] px-[10px] py-[6px]";
const VERDICT_LABEL_CLASS =
  "font-mono text-[0.7rem] font-bold uppercase tracking-[0.04em] text-amber-dim";
const VERDICT_IDS_CLASS = "font-mono font-semibold text-amber";
const CHECKS_CLASS = "m-0 list-none pl-0";
const CHECK_CLASS = "group/chk flex items-center gap-sm py-[4px]";
// Icon color follows the parent `[data-ok]`: amber when ok, var(--cc-red-check-fail)
// (#ef4444, distinct from --red) when failed.
const CHECK_ICON_CLASS =
  "inline-block w-[1em] text-center font-mono font-bold group-data-[ok=true]/chk:text-amber group-data-[ok=false]/chk:text-[var(--cc-red-check-fail)]";
const FILES_CLASS = "mt-[4px] list-none pl-0 [&>li]:py-[2px]";
const FALLBACK_CLASS =
  "m-0 whitespace-pre-wrap break-words rounded-[3px] bg-[var(--cc-black-a20)] p-sm font-mono text-[0.85em]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isHypothesisOutput(value: unknown): value is DebugHypothesisOutput {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value["hypotheses"])) return false;
  if (!isStringArray(value["reproductionSteps"])) return false;
  return value["hypotheses"].every(
    (h) =>
      isRecord(h) &&
      typeof h["id"] === "string" &&
      typeof h["description"] === "string" &&
      (h["instrumentationPlan"] === undefined ||
        typeof h["instrumentationPlan"] === "string"),
  );
}

function parseEvidenceAnalysis(
  value: unknown,
): DebugEvidenceAnalysisOutput | null {
  const result = debugEvidenceAnalysisSchema.safeParse(value);
  return result.success ? result.data : null;
}

function isCleanupResult(value: unknown): value is DebugCleanupResultOutput {
  if (!isRecord(value)) return false;
  return (
    typeof value["removedInstrumentation"] === "boolean" &&
    isStringArray(value["filesModified"]) &&
    typeof value["grepVerificationPassed"] === "boolean" &&
    typeof value["acknowledgesManifestDeletionContract"] === "boolean" &&
    typeof value["notes"] === "string"
  );
}

function HypothesisCard({
  payload,
}: {
  payload: DebugHypothesisOutput;
}): React.JSX.Element {
  return (
    <>
      <ul className={HYP_LIST_CLASS}>
        {payload.hypotheses.map((h) => (
          <li key={h.id} className={HYP_CLASS}>
            <span className={HYP_ID_CLASS}>{h.id}</span>
            <div className={HYP_BODY_CLASS}>
              <div>{h.description}</div>
              {h.instrumentationPlan && (
                <div className={HYP_PLAN_CLASS}>
                  <span className={FIELD_LABEL_CLASS}>Instrument:</span>{" "}
                  {h.instrumentationPlan}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className={SECTION_CLASS}>
        <div className={FIELD_LABEL_CLASS}>Reproduction steps</div>
        <ol className={STEPS_CLASS}>
          {payload.reproductionSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>
    </>
  );
}

function EvidenceCard({
  payload,
}: {
  payload: DebugEvidenceAnalysisOutput;
}): React.JSX.Element {
  return (
    <>
      <div className={VERDICTS_CLASS}>
        <div className={VERDICT_CLASS}>
          <span className={VERDICT_LABEL_CLASS}>Supported</span>
          <span className={VERDICT_IDS_CLASS}>
            {payload.supportedHypotheses.length > 0
              ? payload.supportedHypotheses.join(", ")
              : "—"}
          </span>
        </div>
        <div className={VERDICT_CLASS}>
          <span className={VERDICT_LABEL_CLASS}>Refuted</span>
          <span className={VERDICT_IDS_CLASS}>
            {payload.refutedHypotheses.length > 0
              ? payload.refutedHypotheses.join(", ")
              : "—"}
          </span>
        </div>
        <div className={VERDICT_CLASS}>
          <span className={VERDICT_LABEL_CLASS}>Inconclusive</span>
          <span className={VERDICT_IDS_CLASS}>
            {payload.inconclusiveHypotheses.length > 0
              ? payload.inconclusiveHypotheses.join(", ")
              : "—"}
          </span>
        </div>
      </div>
      <div className={SECTION_CLASS}>
        <span className={FIELD_LABEL_CLASS}>Outcome:</span>{" "}
        <code className={CODE_CLASS}>{payload.outcome}</code>
      </div>
      <div className={SECTION_CLASS}>
        <div className={FIELD_LABEL_CLASS}>Summary</div>
        <p className={SUMMARY_CLASS}>{payload.evidenceSummary}</p>
      </div>
      {payload.outcome === "fix_applied" && (
        <>
          <div className={SECTION_CLASS}>
            <div className={FIELD_LABEL_CLASS}>Fix summary</div>
            <p className={SUMMARY_CLASS}>{payload.fixSummary}</p>
          </div>
          <div className={SECTION_CLASS}>
            <div className={FIELD_LABEL_CLASS}>Verification steps</div>
            <ol className={STEPS_CLASS}>
              {payload.verificationSteps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        </>
      )}
      {payload.outcome === "more_instrumentation" && (
        <>
          <div className={SECTION_CLASS}>
            <div className={FIELD_LABEL_CLASS}>Next hypotheses</div>
            <ul className={HYP_LIST_CLASS}>
              {payload.hypotheses.map((h) => (
                <li key={h.id} className={HYP_CLASS}>
                  <span className={HYP_ID_CLASS}>{h.id}</span>
                  <div className={HYP_BODY_CLASS}>
                    <div>{h.description}</div>
                    <div className={HYP_PLAN_CLASS}>
                      <span className={FIELD_LABEL_CLASS}>Instrument:</span>{" "}
                      {h.instrumentationPlan}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className={SECTION_CLASS}>
            <div className={FIELD_LABEL_CLASS}>Reproduction steps</div>
            <ol className={STEPS_CLASS}>
              {payload.reproductionSteps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        </>
      )}
    </>
  );
}

function CleanupCard({
  payload,
}: {
  payload: DebugCleanupResultOutput;
}): React.JSX.Element {
  const checkmark = (ok: boolean): string => (ok ? "✓" : "✕");

  return (
    <>
      <ul className={CHECKS_CLASS}>
        <li className={CHECK_CLASS} data-ok={payload.removedInstrumentation}>
          <span className={CHECK_ICON_CLASS}>
            {checkmark(payload.removedInstrumentation)}
          </span>
          Instrumentation removed
        </li>
        <li className={CHECK_CLASS} data-ok={payload.grepVerificationPassed}>
          <span className={CHECK_ICON_CLASS}>
            {checkmark(payload.grepVerificationPassed)}
          </span>
          Grep verification passed
        </li>
        <li
          className={CHECK_CLASS}
          data-ok={payload.acknowledgesManifestDeletionContract}
        >
          <span className={CHECK_ICON_CLASS}>
            {checkmark(payload.acknowledgesManifestDeletionContract)}
          </span>
          Manifest deletion contract acknowledged
        </li>
      </ul>
      {payload.filesModified.length > 0 && (
        <div className={SECTION_CLASS}>
          <div className={FIELD_LABEL_CLASS}>Files modified</div>
          <ul className={FILES_CLASS}>
            {payload.filesModified.map((file) => (
              <li key={file}>
                <code className={CODE_CLASS}>{file}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {payload.notes && (
        <div className={SECTION_CLASS}>
          <div className={FIELD_LABEL_CLASS}>Notes</div>
          <p className={SUMMARY_CLASS}>{payload.notes}</p>
        </div>
      )}
    </>
  );
}

function FallbackCard({ payload }: { payload: unknown }): React.JSX.Element {
  return (
    <pre className={FALLBACK_CLASS}>{JSON.stringify(payload, null, 2)}</pre>
  );
}

export default function DebugStructuredCard({
  phase,
  payload,
}: Props): React.JSX.Element {
  let body: React.JSX.Element;

  if (phase === "hypothesizing" && isHypothesisOutput(payload)) {
    body = <HypothesisCard payload={payload} />;
  } else if (phase === "analyzing_evidence") {
    const evidence = parseEvidenceAnalysis(payload);
    body = evidence ? (
      <EvidenceCard payload={evidence} />
    ) : (
      <FallbackCard payload={payload} />
    );
  } else if (phase === "cleanup_instrumentation" && isCleanupResult(payload)) {
    body = <CleanupCard payload={payload} />;
  } else {
    body = <FallbackCard payload={payload} />;
  }

  return (
    <div
      className={`debug-structured-card ${CARD_CLASS}`}
      data-testid="debug-structured-card"
      data-phase={phase}
    >
      <div className={HEADER_CLASS}>{PHASE_LABELS[phase]}</div>
      <div>{body}</div>
    </div>
  );
}
