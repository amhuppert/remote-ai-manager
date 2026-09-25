// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecAuthoringStage } from "@/lib/specs/schemas";

import { draftingSpecControlsDetailFixture } from "./SpecControls.fixtures";
import { detailStatePresentation, SpecRevisionBanner } from "./SpecDetailPage";

const detailHref = "/specs/command-center/native-sdd";

function draftDetail(
  stage: SpecAuthoringStage,
  pendingCount: number,
): SpecDetailView {
  const detail = draftingSpecControlsDetailFixture(stage);
  detail.status.phase = { primary: "draft", authoringStage: stage };
  detail.status.pendingApprovals = Array.from(
    { length: pendingCount },
    (_, index) => ({
      gate: stage,
      subject: `${stage === "design" ? "D" : "R"}${index + 1}`,
      elementId: null,
    }),
  );
  return detail;
}

function renderBanner(detail: SpecDetailView): HTMLElement {
  render(
    <SpecRevisionBanner
      detail={detail}
      presentation={detailStatePresentation(
        detail.status.phase.primary,
        detail.status.pendingApprovals,
        detail.status.phase.authoringStage,
      )}
      detailHref={detailHref}
    />,
  );
  return screen.getByRole("region", { name: "Spec status" });
}

describe("SpecRevisionBanner pending approvals", () => {
  it.each([
    ["requirements", "requirements"],
    ["design", "design"],
  ] as const)(
    "links an open %s draft's approvals to the %s review",
    (stage, view) => {
      const banner = renderBanner(draftDetail(stage, 13));

      expect(
        within(banner).getByRole("link", {
          name: "13 pending approvals — review",
        }),
      ).toHaveAttribute("href", `${detailHref}?view=${view}`);
    },
  );

  it("tells the reviewer the draft stays open until sign-off freezes it", () => {
    const banner = renderBanner(draftDetail("requirements", 2));

    expect(banner).toHaveTextContent(
      "Review and approve while the draft is open; sign-off freezes it.",
    );
    expect(banner).not.toHaveTextContent(/once proposed/i);
  });
});
