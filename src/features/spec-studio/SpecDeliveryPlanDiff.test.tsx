// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  deliveryPlanDocumentDiff,
  type DeliveryPlanDocumentDiff,
} from "@/lib/specs/delivery-plan-diff";

import SpecDeliveryPlanDiff from "./SpecDeliveryPlanDiff";
import { reviewDocument } from "./delivery-plan-review.fixtures";

/**
 * The diff is computed by the server projection under test elsewhere; this
 * builds it from the same production function so the surface is exercised
 * against a shape the server can actually produce.
 */
function reproposalDiff(): DeliveryPlanDocumentDiff {
  const base = reviewDocument();
  const target = reviewDocument();
  const [first] = target.contexts;
  if (first === undefined) {
    throw new Error("fixture lost its contexts");
  }
  target.contexts = [
    { ...first, title: "Attempt document, lint, and removal" },
    {
      contextId: "dpa-integration",
      title: "Wire the surfaces together",
      contextType: "integration",
      criterionElementIds: [],
      acceptanceContract: ["The surfaces compose."],
      proofPlan: [],
    },
  ];
  target.tasks = target.tasks.filter(
    (task) => task.contextId !== "dpa-closeout",
  );
  target.edges = [];
  const [soft, hard, done] = target.dispositions;
  if (soft === undefined || hard === undefined || done === undefined) {
    throw new Error("fixture lost its dispositions");
  }
  target.dispositions = [{ ...soft, disposition: "deferred" }, hard, done];
  return deliveryPlanDocumentDiff(base, target);
}

function renderDiff(): void {
  render(
    <SpecDeliveryPlanDiff
      diff={reproposalDiff()}
      fromLabel="draft revision 3"
      toLabel="draft revision 4"
    />,
  );
}

describe("SpecDeliveryPlanDiff", () => {
  it("names the two proposals it compared", () => {
    renderDiff();

    expect(
      screen.getByText("draft revision 3 → draft revision 4"),
    ).toBeVisible();
  });

  it("reports contexts the re-proposal added and removed", () => {
    renderDiff();

    const added = document.querySelector<HTMLElement>(
      '[data-diff-context="dpa-integration"]',
    );
    const removed = document.querySelector<HTMLElement>(
      '[data-diff-context="dpa-closeout"]',
    );
    expect(added).not.toBeNull();
    expect(removed).not.toBeNull();
    if (added === null || removed === null) return;
    expect(within(added).getByText("added")).toBeVisible();
    expect(within(removed).getByText("removed")).toBeVisible();
  });

  it("names the aspects a surviving context changed in", () => {
    renderDiff();

    const changed = document.querySelector<HTMLElement>(
      '[data-diff-context="dpa-document"]',
    );
    expect(changed).not.toBeNull();
    if (changed === null) return;
    expect(within(changed).getByText("changed")).toBeVisible();
    expect(within(changed).getByText(/title.*dependency edges/)).toBeVisible();
  });

  it("reports every disposition that moved", () => {
    renderDiff();

    const moved = document.querySelector<HTMLElement>(
      '[data-diff-criterion="c-soft"]',
    );
    expect(moved).not.toBeNull();
    if (moved === null) return;
    expect(
      within(moved).getByText("pending_reaffirmation → deferred"),
    ).toBeVisible();
  });

  it("says plainly when a re-proposal moved nothing", () => {
    render(
      <SpecDeliveryPlanDiff
        diff={deliveryPlanDocumentDiff(reviewDocument(), reviewDocument())}
        fromLabel="draft revision 3"
        toLabel="draft revision 4"
      />,
    );

    expect(
      screen.getByText("No context was added, removed, or changed."),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Every criterion carries the disposition it did before.",
      ),
    ).toBeVisible();
  });
});
