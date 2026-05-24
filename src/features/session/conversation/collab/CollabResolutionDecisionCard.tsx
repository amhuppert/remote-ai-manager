"use client";

import type {
  CollaborationAgent,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationReference,
  CollaborationResolutionDecisionNextAction,
  CollaborationResolvedDisagreement,
  CollaborationUserQuestion,
} from "@/lib/workflows/collaboration/types";
import CollabClaimsList from "@/features/session/conversation/collab/CollabClaimsList";
import CollabCollapsibleCard from "@/features/session/conversation/collab/CollabCollapsibleCard";
import CollabMarkdownText from "@/features/session/conversation/collab/CollabMarkdownText";

export interface CollabResolutionDecisionCardProps {
  agent: CollaborationAgent;
  round: number;
  agreementReached: boolean;
  nextAction: CollaborationResolutionDecisionNextAction;
  acceptedPoints: CollaborationArtifactAgreement[];
  resolvedDisagreements: CollaborationResolvedDisagreement[];
  remainingDisagreements: CollaborationArtifactDisagreement[];
  userQuestions: CollaborationUserQuestion[];
  rationale: string;
  trajectory: number[];
  defaultOpen?: boolean;
  onRefClick?: (ref: CollaborationReference) => void;
}

const VERDICT_LABEL: Record<CollaborationResolutionDecisionNextAction, string> =
  {
    final: "Converged",
    continue_negotiation: "Continue",
    ask_user: "Ask Alex",
    fail: "Failed",
  };

const AGENT_LABEL: Record<CollaborationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

const SPARKLINE_WIDTH = 96;
const SPARKLINE_HEIGHT = 24;
const SPARKLINE_PADDING = 2;

interface SparklinePoint {
  x: number;
  y: number;
}

function buildSparklinePoints(values: number[]): SparklinePoint[] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 1);
  const usableWidth = SPARKLINE_WIDTH - SPARKLINE_PADDING * 2;
  const usableHeight = SPARKLINE_HEIGHT - SPARKLINE_PADDING * 2;
  const denominator = values.length === 1 ? 1 : values.length - 1;
  return values.map((value, idx) => {
    const x = SPARKLINE_PADDING + (idx / denominator) * usableWidth;
    const yRatio = max === 0 ? 0 : value / max;
    const y = SPARKLINE_PADDING + (1 - yRatio) * usableHeight;
    return { x, y };
  });
}

function pointsToPath(points: SparklinePoint[]): string {
  if (points.length === 0) return "";
  return points
    .map(
      (point, idx) =>
        `${idx === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    )
    .join(" ");
}

function TrajectorySparkline({
  trajectory,
}: {
  trajectory: number[];
}): React.JSX.Element | null {
  if (trajectory.length < 2) return null;
  const points = buildSparklinePoints(trajectory);
  const last = points[points.length - 1];
  const path = pointsToPath(points);
  return (
    <div
      className="collab-resolution-decision-card-trajectory"
      aria-label={`Disagreement trajectory: ${trajectory.join(", ")}`}
    >
      <span>trajectory</span>
      <svg
        className="collab-resolution-decision-card-sparkline"
        viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
        width={SPARKLINE_WIDTH}
        height={SPARKLINE_HEIGHT}
        role="img"
        aria-hidden="true"
      >
        <path d={path} />
        {last ? <circle cx={last.x} cy={last.y} r={2} /> : null}
      </svg>
      <span>
        {trajectory[0]} → {trajectory[trajectory.length - 1]}
      </span>
    </div>
  );
}

export default function CollabResolutionDecisionCard({
  agent,
  round,
  agreementReached,
  nextAction,
  acceptedPoints,
  resolvedDisagreements,
  remainingDisagreements,
  userQuestions,
  rationale,
  trajectory,
  defaultOpen,
  onRefClick,
}: CollabResolutionDecisionCardProps): React.JSX.Element {
  const verdictLabel = VERDICT_LABEL[nextAction];

  return (
    <CollabCollapsibleCard
      agent={agent}
      kind="resolution_decision"
      ariaLabel={`Resolution decision for round ${round}: ${verdictLabel}`}
      defaultOpen={defaultOpen}
      header={
        <>
          <span className="collab-artifact-card-agent" data-agent={agent}>
            {AGENT_LABEL[agent]}
          </span>
          <span className="collab-artifact-card-eyebrow">Resolution</span>
          <span
            className="collab-artifact-card-round"
            aria-label={`Round ${round}`}
          >
            R{round}
          </span>
          <span
            className="collab-artifact-card-verdict"
            data-next-action={nextAction}
          >
            {verdictLabel}
          </span>
          <span className="collab-artifact-card-summary">
            {acceptedPoints.length} accepted · {resolvedDisagreements.length}{" "}
            resolved · {remainingDisagreements.length} remaining
            {userQuestions.length > 0
              ? ` · ${userQuestions.length} question${
                  userQuestions.length === 1 ? "" : "s"
                }`
              : ""}
            {agreementReached ? " · agreement" : ""}
          </span>
        </>
      }
    >
      <TrajectorySparkline trajectory={trajectory} />

      <CollabMarkdownText
        content={rationale}
        className="collab-artifact-card-narrative"
      />

      {resolvedDisagreements.length > 0 ? (
        <section className="collab-artifact-card-section">
          <h4 className="collab-artifact-card-section-title">
            Resolved disagreements ({resolvedDisagreements.length})
          </h4>
          <ul
            className="collab-resolution-decision-card-resolved"
            aria-label="Resolved disagreements"
          >
            {resolvedDisagreements.map((item) => (
              <li
                className="collab-resolution-decision-card-resolved-item"
                key={item.disagreementId}
              >
                <div className="collab-resolution-decision-card-resolved-resolution">
                  <span className="collab-resolution-decision-card-resolved-id">
                    {item.disagreementId} →
                  </span>{" "}
                  <CollabMarkdownText
                    content={item.resolution}
                    className="collab-resolution-decision-card-resolved-text"
                  />
                </div>
                <div className="collab-resolution-decision-card-resolved-meta">
                  <span className="collab-resolution-decision-card-resolved-meta-prefix">
                    {item.resolvedAutonomously ? "auto" : "manual"} ·
                  </span>{" "}
                  <CollabMarkdownText
                    content={item.rationale}
                    className="collab-resolution-decision-card-resolved-rationale"
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {remainingDisagreements.length > 0 || acceptedPoints.length > 0 ? (
        <CollabClaimsList
          agree={acceptedPoints}
          disagree={remainingDisagreements}
          onRefClick={onRefClick}
        />
      ) : null}
    </CollabCollapsibleCard>
  );
}
