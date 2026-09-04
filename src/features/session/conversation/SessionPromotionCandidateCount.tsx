"use client";

import { StatusChip } from "@/components/ui/StatusChip";
import { useSessionPromotionCandidatesQuery } from "@/lib/memory/queries";

export interface SessionPromotionCandidateCountProps {
  projectName: string;
  sessionName: string;
}

/**
 * The completion cue (spec R11): when a session ends, its state notes archive
 * themselves and its remaining durable notes become promotion candidates — the
 * knowledge either moves up to the project or dies with the session's scope.
 * This is the passive signal that the decision is owed; the Memory Library's
 * badge opens the same prefiltered queue.
 *
 * Candidacy is NOT derived here, and neither is the incarnation: both come from
 * `useSessionPromotionCandidatesQuery`, the single client binding of the
 * candidate contract, so this count and the Library badge cannot disagree and
 * neither can serve an answer computed before the session ended.
 */
export default function SessionPromotionCandidateCount({
  projectName,
  sessionName,
}: SessionPromotionCandidateCountProps): React.JSX.Element | null {
  const candidates = useSessionPromotionCandidatesQuery(
    projectName,
    sessionName,
  );
  const count = candidates.data?.length ?? 0;
  // Nothing is said while the queue is still loading, and nothing is said when
  // no decision is owed: a zero here would be noise on every finished session.
  if (count === 0) return null;

  return (
    <StatusChip tone="violet">
      {count === 1
        ? "1 memory note awaits promotion"
        : `${count} memory notes await promotion`}
    </StatusChip>
  );
}
