import { createLogger } from "@/lib/logging";
import type { Spec, ActorProvenance, Refusal } from "./schemas";
import type { ServiceResult } from "./evidence-service";
import type { DeliveryReviewService } from "./delivery-review-service";
import type { ReviewService } from "./review-service";
import type {
  DeliveryApprovalRequest,
  DeliveryReviewView,
} from "./delivery-review-schemas";

const logger = createLogger("specs.delivery-approval");

export interface DeliveryApprovalDeps {
  read(spec: Spec, executionId?: string): Promise<DeliveryReviewView | null>;
  acceptance: DeliveryReviewService;
  review: Pick<ReviewService, "grantGateApproval">;
}

function refuse(
  code: Refusal["code"],
  conditions: string[],
): ServiceResult<never> {
  logger.warn("specs.delivery-approval.refused", { code, conditions });
  return {
    ok: false,
    refusal: {
      code,
      unmetConditions: conditions,
      instruction:
        "Refresh the delivery review and settle its remaining blockers.",
    },
  };
}

export function createDeliveryApprovalService(deps: DeliveryApprovalDeps) {
  return {
    async approve(
      input: DeliveryApprovalRequest & { spec: Spec; actor: ActorProvenance },
    ): Promise<ServiceResult<DeliveryReviewView>> {
      if (input.actor.kind !== "human")
        return refuse("human_act_required", [
          "Delivery approval requires a human in Spec Studio.",
        ]);
      const view = await deps.read(input.spec, input.executionId);
      if (
        !view ||
        view.execution?.id !== input.executionId ||
        view.revisionId !== input.revisionId
      )
        return refuse("not_found", [
          "This delivery review no longer identifies the requested execution and revision.",
        ]);
      if (view.execution.state !== "running" || input.spec.abandonedAt)
        return refuse("gate_blocked", [
          "Choose an active delivery path before approving a merge.",
        ]);
      if (
        view.contentHash !== input.expectedContentHash ||
        view.lastReviewId !== input.expectedReviewId
      )
        return refuse("stale_revision", [
          "The revision or acceptance decisions changed while this review was open.",
        ]);
      const executionBlockers = view.blockers.filter(
        (blocker) => blocker.kind === "execution",
      );
      if (executionBlockers.length)
        return refuse(
          "gate_blocked",
          executionBlockers.map((blocker) => blocker.reason),
        );
      const unresolved = view.criteria.filter(
        (criterion) =>
          criterion.inScope && criterion.outcome === "needs_review",
      );
      if (unresolved.length && !input.waiveRemaining)
        return refuse(
          "gate_blocked",
          unresolved.map(
            (criterion) =>
              `${criterion.handle} needs acceptance or an evidence waiver.`,
          ),
        );
      let expectedReviewId = view.lastReviewId;
      if (unresolved.length) {
        const recorded = await deps.acceptance.record({
          specId: input.spec.id,
          revisionId: view.revisionId,
          expectedContentHash: view.contentHash,
          expectedReviewId: view.lastReviewId,
          criterionIds: unresolved.map((criterion) => criterion.id),
          decision: "waived",
          note: input.note,
          actor: input.actor,
        });
        if (!recorded.ok) return recorded;
        expectedReviewId = recorded.value.id;
      }
      const ready = await deps.read(input.spec, input.executionId);
      if (
        !ready ||
        ready.execution?.state !== "running" ||
        ready.contentHash !== view.contentHash ||
        ready.lastReviewId !== expectedReviewId
      )
        return refuse("stale_revision", [
          "Delivery changed before approval could be recorded.",
        ]);
      const remaining = ready.blockers.filter(
        (blocker) => blocker.kind !== "approval",
      );
      if (remaining.length)
        return refuse(
          "gate_blocked",
          remaining.map((blocker) => blocker.reason),
        );
      const granted = await deps.review.grantGateApproval({
        specId: input.spec.id,
        revisionId: view.revisionId,
        executionId: input.executionId,
        gate: "delivery",
        approver: "operator",
        actor: input.actor,
      });
      if (!granted.ok) return granted;
      const approved = await deps.read(input.spec, input.executionId);
      if (!approved)
        return refuse("not_found", [
          "The approved delivery review is unavailable.",
        ]);
      if (approved.blockers.length)
        return refuse(
          "gate_blocked",
          approved.blockers.map((blocker) => blocker.reason),
        );
      logger.info("specs.delivery-approval.granted", {
        specId: input.spec.id,
        revisionId: view.revisionId,
        executionId: input.executionId,
        waivedCriterionCount: unresolved.length,
        reviewId: expectedReviewId,
      });
      return { ok: true, value: approved };
    },
  };
}
export type DeliveryApprovalService = ReturnType<
  typeof createDeliveryApprovalService
>;
