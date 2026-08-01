import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";

import { specControlsDetailFixture } from "./SpecControls.fixtures";
import {
  buildRailGroups,
  detailStatePresentation,
  resolveDeepLinkId,
} from "./SpecDetailPage";

describe("buildRailGroups", () => {
  it("keeps the prototype's four structured rail groups even when one is empty", () => {
    const detail: SpecDetailView = {
      ...specControlsDetailFixture(),
      questions: [
        {
          id: "question-1",
          number: 1,
          handle: "Q1",
          elementId: null,
          text: "Should imported history retain admissions?",
          status: "open",
          answer: null,
          answeredAt: null,
          provenance: null,
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:00:00.000Z",
        },
      ],
      assumptions: [
        {
          id: "assumption-1",
          number: 1,
          handle: "A1",
          elementId: null,
          text: "Execution history is append-only.",
          disposition: "proposed",
          disposedAt: null,
          proposedBy: null,
          createdAt: "2026-07-18T12:00:00.000Z",
          updatedAt: "2026-07-18T12:00:00.000Z",
        },
      ],
    };

    const groups = buildRailGroups(detail);

    expect(groups.map((group) => group.label)).toEqual([
      "Requirements",
      "Decisions",
      "Questions & assumptions",
      "Tasks",
    ]);
    expect(groups[0]?.items.map((item) => item.handle)).toEqual(["R1"]);
    expect(groups[0]?.items[0]?.criteria?.map((item) => item.handle)).toEqual([
      "R1.1",
    ]);
    expect(groups[1]?.items).toEqual([]);
    expect(groups[2]?.items.map((item) => item.handle)).toEqual(["Q1", "A1"]);
    expect(groups[3]?.items.map((item) => item.handle)).toEqual(["T1"]);
  });
});

describe("detailStatePresentation", () => {
  it("derives the phase-specific primary action without inventing a new mutation", () => {
    expect(detailStatePresentation("approved", [], "plan")).toMatchObject({
      tone: "green",
      banner: "Ready to execute",
      action: "Start execution",
      view: "execution",
    });
    expect(detailStatePresentation("executing", [])).toMatchObject({
      tone: "cyan",
      banner: "Execution active",
      action: "Open evidence",
      view: "evidence",
    });
    expect(detailStatePresentation("in_review", [])).toMatchObject({
      tone: "amber",
      banner: "Revision awaits sign-off",
      action: "Review revision",
      view: "review",
    });
    expect(detailStatePresentation("delivered", []).action).toBeNull();
    expect(detailStatePresentation("abandoned", []).action).toBeNull();
  });

  it("keeps execution unavailable until the Plan stage is approved", () => {
    expect(
      detailStatePresentation("approved", [], "requirements"),
    ).toMatchObject({
      banner: "Requirements approved",
      action: null,
      view: null,
    });
    expect(detailStatePresentation("approved", [], "design")).toMatchObject({
      banner: "Design approved",
      action: null,
      view: null,
    });
  });

  it("points the executing CTA at the pending delivery approval when one exists", () => {
    const deliveryPending = [
      { gate: "delivery" as const, subject: "delivery", elementId: null },
    ];

    expect(detailStatePresentation("executing", deliveryPending)).toEqual({
      tone: "amber",
      banner: "Execution active — approval needed",
      description:
        "The delivery gate is waiting on a human approval; proof continues against the pinned revision.",
      action: "Approve delivery",
      view: "execution",
      el: "delivery",
    });
    // Authoring-gate approvals do not hijack the evidence CTA.
    expect(
      detailStatePresentation("executing", [
        { gate: "design" as const, subject: "D1", elementId: "decision-1" },
      ]),
    ).toMatchObject({ action: "Open evidence", view: "evidence" });
  });
});

describe("resolveDeepLinkId", () => {
  it("maps the delivery deep link onto the merge-gate panel target", () => {
    expect(resolveDeepLinkId("delivery", "native-sdd")).toBe("merge-gate");
    expect(resolveDeepLinkId("R1", "native-sdd")).toBe("R1");
    expect(resolveDeepLinkId(null, "native-sdd")).toBeNull();
  });
});
