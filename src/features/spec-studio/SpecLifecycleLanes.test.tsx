// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import SpecLifecycleLanes from "./SpecLifecycleLanes";

describe("SpecLifecycleLanes", () => {
  it("does not present requirements as approved while its draft is under review", () => {
    const detail = specControlsDetailFixture();
    if (!detail.currentRevision) throw new Error("fixture needs a revision");
    detail.currentRevision.revision.state = "draft";
    detail.currentRevision.revision.authoringStage = "requirements";

    render(<SpecLifecycleLanes detail={detail} />);

    const specLane = screen.getByRole("group", { name: "Spec lifecycle" });
    expect(within(specLane).getByText("Draft")).toBeVisible();
    expect(within(specLane).queryByText("Requirements approved")).toBeNull();
  });
});
