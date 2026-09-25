// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import {
  pendingReaffirmationReview,
  reviewView,
} from "./delivery-plan-review.fixtures";
import SpecLifecycleLanes from "./SpecLifecycleLanes";

describe("SpecLifecycleLanes", () => {
  it("distinguishes pending reaffirmation from the approved spec and earlier delivery", () => {
    render(
      <SpecLifecycleLanes
        detail={specControlsDetailFixture()}
        deliveryPlan={pendingReaffirmationReview()}
      />,
    );
    expect(
      within(
        screen.getByRole("group", { name: "Delivery lifecycle" }),
      ).getByText("Reaffirmation needed · 2"),
    ).toBeVisible();
  });
  it("marks a draft plan without blockers ready for sign-off", () => {
    render(
      <SpecLifecycleLanes
        detail={specControlsDetailFixture()}
        deliveryPlan={reviewView()}
      />,
    );
    const deliveryLane = screen.getByRole("group", {
      name: "Delivery lifecycle",
    });
    expect(
      within(deliveryLane).getByText("Ready for sign-off"),
    ).toHaveAttribute("data-tone", "amber");
    expect(within(deliveryLane).queryByText(/in review/i)).toBeNull();
  });

  it("shows an older execution alongside a newer requirements extension", () => {
    const detail = specControlsDetailFixture("running");
    const approved = detail.currentApprovedRevision;
    if (!approved || !detail.currentRevision)
      throw new Error("fixture needs revisions");
    detail.currentRevision = {
      ...detail.currentRevision,
      revision: {
        ...detail.currentRevision.revision,
        id: "revision-extension",
        number: approved.revision.number + 1,
        state: "draft",
        authoringStage: "requirements",
        basedOnRevisionId: approved.revision.id,
        approvedAt: null,
      },
    };

    render(
      <SpecLifecycleLanes
        detail={detail}
        deliveryPlan={reviewView({ attempt: { status: "launched" } })}
      />,
    );

    const specLane = screen.getByRole("group", { name: "Spec lifecycle" });
    expect(within(specLane).getByText(/Requirements extension/)).toBeVisible();
    expect(within(specLane).getByText(/Draft/)).toBeVisible();
    const deliveryLane = screen.getByRole("group", {
      name: "Delivery lifecycle",
    });
    expect(within(deliveryLane).getByText(/Execution/)).toBeVisible();
    expect(within(deliveryLane).getAllByText(/pinned revision/i)).toHaveLength(
      2,
    );
  });

  it("does not present requirements as approved while its draft is under review", () => {
    const detail = specControlsDetailFixture();
    if (!detail.currentRevision) throw new Error("fixture needs a revision");
    detail.currentRevision.revision.state = "draft";
    detail.currentRevision.revision.authoringStage = "requirements";

    render(<SpecLifecycleLanes detail={detail} deliveryPlan={null} />);

    const specLane = screen.getByRole("group", { name: "Spec lifecycle" });
    expect(within(specLane).getByText("Draft")).toBeVisible();
    expect(within(specLane).queryByText("Requirements approved")).toBeNull();
  });
});
