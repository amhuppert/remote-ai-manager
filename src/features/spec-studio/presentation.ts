import type { StatusChipTone } from "@/components/ui/StatusChip";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import type { DeliveryDisplay, SpecPhasePrimary } from "@/lib/specs/phase";
import type { SpecGate } from "@/lib/specs/schemas";
import type { SpecGateAdmissionView } from "@/lib/specs/view-schemas";

// Authoring stages share the identifiers of the gates that conclude them, so
// one map labels both.
export const gateLabels: Record<SpecGate, string> = {
  requirements: "Requirements",
  design: "Design",
  plan: "Plan",
  execution_start: "Execution start",
  delivery: "Delivery",
};

export const phaseLabels: Record<SpecPhasePrimary, string> = {
  abandoned: "Abandoned",
  executing: "Executing",
  draft: "Draft",
  delivered: "Delivered",
  approved: "Approved",
};

/**
 * Reads the delivered tally, not the proof tally: a criterion an imported spec
 * reports as delivered elsewhere is delivered, and a "0/3 delivered" chip on a
 * spec the same view calls Delivered would contradict itself.
 */
export function deliveryLabel(delivery: DeliveryDisplay): string {
  if (delivery.allWaived) return "All delivery waived";
  if (delivery.totalInScope === 0) return "No delivery scope";
  return `${delivery.deliveredCount}/${delivery.totalInScope} delivered`;
}

export function deliveryTone(delivery: DeliveryDisplay): StatusChipTone {
  if (delivery.allWaived) return "amber";
  if (delivery.totalInScope === 0) return "neutral";
  return delivery.deliveredCount === delivery.totalInScope ? "green" : "cyan";
}

/**
 * A draft plan with no blocking finding is the one a human reviews and signs
 * off in Workflow Builder; sign-off is the act that freezes and approves it.
 */
export function deliveryPlanReadyForSignOff(
  plan: Pick<DeliveryPlanReviewView, "attempt" | "health">,
): boolean {
  return plan.attempt.status === "draft" && plan.health.blocking === 0;
}

/**
 * The import a spec was born from, as its gate admissions record it.
 *
 * The admissions are the canonical source, not the `spec_imported` event: the
 * event's projection is null whenever its payload is unreadable, while the
 * admissions are what actually crossed the gates and cannot go missing without
 * the gates going with them. Deriving attribution from the event would fail
 * open in exactly that state — an imported revision reading as a human sign-off
 * and imported dispositions as human acts.
 */
export interface ImportProvenance {
  /** The instant the import transaction committed. */
  at: string;
  /** The revision the import created, born approved. */
  revisionId: string;
}

export function importProvenance(
  admissions: readonly SpecGateAdmissionView[],
): ImportProvenance | null {
  // One transaction writes every import admission from a single clock read and
  // pins them all to the revision it just created, so any one of them answers
  // both questions. The earliest is taken so the answer is order-independent.
  let found: ImportProvenance | null = null;
  for (const admission of admissions) {
    if (admission.basis !== "import" || admission.revisionId === null) continue;
    if (found === null || admission.createdAt < found.at) {
      found = { at: admission.createdAt, revisionId: admission.revisionId };
    }
  }
  return found;
}

/**
 * Whether this exact revision is one the import admitted past its gates.
 *
 * Attribution is a per-revision question, not a per-spec one: the status view's
 * `imported` bit stays true for the whole lineage descended from an import, so a
 * surface that reads the bit credits the import for every later amendment a
 * human authored and signed off here. The revision's own admissions are the
 * only source that separates the two, and the absence of an `import` admission
 * is the fail-closed answer — it reads as authored here, which is what an
 * amendment is.
 */
export function revisionAdmittedByImport(
  admissions: readonly SpecGateAdmissionView[],
  revisionId: string | null | undefined,
): boolean {
  if (revisionId === null || revisionId === undefined) return false;
  return admissions.some(
    (admission) =>
      admission.basis === "import" && admission.revisionId === revisionId,
  );
}

/**
 * Whether a record's settling act — an answer, a disposition — arrived with the
 * import rather than being performed here. The import writes the row and stamps
 * its settling instant from the same clock read it stamps the admissions with,
 * so an exact match is the whole test. A human who answers an imported question
 * later stamps a different instant and keeps the credit for the act they took.
 */
export function settledAtImport(
  settledAt: string | null,
  importedAt: string | null,
): boolean {
  return importedAt !== null && settledAt === importedAt;
}
