"use client";

import { cn } from "@/lib/ui/cn";
import type { JoinConflictSummary } from "./join-conflict-summary";

/**
 * The join card on the lane rail (README §11: join conflicts and recovery
 * guidance reach the lane rail as well as the Overview gates list).
 *
 * A failed join is a RUNTIME state of the lane it was merging into, so it is
 * stated on that lane's rail rather than only behind the status bar's halt row.
 * The card states the same facts `deriveJoinConflictSummary` gives the recovery
 * card — one owner, so the two can never name different members — and offers
 * the blocked member's two ways out. Retrying the merge is deliberately NOT
 * here: the retry carries conflict guidance and a mutation, and it stays with
 * the halt card that owns that form.
 *
 * The card carries no placement of its own. The canvas hangs it beside a band
 * in flow coordinates and the stacked mobile list renders it in normal flow;
 * both are the same card because the facts do not change with the breakpoint.
 *
 * A lane has no grade, and none is shown: this card belongs to the JOIN.
 */

const MEMBER_TONE: Record<
  JoinConflictSummary["members"][number]["status"],
  string
> = {
  merged: "text-text-tertiary",
  blocked: "text-red",
  pending: "text-text-tertiary",
};

// §12: the stacked mobile list renders this same card, where every control has
// to clear the 44px touch target the canvas's pointer-sized buttons do not.
const ACTION_CLASS =
  "cursor-pointer rounded-sm border border-solid border-border-default bg-bg-raised px-sm py-[3px] font-mono text-[0.7rem] text-text-secondary transition-colors duration-150 hover:border-border-strong hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan max-768:min-h-[44px] max-768:flex-1 max-768:px-md";

export interface LaneJoinConflictCardProps {
  readonly summary: JoinConflictSummary;
  /** Opens the blocked member's runtime — its lane worktree and branch. */
  readonly onOpenLaneWorktree?: (contextId: string) => void;
  /** Opens the blocked member's placement, where its owned paths are edited. */
  readonly onEditOwnership?: (contextId: string) => void;
  /** Placement only — the host decides where the card sits. */
  readonly layoutClassName?: string;
}

export default function LaneJoinConflictCard({
  summary,
  onOpenLaneWorktree,
  onEditOwnership,
  layoutClassName,
}: LaneJoinConflictCardProps): React.JSX.Element {
  // The summary owns which member is the subject; picking one here would let
  // the sentence below name a context the buttons never open.
  const blocked = summary.blockedMember;
  const blockedContextId = blocked?.contextId ?? null;
  const memberWord = summary.members.length === 1 ? "member" : "members";

  return (
    <div
      role="group"
      aria-label={`Join conflict on lane ${summary.laneLabel} — ${summary.joinId}`}
      data-testid="lane-join-conflict-card"
      data-lane-name={summary.laneLabel}
      // The band layer is `pointer-events-none` so it stays behind the nodes;
      // this card carries real controls, so it takes pointer events back for
      // itself alone.
      className={cn(
        "pointer-events-auto flex max-w-[420px] flex-col overflow-hidden rounded-sm border border-solid border-[var(--cc-red-a25)] bg-bg-base",
        layoutClassName,
      )}
    >
      <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim bg-[var(--cc-red-a10)] px-md py-[7px]">
        <span className="font-mono text-[0.74rem] font-semibold text-red">
          Join conflict — {summary.laneLabel}
        </span>
        <span className="ml-auto font-mono text-[0.7rem] text-text-tertiary">
          {summary.joinId}
        </span>
      </div>

      <div className="flex flex-col gap-[7px] px-md py-sm">
        <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
          {summary.mergedCount} of {summary.members.length} {memberWord} merged.
          {blocked !== null && (
            <>
              {" "}
              <span
                data-testid="lane-join-conflict-subject"
                className="text-text-primary"
              >
                {blocked.title}
              </span>{" "}
              is blocked
              {summary.conflictFiles.length > 0 && (
                <>
                  {" "}
                  in{" "}
                  <span className="text-text-primary">
                    {summary.conflictFiles.join(", ")}
                  </span>
                </>
              )}
              {blocked.detail === null ? "." : ` — ${blocked.detail}`}
            </>
          )}
        </p>

        <div
          data-testid="lane-join-members"
          className="flex flex-col gap-[3px] font-mono text-[0.7rem] leading-[1.6]"
        >
          {summary.members.map((member) => (
            <span
              key={`${member.laneId}:${member.contextId ?? ""}`}
              className={cn(MEMBER_TONE[member.status])}
            >
              {member.status} · {member.title} → {summary.laneLabel}
            </span>
          ))}
        </div>

        <p className="m-0 font-mono text-[0.7rem] leading-[1.5] text-text-tertiary">
          Resolve in the lane worktree, or narrow one member&apos;s owned paths
          so the two no longer overlap, then retry the join from the halt card.
        </p>

        {/* No blocked context means no destination — a control that navigated
            nowhere would be worse than the statement above on its own. */}
        {blockedContextId !== null && (
          <div className="flex flex-wrap gap-sm">
            {onOpenLaneWorktree && (
              <button
                type="button"
                className={ACTION_CLASS}
                onClick={() => onOpenLaneWorktree(blockedContextId)}
              >
                Open lane worktree
              </button>
            )}
            {onEditOwnership && (
              <button
                type="button"
                className={ACTION_CLASS}
                onClick={() => onEditOwnership(blockedContextId)}
              >
                Edit ownership
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
