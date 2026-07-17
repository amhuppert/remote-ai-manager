"use client";

import { cn } from "@/lib/ui/cn";
import type {
  CollaborationAgent,
  CollaborationAgentModelSettings,
} from "@/lib/workflows/collaboration/types";
import CollabAgentModelMeta, {
  AGENT_LABEL,
} from "@/features/session/conversation/collab/CollabAgentModelMeta";
import {
  cardAgent,
  cardEyebrow,
  cardRound,
} from "@/features/session/conversation/collab/card-chrome";
import type { CollabPendingStep } from "@/features/session/conversation/collab/collab-pending";

// Agent identity accent, matching the finished cards' 3px left rail
// (CollabCollapsibleCard `agentBorder`).
const railBorder: Record<CollaborationAgent, string> = {
  claude: "border-l-[3px] border-l-cyan",
  codex: "border-l-[3px] border-l-violet",
};

// Sweeping scan line tinted to the working agent. `var(--cyan|--violet)` carries
// no colour literal, so the arbitrary utility passes the no-hardcoded-color gate.
const scanGradient: Record<CollaborationAgent, string> = {
  claude: "bg-[linear-gradient(90deg,transparent,var(--cyan)_50%,transparent)]",
  codex:
    "bg-[linear-gradient(90deg,transparent,var(--violet)_50%,transparent)]",
};

// Skeleton bars: descending widths so the block reads as prose, staggered so the
// shimmer ripples rather than pulsing in lockstep. Sliced by `step.lines`.
const SHIMMER_WIDTHS = ["w-[88%]", "w-[70%]", "w-[52%]"];
const SHIMMER_DELAYS = [
  "[animation-delay:0s]",
  "[animation-delay:0.15s]",
  "[animation-delay:0.3s]",
];
const shimmerBar =
  "h-[10px] rounded-sm bg-[linear-gradient(90deg,var(--bg-raised)_0%,var(--bg-elevated)_50%,var(--bg-raised)_100%)] bg-[length:200%_100%] animate-collab-shimmer motion-reduce:animate-none";

export interface CollabPendingCardProps {
  step: CollabPendingStep;
  modelSettings?: CollaborationAgentModelSettings;
}

/**
 * A loading placeholder for a collaboration artifact an agent is still writing.
 * Mirrors the finished card's header anatomy (agent · model · effort · phase
 * eyebrow) so model and reasoning effort read identically before and after the
 * artifact lands, then fills the body with shimmering skeleton bars under a
 * sweeping scan line. Purely informational — Stop stays in the phase strip.
 */
export default function CollabPendingCard({
  step,
  modelSettings,
}: CollabPendingCardProps): React.JSX.Element {
  const { agent, eyebrow, statusText, round, lines, kind } = step;
  const barCount = Math.min(lines, SHIMMER_WIDTHS.length);

  return (
    <section
      role="status"
      aria-label={`${AGENT_LABEL[agent]} is ${statusText}`}
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-raised",
        railBorder[agent],
      )}
      data-collab-pending="true"
      data-pending-kind={kind}
      data-agent={agent}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-[2px] animate-collab-scan bg-[length:200%_100%] motion-reduce:hidden",
          scanGradient[agent],
        )}
      />

      <div className="flex min-w-0 flex-wrap items-center gap-sm px-md py-sm">
        <span className={cardAgent} data-agent={agent}>
          {AGENT_LABEL[agent]}
          <CollabAgentModelMeta settings={modelSettings} />
        </span>
        <span className={cardEyebrow}>{eyebrow}</span>
        {round !== undefined ? (
          <span className={cardRound} aria-label={`Round ${round}`}>
            R{round}
          </span>
        ) : null}
        <span
          className={cn(
            "ml-auto font-mono text-[0.7rem] text-text-tertiary",
            "after:inline-block after:w-[1.1em] after:animate-collab-ellipsis after:text-left after:align-bottom after:content-['']",
            "motion-reduce:after:animate-none motion-reduce:after:content-['…']",
          )}
        >
          {statusText}
        </span>
      </div>

      <div className="flex flex-col gap-sm border-x-0 border-t border-b-0 border-solid border-border-subtle p-md">
        {SHIMMER_WIDTHS.slice(0, barCount).map((width, i) => (
          <span
            key={width}
            aria-hidden="true"
            className={cn(shimmerBar, width, SHIMMER_DELAYS[i])}
          />
        ))}
      </div>
    </section>
  );
}
