import {
  specExecutionRowSchema,
  type SpecExecutionRow,
} from "@/lib/specs/schemas";
import type { DeliveryReviewView } from "@/lib/specs/delivery-review-schemas";

export function deliveryReviewFixture(count = 24): DeliveryReviewView {
  return {
    revisionId: "revision-3",
    revisionNumber: 3,
    contentHash: "contract",
    lastReviewId: null,
    execution: specExecutionRowSchema.parse({
      id: "execution-3",
      spec_id: "spec",
      revision_id: "revision-3",
      scope_json: JSON.stringify({
        selectedTaskIds: [],
        selectedCriterionIds: Array.from(
          { length: count },
          (_, index) => `criterion-${index + 1}`,
        ),
        exclusionDispositions: [],
      }),
      state: "running",
      execution_start_dial: null,
      workflow_definition_id: null,
      workflow_definition_revision: null,
      workflow_execution_id: null,
      session_name: "delivery-session",
      delivered_at: null,
      abandoned_reason: null,
      cleanup_phase: null,
      linked_workflow_execution_id: null,
      cleanup_last_error: null,
      cleanup_last_error_at: null,
      created_at: "2026-09-12T12:00:00Z",
      updated_at: "2026-09-12T12:00:00Z",
      delivery_basis_json: JSON.stringify({
        kind: "session",
        sourceSpecExecutionIds: [],
        sourceWorkflowExecutionIds: [],
        commitRefs: [],
        note: "",
        actor: { kind: "human" },
        createdAt: "2026-09-12T12:00:00Z",
      }),
    } satisfies SpecExecutionRow),
    delivered: false,
    approvalGranted: false,
    requiresApproval: true,
    blockers: [],
    history: [],
    criteria: Array.from({ length: count }, (_, index) => ({
      id: `criterion-${index + 1}`,
      handle: `R${Math.floor(index / 4) + 1}.${(index % 4) + 1}`,
      text:
        [
          "Keep the approved requirements and design available after delivery.",
          "Record each delivery decision with its author and scope.",
          "Continue delivery when a workflow has been abandoned.",
          "Surface approval before merge validation begins.",
        ][index % 4] ?? "Deliver the criterion.",
      requirement:
        [
          "Durable specification",
          "Human acceptance",
          "Execution recovery",
          "Merge readiness",
          "Delivery history",
          "Review ergonomics",
        ][Math.floor(index / 4)] ?? "Delivery",
      inScope: true,
      outcome: "needs_review",
      automated: [],
      humanReview: null,
    })),
  };
}
