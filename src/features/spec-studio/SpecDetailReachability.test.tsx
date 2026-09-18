import { describe, expect, it } from "vitest";

import {
  detailStatePresentation,
  resolveRequestedDetailView,
} from "./SpecDetailPage";
import { pendingReaffirmationReview } from "./delivery-plan-review.fixtures";
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
