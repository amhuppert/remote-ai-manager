// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SpecDeliveryReview from "./SpecDeliveryReview";
import { deliveryReviewFixture } from "./SpecDeliveryReview.fixtures";

describe("delivery review selection", () => {
  it("marks every criterion satisfied, including criteria beyond the collapsed list", async () => {
    const onReview = vi.fn(async () => undefined);
    const view = deliveryReviewFixture(24);
    render(
      <SpecDeliveryReview
        view={view}
        onReview={onReview}
        onApprove={async () => undefined}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select all 24" }));
    expect(screen.getByText("24 selected · Revision 3")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark satisfied" }));
    expect(onReview).toHaveBeenCalledWith(
      expect.objectContaining({
        revisionId: "revision-3",
        decision: "satisfied",
        note: "",
        criterionIds: view.criteria.map((criterion) => criterion.id),
      }),
    );
  });

  it("requires one shared reason to waive a batch", async () => {
    const onReview = vi.fn(async () => undefined);
    render(
      <SpecDeliveryReview
        view={deliveryReviewFixture(2)}
        onReview={onReview}
        onApprove={async () => undefined}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Select all 2" }));
    expect(
      screen.getByRole("button", { name: "Waive evidence" }),
    ).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Review note" }),
      "Accepted without automated proof",
    );
    await user.click(screen.getByRole("button", { name: "Waive evidence" }));
    expect(onReview).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "waived",
        note: "Accepted without automated proof",
        criterionIds: ["criterion-1", "criterion-2"],
      }),
    );
  });
});
