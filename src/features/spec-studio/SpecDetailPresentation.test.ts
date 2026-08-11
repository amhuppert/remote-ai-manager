import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";

import {
  importedDeliveredSpecDetailFixture,
  importedThenAmendedSpecDetailFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import { reviewView } from "./delivery-plan-review.fixtures";
import {
  buildRailGroups,
  detailStatePresentation,
  resolveDeepLinkId,
  revisionLine,
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

  /**
   * The rail is the detail's at-a-glance proof column. An imported
   * requirement's obligation is settled but unproven, so it takes neither the
   * green Proven badge nor the amber unfinished ones (R9.4).
   */
  it("labels an externally-delivered requirement without claiming proof", () => {
    const detail: SpecDetailView = {
      ...specControlsDetailFixture(),
      elementStatuses: {
        requirements: [
          {
            elementId: "requirement-1",
            status: {
              approval: "valid",
              coverage: "covered",
              proof: "delivered_externally",
            },
          },
        ],
        tasks: [],
      },
    };

    const requirement = buildRailGroups(detail)[0]?.items[0];

    expect(requirement?.status).toBe("Delivered externally");
    expect(requirement?.statusTone).toBe("neutral");
  });
});

describe("revisionLine", () => {
  it("attributes an imported revision to import rather than to approval", () => {
    // Zero approval rows back an imported revision, so the header line must
    // not read like a human signed it off.
    const line = revisionLine(importedDeliveredSpecDetailFixture(), 1);

    expect(line).not.toMatch(/\brev 1 approved\b/);
    expect(line).toContain("admitted by import");
  });

  it("still reports approval for a natively authored revision", () => {
    expect(revisionLine(specControlsDetailFixture(), 1)).toContain("approved");
  });

  it("attributes each revision of an amended import to its own admission", () => {
    // Revision 2 was authored here and signed off by a human while the
    // spec-level `imported` bit stays true, so the same line must credit the
    // human for revision 2 and the import for the revision 1 it is based on.
    const line = revisionLine(importedThenAmendedSpecDetailFixture(), 2);

    expect(line).toContain("rev 2 approved");
    expect(line).toContain("rev 1 admitted by import");
  });
});

describe("detailStatePresentation", () => {
  it("derives the phase-specific primary action without inventing a new mutation", () => {
    expect(
      detailStatePresentation(
        "approved",
        [],
        "design",
        reviewView({
          attempt: { status: "approved" },
          approval: {
            snapshotId: "snapshot-2",
            candidateId: "candidate-2",
            planHash: "sha256:plan-2",
            compiledDefinitionHash: "sha256:compiled-2",
            approvedAt: "2026-08-08T10:00:00.000Z",
            approvedBy: { kind: "human" },
          },
        }),
      ),
    ).toMatchObject({
      tone: "green",
      banner: "Ready to execute",
      action: "Start execution",
      view: "plan",
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

  it("never calls an externally delivered spec proven", () => {
    // An imported spec reaches `delivered` on the source's testimony with no
    // proof taken here, so the banner that speaks for the whole phase must not
    // borrow the vocabulary of proof this system never performed.
    const presentation = detailStatePresentation(
      "delivered",
      [],
      "design",
      undefined,
      {
        allWaived: false,
        deliveredCount: 35,
        provenCount: 0,
        totalInScope: 35,
        deliveredExternallyCriterionIds: Array.from(
          { length: 35 },
          (_, index) => `criterion-${index + 1}`,
        ),
      },
    );

    expect(presentation.banner).toBe("Delivered externally");
    expect(presentation.banner).not.toContain("proven");
    expect(presentation.description).toContain("delivered externally");
    // "none proven here" denies proof rather than claiming it, so the check is
    // on what the copy asserts, not on whether the word appears.
    expect(presentation.description).toContain("none proven here");
    expect(presentation.description).not.toContain("is proven");
  });

  it("does not call an imported spec's frozen stage approved", () => {
    // A bundle imported with "delivered": false lands in the approved phase
    // with zero approval rows behind it, so the banner that speaks for the
    // whole phase must not read like a human froze it.
    const presentation = detailStatePresentation(
      "approved",
      [],
      "requirements",
      undefined,
      undefined,
      true,
    );

    expect(presentation.banner).not.toContain("approved");
    expect(presentation.banner).toBe("Requirements admitted by import");
  });

  it("still reports proof for a spec this system actually proved", () => {
    const presentation = detailStatePresentation(
      "delivered",
      [],
      "design",
      undefined,
      {
        allWaived: false,
        deliveredCount: 4,
        provenCount: 4,
        totalInScope: 4,
        deliveredExternallyCriterionIds: [],
      },
    );

    expect(presentation.banner).toBe("Delivery proven");
  });

  it("keeps execution unavailable until the delivery-plan candidate is approved", () => {
    expect(
      detailStatePresentation("approved", [], "requirements"),
    ).toMatchObject({
      banner: "Requirements approved",
      action: null,
      view: null,
    });
    expect(
      detailStatePresentation("approved", [], "design", null),
    ).toMatchObject({
      banner: "Design approved",
      action: "Open delivery plan",
      view: "plan",
    });
    expect(detailStatePresentation("approved", [], "plan", null)).toMatchObject(
      {
        banner: "Design approved",
        action: "Open delivery plan",
        view: "plan",
      },
    );
    expect(
      detailStatePresentation(
        "approved",
        [],
        "design",
        reviewView({ attempt: { status: "proposed" } }),
      ),
    ).toMatchObject({
      banner: "Delivery plan awaits approval",
      action: "Review delivery plan",
      view: "plan",
    });
    expect(
      detailStatePresentation(
        "approved",
        [],
        "design",
        reviewView({
          attempt: { status: "launched" },
          approval: {
            snapshotId: "snapshot-2",
            candidateId: "candidate-2",
            planHash: "sha256:plan-2",
            compiledDefinitionHash: "sha256:compiled-2",
            approvedAt: "2026-08-08T10:00:00.000Z",
            approvedBy: { kind: "human" },
          },
        }),
      ),
    ).toMatchObject({
      banner: "Delivery plan launched",
      action: "Open execution",
      view: "execution",
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
