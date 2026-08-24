import {
  sameSubjectFingerprint,
  subjectFingerprint,
  type ApprovalCitationState,
  type ApprovalSubject,
} from "./approval-applicability";
import type { RevisionElement } from "./revision-diff";
import type { SpecGateAdmissionRow } from "./schemas";

/**
 * The revision an import created, identified by the only thing that marks it:
 * its authoring-gate admissions carry the `import` basis. It is not simply the
 * governance base — a later human-approved amendment takes that place while the
 * elements nobody has touched since the import are still admitted by it alone.
 */
export function importBaselineRevisionId(
  admissions: readonly SpecGateAdmissionRow[],
): string | null {
  for (const admission of admissions) {
    if (admission.basis === "import" && admission.revision_id !== null) {
      return admission.revision_id;
    }
  }
  return null;
}

/**
 * Why a subject owes no human approval right now. `import_carry_forward` is
 * emphatically not an approval: no human read the content and no approval row
 * exists, so a surface that reports it as approved is describing an act that
 * never happened.
 */
export type ElementApprovalBasis = "human_approval" | "import_carry_forward";

/**
 * The one authority on whether an element subject is settled, and on what — the
 * sign-off preconditions and the status projection both ask it, so a subject
 * can never be outstanding in one and satisfied in the other.
 *
 * An imported element whose subject is byte-for-byte what the import admitted
 * carries that admission forward: re-asking would hand a human every imported
 * element on the first amendment. The comparison is `subjectFingerprint`, the
 * same one a native approval is judged by, so a requirement carries its
 * criteria: rewriting, adding, or deleting a criterion changes the subject and
 * invalidates the carry-forward even though the requirement's own payload is
 * untouched. An element the baseline never carried is never carried forward.
 *
 * This grants no gate. The revision still owes its human sign-off.
 */
export function elementApprovalBasis(input: {
  approvalHeld: boolean;
  subject: ApprovalSubject;
  revisionRows: readonly RevisionElement[];
  revisionCitationState: ApprovalCitationState;
  /** Null for every spec no import created, which keeps this inert natively. */
  importBaselineRows: readonly RevisionElement[] | null;
  importBaselineCitationState: ApprovalCitationState | null;
}): ElementApprovalBasis | null {
  if (input.approvalHeld) return "human_approval";
  // The plan gate is never import-admitted, and its subject is the task set as
  // a whole: an empty baseline would match an empty task list by accident.
  if (
    input.importBaselineRows === null ||
    input.importBaselineCitationState === null ||
    input.subject.elementId === null
  ) {
    return null;
  }
  return sameSubjectFingerprint(
    subjectFingerprint(
      input.revisionRows,
      input.subject,
      input.revisionCitationState,
    ),
    subjectFingerprint(
      input.importBaselineRows,
      input.subject,
      input.importBaselineCitationState,
    ),
  )
    ? "import_carry_forward"
    : null;
}
