"use client";

import type { ValidatorCohort } from "@/lib/workflow-graph/config-schemas";

/**
 * The seats whose validator lane a pending cohort edit would retire, in roster
 * order.
 *
 * Authority and instructions are the two axes this notice covers (R12.4).
 * Authority selects the output schema the lane's turn is bound to; the
 * instructions text moves the delivered profile bytes. Either one changes the
 * assignment fingerprint, so the seat cannot resume its conversation — the
 * engine builds a fresh lane and reports `assignment_changed`.
 *
 * A seat that appears only on one side is not reported: an added seat has no
 * lane yet, and a removed one has no lane left to rotate.
 */
export function assignmentsRotatedByEdit(
  base: ValidatorCohort,
  draft: ValidatorCohort,
): string[] {
  const before = new Map(base.assignments.map((entry) => [entry.id, entry]));
  return draft.assignments
    .filter((entry) => {
      const previous = before.get(entry.id);
      if (!previous) return false;
      return (
        previous.authority !== entry.authority || previous.focus !== entry.focus
      );
    })
    .map((entry) => entry.id);
}

/**
 * What a live-execution Config surface says before an authority or instructions
 * edit is applied (R12.4).
 *
 * It renders from the pending draft rather than from a saved result, so the
 * consequence is visible while the edit can still be reconsidered. Amber, not
 * red: rotating a lane is the correct handling of a changed seat, not a fault.
 */
export function LaneRotationNotice({
  base,
  draft,
}: {
  base: ValidatorCohort;
  draft: ValidatorCohort;
}): React.JSX.Element | null {
  const rotated = assignmentsRotatedByEdit(base, draft);
  if (rotated.length === 0) return null;

  const plural = rotated.length > 1;
  return (
    <div
      data-testid="lane-rotation-notice"
      className="rounded-md border border-solid border-[var(--cc-amber-a30)] bg-[var(--cc-amber-a10)] px-[12px] py-[8px] text-[0.72rem] leading-[1.5] text-amber"
    >
      Saving retires {plural ? "the lanes of " : "the lane of "}
      <span className="font-mono font-semibold">
        {rotated.join(", ")}
      </span>. {plural ? "Those validators" : "That validator"} cannot resume{" "}
      {plural ? "their" : "its"} current conversation once the authority or
      instructions change, so {plural ? "each starts" : "it starts"} a fresh
      lane against the current candidate (
      <code className="rounded-[3px] bg-bg-raised px-[4px] py-[1px] font-mono">
        assignment_changed
      </code>
      ).
    </div>
  );
}
