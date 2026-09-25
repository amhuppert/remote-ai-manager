import type { SpecGate } from "./schemas";

/**
 * How one consulted subject is settled, or that it is not.
 *
 * `carried` and `current_revision` are both human approvals — they differ only
 * in which revision the human read. `import_settled` is emphatically neither:
 * no human read the content and no approval row exists. `combined_act` is the
 * collapsed dial's one sign-off standing in for every subject it governs, so
 * it is never reported as a per-subject approval either.
 */
export type ApprovalLedgerClass =
  | "carried"
  | "current_revision"
  | "import_settled"
  | "combined_act"
  | "pending";

export interface ApprovalLedgerSubject {
  gate: SpecGate;
  subject: string;
  /** Null for the plan subject, which covers the task set as a whole. */
  elementId: string | null;
  classification: ApprovalLedgerClass;
}

/** Whether the applicable gates ask per subject or collapse into one act. */
export type ApprovalLedgerGovernance = "per_subject" | "combined_sign_off";

/**
 * Both sides of what the consulted authoring gates ask for: what is already
 * settled and by which act, beside what a human still owes.
 *
 * The pending half alone misprices an amendment draft — a list of seven
 * outstanding subjects reads as seven approvals lost when the truth is that
 * everything unchanged is banked. Only authoring subjects appear: the
 * execution-scoped gates admit a run as a whole and have no per-subject side.
 */
export interface ApprovalLedger {
  subjects: ApprovalLedgerSubject[];
  /** carried + currentRevision + importSettled + combinedAct. */
  satisfied: number;
  carried: number;
  currentRevision: number;
  importSettled: number;
  combinedAct: number;
  pending: number;
  governedBy: ApprovalLedgerGovernance;
  /** The mechanism the counts assert, carried so JSON says it too. */
  carryRule: string;
}

/**
 * Why a subject stays settled across revisions. Printed where the wrong
 * inference happens, and carried on the wire beside the counts it explains.
 */
export const APPROVAL_CARRY_RULE =
  "unchanged subject content under the same applicable gate";

/**
 * The ledger of a revision whose content cannot be read. It asserts nothing:
 * no subject is claimed settled, and none is claimed outstanding.
 */
export function emptyApprovalLedger(): ApprovalLedger {
  return {
    subjects: [],
    satisfied: 0,
    carried: 0,
    currentRevision: 0,
    importSettled: 0,
    combinedAct: 0,
    pending: 0,
    governedBy: "per_subject",
    carryRule: APPROVAL_CARRY_RULE,
  };
}

/** The counted classes, in the order the ledger sentence names them. */
const SATISFIED_CLASSES = [
  ["carried", "carried"],
  ["currentRevision", "current-revision"],
  ["importSettled", "import-settled"],
  ["combinedAct", "combined-act"],
] as const satisfies ReadonlyArray<readonly [keyof ApprovalLedger, string]>;

/**
 * The one rendering of the ledger, read by `spec status` and by every receipt
 * that carries it, so no surface can word the same counts differently.
 *
 * A collapsed gate whose sign-off has not happened yet has satisfied nothing,
 * and saying "0 satisfied" alone would read as "nothing is governed here": it
 * names the act that governs its subjects instead.
 */
export function approvalLedgerSentence(ledger: ApprovalLedger): string {
  if (ledger.subjects.length === 0) {
    return "approval subjects: none — no consulted gate asks for a per-subject approval";
  }
  const breakdown = SATISFIED_CLASSES.filter(
    ([field]) => ledger[field] !== 0,
  ).map(([field, label]) => `${ledger[field]} ${label}`);
  const satisfied =
    breakdown.length === 0
      ? `${ledger.satisfied} satisfied`
      : `${ledger.satisfied} satisfied (${breakdown.join(", ")})`;
  const governance =
    ledger.governedBy === "combined_sign_off" && ledger.combinedAct === 0
      ? " — governed by the combined sign-off, which is outstanding"
      : "";
  return `approval subjects: ${satisfied} · ${ledger.pending} pending${governance}`;
}
