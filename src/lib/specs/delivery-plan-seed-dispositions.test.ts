import { describe, expect, it } from "vitest";

import { seedDispositionsFromDelivery } from "./delivery-plan-seed";

const COMPARED = "execution-last-delivery";

/**
 * The default delta-seeding rule. Each
 * class is stated once here so the help text and the derivation cannot drift.
 */
describe("seedDispositionsFromDelivery", () => {
  it("derives every pinned criterion's disposition from its delivery class", () => {
    const dispositions = seedDispositionsFromDelivery({
      pinnedCriterionElementIds: [
        "criterion-fresh",
        "criterion-soft-stale",
        "criterion-hard-stale",
        "criterion-never",
        "criterion-deferred",
        "criterion-waived",
        "criterion-new",
      ],
      basis: {
        comparedExecutionId: COMPARED,
        criteria: [
          {
            criterionElementId: "criterion-fresh",
            deliveryClass: "delivered_and_fresh",
            deliveredByExecutionId: COMPARED,
          },
          {
            criterionElementId: "criterion-soft-stale",
            deliveryClass: "soft_stale",
            deliveredByExecutionId: "execution-earlier",
          },
          {
            criterionElementId: "criterion-hard-stale",
            deliveryClass: "hard_stale",
            deliveredByExecutionId: COMPARED,
          },
          {
            criterionElementId: "criterion-never",
            deliveryClass: "never_delivered",
            deliveredByExecutionId: null,
          },
          {
            criterionElementId: "criterion-deferred",
            deliveryClass: "deferred",
            deliveredByExecutionId: null,
          },
          {
            criterionElementId: "criterion-waived",
            deliveryClass: "waived",
            deliveredByExecutionId: null,
          },
        ],
      },
    });

    expect(dispositions).toEqual([
      {
        criterionElementId: "criterion-fresh",
        disposition: "delivered_elsewhere",
        deliveredByExecutionId: COMPARED,
      },
      {
        criterionElementId: "criterion-soft-stale",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: "execution-earlier",
      },
      {
        criterionElementId: "criterion-hard-stale",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-never",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-deferred",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-waived",
        disposition: "waived",
        deliveredByExecutionId: null,
      },
      {
        criterionElementId: "criterion-new",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
    ]);
  });

  it("selects every criterion when nothing has delivered yet", () => {
    expect(
      seedDispositionsFromDelivery({
        pinnedCriterionElementIds: ["criterion-one"],
        basis: { comparedExecutionId: null, criteria: [] },
      }),
    ).toEqual([
      {
        criterionElementId: "criterion-one",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
    ]);
  });

  it("refuses to attribute a delivery it cannot name", () => {
    expect(() =>
      seedDispositionsFromDelivery({
        pinnedCriterionElementIds: ["criterion-fresh"],
        basis: {
          comparedExecutionId: COMPARED,
          criteria: [
            {
              criterionElementId: "criterion-fresh",
              deliveryClass: "delivered_and_fresh",
              deliveredByExecutionId: null,
            },
          ],
        },
      }),
    ).toThrow(/criterion-fresh/);
  });
});
