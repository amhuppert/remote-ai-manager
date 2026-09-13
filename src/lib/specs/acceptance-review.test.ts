import { describe, expect, it } from "vitest";
import { applicableAcceptanceReview } from "./acceptance-review";
import type { SpecAcceptanceReview } from "./schemas";

const review: SpecAcceptanceReview = {
  id: "review-1",
  specId: "spec",
  revisionId: "revision-1",
  decision: "satisfied",
  note: "",
  actor: { kind: "human" },
  criteria: [
    { criterionId: "criterion-a", contentHash: "contract-a" },
    { criterionId: "criterion-b", contentHash: "contract-b" },
  ],
  createdAt: "2026-09-12T12:00:00Z",
};

describe("acceptance review applicability", () => {
  it("keeps one bulk human decision applicable when the delivery workflow changes", () => {
    expect(
      applicableAcceptanceReview([review], "criterion-a", "contract-a"),
    ).toEqual(review);
    expect(
      applicableAcceptanceReview([review], "criterion-b", "contract-b"),
    ).toEqual(review);
  });

  it("reopens only the criterion whose governing content changed", () => {
    expect(
      applicableAcceptanceReview([review], "criterion-a", "changed"),
    ).toBeNull();
    expect(
      applicableAcceptanceReview([review], "criterion-b", "contract-b"),
    ).toEqual(review);
  });

  it("honors the latest revocation without falling back to an older acceptance", () => {
    const revoked: SpecAcceptanceReview = {
      ...review,
      id: "review-2",
      decision: "revoked",
      criteria: [{ criterionId: "criterion-a", contentHash: "contract-a" }],
    };
    expect(
      applicableAcceptanceReview(
        [review, revoked],
        "criterion-a",
        "contract-a",
      ),
    ).toBeNull();
    expect(
      applicableAcceptanceReview(
        [review, revoked],
        "criterion-b",
        "contract-b",
      ),
    ).toEqual(review);
  });
});
