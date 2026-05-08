"use client";

import type { DebugModePhase } from "@/types";
import type {
  DebugCleanupResultOutput,
  DebugEvidenceAnalysisOutput,
  DebugFixResultOutput,
  DebugHypothesisOutput,
} from "@/lib/workflows/conversation/debug-schemas";

interface Props {
  phase: DebugModePhase;
  payload: unknown;
}

const PHASE_LABELS: Record<DebugModePhase, string> = {
  hypothesizing: "Hypotheses",
  awaiting_reproduction: "Awaiting reproduction",
  analyzing_evidence: "Evidence analysis",
  fixing: "Fix proposal",
  awaiting_verification: "Awaiting verification",
  cleanup_instrumentation: "Cleanup result",
};

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

function isEvidenceAnalysis(
  value: unknown,
): value is DebugEvidenceAnalysisOutput {
  if (!isRecord(value)) return false;
  return (
    isStringArray(value["supportedHypotheses"]) &&
    isStringArray(value["refutedHypotheses"]) &&
    isStringArray(value["inconclusiveHypotheses"]) &&
    typeof value["recommendedNextStep"] === "string" &&
    typeof value["evidenceSummary"] === "string"
  );
}

function isFixResult(value: unknown): value is DebugFixResultOutput {
  if (!isRecord(value)) return false;
  return (
    typeof value["fixSummary"] === "string" &&
    isStringArray(value["verificationSteps"])
  );
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
      <ul className="debug-structured-card__hypotheses">
        {payload.hypotheses.map((h) => (
          <li key={h.id} className="debug-structured-card__hypothesis">
            <span className="debug-structured-card__id">{h.id}</span>
            <div className="debug-structured-card__hypothesis-body">
              <div className="debug-structured-card__hypothesis-desc">
                {h.description}
              </div>
              {h.instrumentationPlan && (
                <div className="debug-structured-card__hypothesis-plan">
                  <span className="debug-structured-card__field-label">
                    Instrument:
                  </span>{" "}
                  {h.instrumentationPlan}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="debug-structured-card__section">
        <div className="debug-structured-card__field-label">
          Reproduction steps
        </div>
        <ol className="debug-structured-card__steps">
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
      <div className="debug-structured-card__verdicts">
        <div className="debug-structured-card__verdict debug-structured-card__verdict--supported">
          <span className="debug-structured-card__verdict-label">
            Supported
          </span>
          <span className="debug-structured-card__verdict-ids">
            {payload.supportedHypotheses.length > 0
              ? payload.supportedHypotheses.join(", ")
              : "—"}
          </span>
        </div>
        <div className="debug-structured-card__verdict debug-structured-card__verdict--refuted">
          <span className="debug-structured-card__verdict-label">Refuted</span>
          <span className="debug-structured-card__verdict-ids">
            {payload.refutedHypotheses.length > 0
              ? payload.refutedHypotheses.join(", ")
              : "—"}
          </span>
        </div>
        <div className="debug-structured-card__verdict debug-structured-card__verdict--inconclusive">
          <span className="debug-structured-card__verdict-label">
            Inconclusive
          </span>
          <span className="debug-structured-card__verdict-ids">
            {payload.inconclusiveHypotheses.length > 0
              ? payload.inconclusiveHypotheses.join(", ")
              : "—"}
          </span>
        </div>
      </div>
      <div className="debug-structured-card__section">
        <span className="debug-structured-card__field-label">
          Recommended next step:
        </span>{" "}
        <code className="debug-structured-card__code">
          {payload.recommendedNextStep}
        </code>
      </div>
      <div className="debug-structured-card__section">
        <div className="debug-structured-card__field-label">Summary</div>
        <p className="debug-structured-card__summary">
          {payload.evidenceSummary}
        </p>
      </div>
    </>
  );
}

function FixCard({
  payload,
}: {
  payload: DebugFixResultOutput;
}): React.JSX.Element {
  return (
    <>
      <div className="debug-structured-card__section">
        <div className="debug-structured-card__field-label">Fix summary</div>
        <p className="debug-structured-card__summary">{payload.fixSummary}</p>
      </div>
      <div className="debug-structured-card__section">
        <div className="debug-structured-card__field-label">
          Verification steps
        </div>
        <ol className="debug-structured-card__steps">
          {payload.verificationSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>
    </>
  );
}

function CleanupCard({
  payload,
}: {
  payload: DebugCleanupResultOutput;
}): React.JSX.Element {
  const checkmark = (ok: boolean): string => (ok ? "\u2713" : "\u2715");

  return (
    <>
      <ul className="debug-structured-card__checks">
        <li
          className={`debug-structured-card__check${
            payload.removedInstrumentation
              ? " debug-structured-card__check--ok"
              : " debug-structured-card__check--fail"
          }`}
        >
          <span className="debug-structured-card__check-icon">
            {checkmark(payload.removedInstrumentation)}
          </span>
          Instrumentation removed
        </li>
        <li
          className={`debug-structured-card__check${
            payload.grepVerificationPassed
              ? " debug-structured-card__check--ok"
              : " debug-structured-card__check--fail"
          }`}
        >
          <span className="debug-structured-card__check-icon">
            {checkmark(payload.grepVerificationPassed)}
          </span>
          Grep verification passed
        </li>
        <li
          className={`debug-structured-card__check${
            payload.acknowledgesManifestDeletionContract
              ? " debug-structured-card__check--ok"
              : " debug-structured-card__check--fail"
          }`}
        >
          <span className="debug-structured-card__check-icon">
            {checkmark(payload.acknowledgesManifestDeletionContract)}
          </span>
          Manifest deletion contract acknowledged
        </li>
      </ul>
      {payload.filesModified.length > 0 && (
        <div className="debug-structured-card__section">
          <div className="debug-structured-card__field-label">
            Files modified
          </div>
          <ul className="debug-structured-card__files">
            {payload.filesModified.map((file) => (
              <li key={file}>
                <code className="debug-structured-card__code">{file}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      {payload.notes && (
        <div className="debug-structured-card__section">
          <div className="debug-structured-card__field-label">Notes</div>
          <p className="debug-structured-card__summary">{payload.notes}</p>
        </div>
      )}
    </>
  );
}

function FallbackCard({ payload }: { payload: unknown }): React.JSX.Element {
  return (
    <pre className="debug-structured-card__fallback">
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}

export default function DebugStructuredCard({
  phase,
  payload,
}: Props): React.JSX.Element {
  let body: React.JSX.Element;

  if (phase === "hypothesizing" && isHypothesisOutput(payload)) {
    body = <HypothesisCard payload={payload} />;
  } else if (phase === "analyzing_evidence" && isEvidenceAnalysis(payload)) {
    body = <EvidenceCard payload={payload} />;
  } else if (phase === "fixing" && isFixResult(payload)) {
    body = <FixCard payload={payload} />;
  } else if (phase === "cleanup_instrumentation" && isCleanupResult(payload)) {
    body = <CleanupCard payload={payload} />;
  } else {
    body = <FallbackCard payload={payload} />;
  }

  return (
    <div
      className={`debug-structured-card debug-structured-card--${phase}`}
      data-testid="debug-structured-card"
      data-phase={phase}
    >
      <div className="debug-structured-card__header">{PHASE_LABELS[phase]}</div>
      <div className="debug-structured-card__body">{body}</div>
    </div>
  );
}
