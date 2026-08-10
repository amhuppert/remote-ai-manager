// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  DeliveryPlanCandidatePanel,
  DeliveryPlanDispositionsTable,
} from "./SpecDeliveryPlanDispositions";
import { reviewView } from "./delivery-plan-review.fixtures";

function row(criterionElementId: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-criterion-row="${criterionElementId}"]`,
  );
  if (found === null) throw new Error(`no row for ${criterionElementId}`);
  return found;
}

describe("DeliveryPlanDispositionsTable", () => {
  it("gives every criterion a row carrying its disposition and delivery class", () => {
    render(<DeliveryPlanDispositionsTable criteria={reviewView().criteria} />);

    expect(within(row("c-soft")).getByText("R2.1")).toBeVisible();
    expect(
      within(row("c-soft")).getByText("pending reaffirmation"),
    ).toBeVisible();
    expect(within(row("c-soft")).getByText("soft-stale")).toBeVisible();
    expect(within(row("c-hard")).getByText("hard-stale")).toBeVisible();
    expect(
      within(row("c-done")).getByText("delivered elsewhere"),
    ).toBeVisible();
  });

  /**
   * The advisory is the whole reason a soft-stale row is actionable: it names
   * what moved under the criterion, so a reviewer can decide between one cheap
   * reaffirmation and a re-proof.
   */
  it("explains soft-staleness with the basis element the delta named", () => {
    render(<DeliveryPlanDispositionsTable criteria={reviewView().criteria} />);

    expect(
      within(row("c-soft")).getByText(/parent requirement R2 changed/),
    ).toBeVisible();
  });

  it("says plainly when a criterion has no earlier delivery to grade against", () => {
    const criteria = reviewView().criteria.map((criterion) =>
      criterion.criterionElementId === "c-hard"
        ? {
            ...criterion,
            deliveryClass: "never_delivered" as const,
            freshness: null,
          }
        : criterion,
    );

    render(<DeliveryPlanDispositionsTable criteria={criteria} />);

    expect(within(row("c-hard")).getByText("never delivered")).toBeVisible();
    expect(
      within(row("c-hard")).getByText("No earlier delivery to compare."),
    ).toBeVisible();
  });

  it("names the criterion a context owns and flags one no context owns", () => {
    render(<DeliveryPlanDispositionsTable criteria={reviewView().criteria} />);

    expect(within(row("c-hard")).getByText("dpa-document")).toBeVisible();
    expect(within(row("c-done")).getByText("unowned")).toBeVisible();
  });

  /**
   * The reaffirm control (context `dpa-studio`, later task) binds per criterion,
   * so the row exposes a slot rather than the control itself — one table, one
   * row identity, no second enumeration of the same criteria.
   */
  it("renders a per-criterion action the caller binds into the row", () => {
    render(
      <DeliveryPlanDispositionsTable
        criteria={reviewView().criteria}
        renderRowAction={(criterion) =>
          criterion.disposition === "pending_reaffirmation" ? (
            <button type="button">Reaffirm {criterion.handle}</button>
          ) : null
        }
      />,
    );

    expect(
      within(row("c-soft")).getByRole("button", { name: "Reaffirm R2.1" }),
    ).toBeVisible();
    expect(within(row("c-hard")).queryByRole("button")).toBeNull();
  });

  it("says the plan disposes nothing when the pinned revision has no criteria", () => {
    render(<DeliveryPlanDispositionsTable criteria={[]} />);

    expect(
      screen.getByText("The pinned revision carries no criteria."),
    ).toBeVisible();
  });
});

describe("DeliveryPlanCandidatePanel", () => {
  it("shows the compiled definition hash a sign-off would bind", () => {
    render(<DeliveryPlanCandidatePanel review={reviewView()} />);

    const panel = screen.getByRole("region", {
      name: "Materialized candidate",
    });
    expect(within(panel).getByText("sha256:compiled-2")).toBeVisible();
    expect(within(panel).getByText("sha256:plan-2")).toBeVisible();
  });

  it("says a draft has frozen nothing rather than showing a hash", () => {
    render(
      <DeliveryPlanCandidatePanel
        review={reviewView({
          attempt: {
            status: "draft",
            proposedSnapshotId: null,
            planHash: null,
            compiledDefinitionHash: null,
            candidateId: null,
          },
        })}
      />,
    );

    const panel = screen.getByRole("region", {
      name: "Materialized candidate",
    });
    expect(
      within(panel).getByText(
        /This draft has frozen nothing, so there is no candidate to approve/,
      ),
    ).toBeVisible();
  });

  it("reports who approved the candidate once one has", () => {
    render(
      <DeliveryPlanCandidatePanel
        review={reviewView({
          attempt: { status: "approved" },
          approval: {
            candidateId: "candidate-2",
            planHash: "sha256:plan-2",
            compiledDefinitionHash: "sha256:compiled-2",
            snapshotId: "snapshot-2",
            approvedAt: "2026-08-08T10:00:00.000Z",
            approvedBy: { kind: "human" },
          },
        })}
      />,
    );

    const panel = screen.getByRole("region", {
      name: "Materialized candidate",
    });
    expect(
      within(panel).getByText(/Approved by a human operator at/),
    ).toBeVisible();
  });
});
