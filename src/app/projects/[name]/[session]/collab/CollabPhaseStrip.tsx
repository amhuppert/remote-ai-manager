"use client";

export type CollabPhaseKind =
  | { kind: "initial_draft" }
  | { kind: "cross_review" }
  | { kind: "negotiation"; round: number }
  | { kind: "open_conflicts" }
  | { kind: "final_answer" }
  | { kind: "failed" };

export type CollabPhaseStatus = "pending" | "active" | "done";

export type CollabPhaseVerdict =
  | "converged"
  | "ask_user"
  | "failed"
  | "user_stopped";

export interface CollabPhaseStripPhase {
  kind: CollabPhaseKind;
  status: CollabPhaseStatus;
}

export interface CollabPhaseStripProps {
  phases: CollabPhaseStripPhase[];
  verdict?: CollabPhaseVerdict;
  compact?: boolean;
  onStop?: () => void;
}

function phaseLabel(kind: CollabPhaseKind): string {
  switch (kind.kind) {
    case "initial_draft":
      return "Draft";
    case "cross_review":
      return "X-Rev";
    case "negotiation":
      return `R${kind.round}`;
    case "open_conflicts":
      return "Conflicts";
    case "final_answer":
      return "Final";
    case "failed":
      return "Failed";
  }
}

function phaseDataKind(kind: CollabPhaseKind): string {
  return kind.kind;
}

const VERDICT_LABEL: Record<CollabPhaseVerdict, string> = {
  converged: "converged",
  ask_user: "awaiting Alex",
  failed: "failed",
  user_stopped: "stopped",
};

const VERDICT_GLYPH: Record<CollabPhaseVerdict, string> = {
  converged: "✓",
  ask_user: "?",
  failed: "×",
  user_stopped: "■",
};

function isStopAvailable(phases: CollabPhaseStripPhase[]): boolean {
  return phases.some((phase) => phase.status === "active");
}

export default function CollabPhaseStrip({
  phases,
  verdict,
  compact,
  onStop,
}: CollabPhaseStripProps): React.JSX.Element {
  const stopAvailable = isStopAvailable(phases);

  return (
    <div
      className="collab-phase-strip"
      data-compact={compact ? "true" : "false"}
      data-verdict={verdict ?? "none"}
      role="group"
      aria-label="Collaboration phase progress"
    >
      <ol className="collab-phase-strip-pips">
        {phases.map((phase, idx) => {
          const label = phaseLabel(phase.kind);
          const dataKind = phaseDataKind(phase.kind);
          return (
            <li
              key={`${dataKind}-${label}-${idx}`}
              className="collab-phase-strip-pip"
              data-kind={dataKind}
              data-status={phase.status}
              aria-current={phase.status === "active" ? "step" : undefined}
            >
              <span className="collab-phase-strip-pip-dot" aria-hidden="true" />
              <span className="collab-phase-strip-pip-label">{label}</span>
            </li>
          );
        })}
        {verdict ? (
          <li
            className="collab-phase-strip-verdict"
            data-verdict={verdict}
            aria-label={VERDICT_LABEL[verdict]}
          >
            <span
              className="collab-phase-strip-verdict-glyph"
              aria-hidden="true"
            >
              {VERDICT_GLYPH[verdict]}
            </span>
            <span className="collab-phase-strip-verdict-label">
              {VERDICT_LABEL[verdict]}
            </span>
          </li>
        ) : null}
      </ol>

      {stopAvailable && onStop ? (
        <button
          type="button"
          className="btn btn-danger btn-sm collab-phase-strip-stop"
          onClick={onStop}
          aria-label="Stop collaboration"
        >
          Stop
        </button>
      ) : null}
    </div>
  );
}
