import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { DeliveryReviewView } from "@/lib/specs/delivery-review-schemas";
import SpecDeliveryReview from "./SpecDeliveryReview";
import { deliveryReviewFixture } from "./SpecDeliveryReview.fixtures";

function InteractiveReview({
  initial = deliveryReviewFixture(),
  error,
}: {
  initial?: DeliveryReviewView;
  error?: string;
}) {
  const [view, setView] = useState(initial);
  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto max-w-[1000px] p-lg">
        <div className="mb-lg font-mono text-[0.7rem] text-text-tertiary">
          SPEC STUDIO / DELIVERY
        </div>
        <SpecDeliveryReview
          view={view}
          error={error}
          onReview={async (input) => {
            const review = {
              id: `review-${view.history.length + 1}`,
              specId: "spec",
              revisionId: view.revisionId,
              decision: input.decision,
              note: input.note,
              actor: { kind: "human" as const },
              createdAt: new Date().toISOString(),
              criteria: input.criterionIds.map((criterionId) => ({
                criterionId,
                contentHash: "contract",
              })),
            };
            setView({
              ...view,
              lastReviewId: review.id,
              history: [...view.history, review],
              criteria: view.criteria.map((criterion) =>
                input.criterionIds.includes(criterion.id)
                  ? {
                      ...criterion,
                      humanReview:
                        review.decision === "revoked" ? null : review,
                      outcome:
                        review.decision === "revoked"
                          ? "needs_review"
                          : review.decision,
                    }
                  : criterion,
              ),
            });
          }}
          onApprove={async () => {
            setView({ ...view, approvalGranted: true });
          }}
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Specs/Studio/DeliveryReview",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unresolved: Story = { render: () => <InteractiveReview /> };
export const MixedEvidence: Story = {
  render: () => {
    const initial = deliveryReviewFixture(12);
    initial.criteria = initial.criteria.map((criterion, index) => ({
      ...criterion,
      outcome: index < 4 ? "proven" : index < 8 ? "satisfied" : "needs_review",
      automated:
        index < 4
          ? ["The delivery context passed its required verification."]
          : [],
    }));
    return <InteractiveReview initial={initial} />;
  },
};
export const StaleReview: Story = {
  render: () => (
    <InteractiveReview error="The delivery decisions changed while this review was open. Refresh before applying your selection." />
  ),
};
export const Empty: Story = {
  render: () => <InteractiveReview initial={deliveryReviewFixture(0)} />,
};
