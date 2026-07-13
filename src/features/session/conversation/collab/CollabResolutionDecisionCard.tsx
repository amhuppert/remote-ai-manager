"use client";

import type {
  CollaborationAgent,
  CollaborationAgentModelSettings,
  CollaborationArtifactAgreement,
  CollaborationArtifactDisagreement,
  CollaborationReference,
  CollaborationResolutionDecisionNextAction,
  CollaborationResolvedDisagreement,
  CollaborationUserQuestion,
} from "@/lib/workflows/collaboration/types";
import { cn } from "@/lib/ui/cn";
import CollabAgentModelMeta, {
  AGENT_LABEL,
} from "@/features/session/conversation/collab/CollabAgentModelMeta";
import CollabClaimsList from "@/features/session/conversation/collab/CollabClaimsList";
import CollabCollapsibleCard from "@/features/session/conversation/collab/CollabCollapsibleCard";
import CollabMarkdownText from "@/features/session/conversation/collab/CollabMarkdownText";
import {
  cardAgent,
  cardEyebrow,
  cardNarrative,
  cardRound,
  cardSection,
  cardSectionTitle,
  cardSummary,
  cardVerdict,
  cardVerdictColor,
} from "@/features/session/conversation/collab/card-chrome";

export interface CollabResolutionDecisionCardProps {
  agent: CollaborationAgent;
  modelSettings?: CollaborationAgentModelSettings;
  round: number;
  agreement_reached: boolean;
  next_action: CollaborationResolutionDecisionNextAction;
  accepted_points: CollaborationArtifactAgreement[];
  resolved_disagreements: CollaborationResolvedDisagreement[];
  remaining_disagreements: CollaborationArtifactDisagreement[];
  user_questions: CollaborationUserQuestion[];
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
      className="flex items-center gap-sm font-mono text-[0.7rem] text-text-tertiary"
      aria-label={`Disagreement trajectory: ${trajectory.join(", ")}`}
    >
      <span>trajectory</span>
      <svg
        className="block h-[24px] w-auto"
        viewBox={`0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}`}
        width={SPARKLINE_WIDTH}
        height={SPARKLINE_HEIGHT}
        role="img"
        aria-hidden="true"
      >
        <path className="fill-none stroke-cyan [stroke-width:1.5]" d={path} />
        {last ? (
          <circle className="fill-cyan" cx={last.x} cy={last.y} r={2} />
        ) : null}
      </svg>
      <span>
        {trajectory[0]} → {trajectory[trajectory.length - 1]}
      </span>
    </div>
  );
}

export default function CollabResolutionDecisionCard({
  agent,
  modelSettings,
  round,
  agreement_reached,
  next_action,
  accepted_points,
  resolved_disagreements,
  remaining_disagreements,
  user_questions,
  rationale,
  trajectory,
  defaultOpen,
  onRefClick,
}: CollabResolutionDecisionCardProps): React.JSX.Element {
  const verdictLabel = VERDICT_LABEL[next_action];

  return (
    <CollabCollapsibleCard
      agent={agent}
      kind="resolution_decision"
      ariaLabel={`Resolution decision for round ${round}: ${verdictLabel}`}
      defaultOpen={defaultOpen}
      header={
        <>
          <span className={cardAgent} data-agent={agent}>
            {AGENT_LABEL[agent]}
            <CollabAgentModelMeta settings={modelSettings} />
          </span>
          <span className={cardEyebrow}>Resolution</span>
          <span className={cardRound} aria-label={`Round ${round}`}>
            R{round}
          </span>
          <span
            className={cn(cardVerdict, cardVerdictColor[next_action])}
            data-next-action={next_action}
          >
            {verdictLabel}
          </span>
          <span className={cardSummary}>
            {accepted_points.length} accepted · {resolved_disagreements.length}{" "}
            resolved · {remaining_disagreements.length} remaining
            {user_questions.length > 0
              ? ` · ${user_questions.length} question${
                  user_questions.length === 1 ? "" : "s"
                }`
              : ""}
            {agreement_reached ? " · agreement" : ""}
          </span>
        </>
      }
    >
      <TrajectorySparkline trajectory={trajectory} />

      <CollabMarkdownText content={rationale} className={cardNarrative} />

      {resolved_disagreements.length > 0 ? (
        <section className={cardSection}>
          <h4 className={cardSectionTitle}>
            Resolved disagreements ({resolved_disagreements.length})
          </h4>
          <ul
            className="m-0 flex list-none flex-col gap-[6px] p-0"
            aria-label="Resolved disagreements"
          >
            {resolved_disagreements.map((item) => (
              <li
                className="flex flex-col gap-[2px] border-0 border-l-2 border-solid border-l-green-dim pl-sm text-[0.82rem] text-text-primary"
                key={item.disagreement_id}
              >
                <div className="flex flex-wrap items-baseline gap-x-[4px] gap-y-0">
                  <span className="shrink-0 font-mono font-semibold text-text-secondary">
                    {item.disagreement_id} →
                  </span>{" "}
                  <CollabMarkdownText
                    content={item.resolution}
                    className="min-w-0 flex-auto"
                  />
                </div>
                <div className="flex flex-wrap items-baseline gap-x-[4px] gap-y-0 font-mono text-[0.7rem] text-text-secondary">
                  <span className="shrink-0">
                    {item.resolved_autonomously ? "auto" : "manual"} ·
                  </span>{" "}
                  <CollabMarkdownText
                    content={item.rationale}
                    className="min-w-0 flex-auto font-mono text-[0.7rem] text-text-secondary"
                  />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {remaining_disagreements.length > 0 || accepted_points.length > 0 ? (
        <CollabClaimsList
          agree={accepted_points}
          disagree={remaining_disagreements}
          onRefClick={onRefClick}
        />
      ) : null}
    </CollabCollapsibleCard>
  );
}
