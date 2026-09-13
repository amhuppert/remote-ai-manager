import type { SpecAcceptanceReview, SpecRevisionSnapshot } from "./schemas";

export function criterionAcceptanceHash(
  snapshot: SpecRevisionSnapshot,
  criterionId: string,
): string | null {
  const criterion = snapshot.elements.find(
    (entry) =>
      entry.element.id === criterionId &&
      entry.version.payload.kind === "criterion",
  );
  if (!criterion) return null;
  const requirement = snapshot.elements.find(
    (entry) => entry.element.id === criterion.element.parentElementId,
  );
  return JSON.stringify([
    criterion.version.payloadHash,
    requirement?.version.payloadHash ?? null,
  ]);
}

export function currentAcceptanceReview(
  reviews: readonly SpecAcceptanceReview[],
  criterionId: string,
  contentHash: string,
): SpecAcceptanceReview | null {
  for (const review of [...reviews].reverse()) {
    if (review.actor.kind !== "human") continue;
    const criterion = review.criteria.find(
      (entry) => entry.criterionId === criterionId,
    );
    if (!criterion) continue;
    if (criterion.contentHash !== contentHash) return null;
    return review;
  }
  return null;
}

export function applicableAcceptanceReview(
  reviews: readonly SpecAcceptanceReview[],
  criterionId: string,
  contentHash: string,
): SpecAcceptanceReview | null {
  const review = currentAcceptanceReview(reviews, criterionId, contentHash);
  return review?.decision === "revoked" ? null : review;
}
