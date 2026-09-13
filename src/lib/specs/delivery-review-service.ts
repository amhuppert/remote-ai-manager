import { z } from "zod";
import { createLogger } from "@/lib/logging";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
import type { SpecDeliveryRepo } from "@/lib/state-store/spec-delivery-repo";
import type {
  SpecEventsPublisher,
  PreparedSpecEventPublication,
} from "./events";
import {
  actorProvenanceSchema,
  type SpecAcceptanceReview,
  type Refusal,
} from "./schemas";
import type { ServiceResult } from "./evidence-service";
import { criterionAcceptanceHash } from "./acceptance-review";

const logger = createLogger("specs.delivery-review");

function refuse(
  code: Refusal["code"],
  condition: string,
): ServiceResult<never> {
  logger.warn("specs.delivery-review.refused", { code, condition });
  return {
    ok: false,
    refusal: {
      code,
      unmetConditions: [condition],
      instruction:
        "Refresh the delivery review and apply the decision to its current selection.",
    },
  };
}

import { acceptanceReviewRequestSchema } from "./delivery-review-schemas";

const recordInputSchema = acceptanceReviewRequestSchema.extend({
  specId: z.string().min(1),
  actor: actorProvenanceSchema,
});

export interface DeliveryReviewServiceDeps {
  specs: SpecsRepo;
  delivery: Pick<
    SpecDeliveryRepo,
    "insertAcceptanceReview" | "findAcceptanceReviewsBySpecId"
  >;
  events: SpecEventsPublisher;
  nextId(): string;
  now(): string;
}

export function createDeliveryReviewService(deps: DeliveryReviewServiceDeps) {
  return {
    async record(
      input: z.infer<typeof recordInputSchema>,
    ): Promise<ServiceResult<SpecAcceptanceReview>> {
      const parsed = recordInputSchema.parse(input);
      if (parsed.actor.kind !== "human")
        return refuse(
          "human_act_required",
          "Acceptance decisions require a human in Spec Studio.",
        );
      if (parsed.decision === "waived" && !parsed.note.trim())
        return refuse(
          "validation",
          "Waiving evidence requires one reason for the batch.",
        );
      const publications: PreparedSpecEventPublication[] = [];
      const result = await deps.specs.transaction<
        ServiceResult<SpecAcceptanceReview>
      >("specs.delivery-review.record", (repo) => {
        const spec = repo.findById(parsed.specId);
        const snapshot = repo.getRevisionSnapshot(parsed.revisionId);
        if (!spec || !snapshot || snapshot.revision.specId !== spec.id)
          return refuse(
            "not_found",
            "The review revision does not belong to this spec.",
          );
        if (spec.abandonedAt || snapshot.revision.state !== "approved")
          return refuse(
            "gate_blocked",
            "Delivery reviews require an active spec and an approved revision.",
          );
        const reviews = deps.delivery.findAcceptanceReviewsBySpecId(spec.id);
        if (
          snapshot.revision.contentHash !== parsed.expectedContentHash ||
          (reviews.at(-1)?.id ?? null) !== parsed.expectedReviewId
        )
          return refuse(
            "stale_revision",
            "The revision or delivery decisions changed while this review was open.",
          );
        const criteria: SpecAcceptanceReview["criteria"] = [];
        for (const criterionId of new Set(parsed.criterionIds)) {
          const contentHash = criterionAcceptanceHash(snapshot, criterionId);
          if (contentHash === null)
            return refuse(
              "not_found",
              `Criterion ${criterionId} is not in the reviewed revision.`,
            );
          criteria.push({ criterionId, contentHash });
        }
        const review: SpecAcceptanceReview = {
          id: deps.nextId(),
          specId: spec.id,
          revisionId: parsed.revisionId,
          decision: parsed.decision,
          note: parsed.note.trim(),
          actor: parsed.actor,
          criteria,
          createdAt: deps.now(),
        };
        deps.delivery.insertAcceptanceReview(review);
        publications.push(
          deps.events.appendInTransaction({
            actor: parsed.actor,
            durableEventType: "spec-evidence-changed",
            durablePayload: { kind: "acceptance-reviewed", review },
            sseEvent: {
              type: "spec-evidence-changed",
              kind: "acceptance-reviewed",
              projectPath: spec.projectPath,
              specId: spec.id,
              specSlug: spec.slug,
              occurredAt: review.createdAt,
              revisionId: parsed.revisionId,
            },
          }),
        );
        return { ok: true, value: review };
      });
      for (const event of publications) deps.events.publishAfterCommit(event);
      if (result.ok)
        logger.info("specs.delivery-review.recorded", {
          specId: result.value.specId,
          revisionId: result.value.revisionId,
          reviewId: result.value.id,
          decision: result.value.decision,
          criterionCount: result.value.criteria.length,
        });
      return result;
    },
  };
}
export type DeliveryReviewService = ReturnType<
  typeof createDeliveryReviewService
>;
