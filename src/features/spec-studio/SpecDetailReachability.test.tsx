import { describe, expect, it } from "vitest";

import {
  detailStatePresentation,
  resolveRequestedDetailView,
} from "./SpecDetailPage";
import {
  pendingReaffirmationReview,
  reviewView,
} from "./delivery-plan-review.fixtures";
import { initialDetailViewForDeepLink } from "./SpecDetailViews";

describe("Spec Studio surface reachability", () => {
  it.each(["approved", "delivered"] as const)(
    "routes %s specs with pending reaffirmation to the required human action",
    (phase) => {
      expect(
        detailStatePresentation(
          phase,
          [],
          "design",
          pendingReaffirmationReview(),
        ),
      ).toMatchObject({
        tone: "amber",
        banner: "Acceptance criteria need reaffirmation",
        action: "Review criteria",
        view: "delivery",
      });
    },
  );
  it("sends a delivery plan ready for sign-off straight to Workflow Builder", () => {
    expect(
      detailStatePresentation("approved", [], "design", reviewView()),
    ).toMatchObject({
      tone: "amber",
      banner: "Delivery plan ready for sign-off",
      action: "Review and sign off",
      href: "/projects/command-center/workflows?definition=candidate-2",
    });
  });
  it("keeps a draft plan with blocking findings in draft", () => {
    const blocked = reviewView({
      health: {
        total: 1,
        blocking: 1,
        counts: [{ severity: "blocks_propose", count: 1 }],
        findings: [
          {
            ruleId: "coverage/selected-criterion-uncovered",
            severity: "blocks_propose",
            elementHandle: "R1.1",
            message: "R1.1 is selected but no context claims it.",
          },
        ],
      },
    });
    const presentation = detailStatePresentation(
      "approved",
      [],
      "design",
      blocked,
    );
    expect(presentation).toMatchObject({
      banner: "Delivery plan in draft",
      action: "Open delivery",
      view: "delivery",
    });
    expect(presentation.href).toBeUndefined();
  });
  it.each([
    ["requirements", "requirements"],
    ["design", "design"],
  ] as const)(
    "sends an open %s draft's primary action to the %s review",
    (stage, view) => {
      expect(detailStatePresentation("draft", [], stage)).toMatchObject({
        action: "Review changes",
        view,
      });
    },
  );

  it.each([
    ["R1", "requirements"],
    ["R1.1", "requirements"],
    ["Q1", "requirements"],
    ["A1", "requirements"],
    ["D1", "design"],
    ["T1", "history"],
    ["delivery", "delivery"],
    ["launch", "delivery"],
    ["execution_start", "delivery"],
  ] as const)("routes deep link %s to %s", (handle, view) => {
    expect(initialDetailViewForDeepLink(handle, "native-sdd")).toBe(view);
  });

  it.each([
    "overview",
    "requirements",
    "design",
    "delivery",
    "gate-policy",
    "history",
  ])("accepts the selected %s destination", (view) => {
    expect(resolveRequestedDetailView(view, null, "native-sdd")).toBe(view);
  });

  it.each([
    "review",
    "questions",
    "execution",
    "gate",
    "tasks",
    "evidence",
    "traceability",
    "lint",
    "integrity",
    "verify",
    "plan",
  ])("floors retired destination %s to Overview", (view) => {
    expect(resolveRequestedDetailView(view, null, "native-sdd")).toBe(
      "overview",
    );
  });

  it("uses an element deep link only when no explicit destination was given", () => {
    expect(resolveRequestedDetailView(null, "D1", "native-sdd")).toBe("design");
    expect(resolveRequestedDetailView("removed", "D1", "native-sdd")).toBe(
      "overview",
    );
  });
});
