import { describe, expect, it } from "vitest";

import {
  importedDeliveredSpecDetailFixture,
  importedThenAmendedSpecDetailFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import {
  deliveryLabel,
  deliveryTone,
  revisionAdmittedByImport,
} from "./presentation";

describe("revisionAdmittedByImport", () => {
  it("answers for the revision the import created", () => {
    const detail = importedDeliveredSpecDetailFixture();

    expect(
      revisionAdmittedByImport(
        detail.gateAdmissions,
        detail.currentApprovedRevision?.revision.id,
      ),
    ).toBe(true);
  });

  it("does not spread the import over later human-approved revisions", () => {
    // `status.imported` stays true for an imported spec's whole lineage, so an
    // amendment authored and signed off here would otherwise be credited to
    // the import that only produced the revision it is based on.
    const detail = importedThenAmendedSpecDetailFixture();

    expect(detail.status.imported).toBe(true);
    expect(
      revisionAdmittedByImport(
        detail.gateAdmissions,
        detail.currentApprovedRevision?.revision.id,
      ),
    ).toBe(false);
    expect(
      revisionAdmittedByImport(
        detail.gateAdmissions,
        detail.baseRevision?.revision.id,
      ),
    ).toBe(true);
  });

  it("reports no import for a natively authored spec or an absent revision", () => {
    const detail = specControlsDetailFixture();

    expect(
      revisionAdmittedByImport(
        detail.gateAdmissions,
        detail.currentApprovedRevision?.revision.id,
      ),
    ).toBe(false);
    expect(
      revisionAdmittedByImport(
        importedDeliveredSpecDetailFixture().gateAdmissions,
        null,
      ),
    ).toBe(false);
  });
});

describe("delivery chip presentation", () => {
  /**
   * An imported spec's criteria are delivered without ever being proven here.
   * The chip reads the delivered tally, so a spec the same view calls Delivered
   * cannot also read "0/2 delivered" (R9.2).
   */
  it("counts externally-delivered criteria in the delivered tally", () => {
    const importDelivered = {
      allWaived: false,
      deliveredCount: 2,
      provenCount: 0,
      deliveredExternallyCriterionIds: [],
      totalInScope: 2,
    };

    expect(deliveryLabel(importDelivered)).toBe("2/2 delivered");
    expect(deliveryTone(importDelivered)).toBe("green");
  });

  it("reports partial delivery when only some criteria have landed", () => {
    const partial = {
      allWaived: false,
      deliveredCount: 1,
      provenCount: 1,
      deliveredExternallyCriterionIds: [],
      totalInScope: 3,
    };

    expect(deliveryLabel(partial)).toBe("1/3 delivered");
    expect(deliveryTone(partial)).toBe("cyan");
  });

  it("keeps the waived and empty-scope readings ahead of the tally", () => {
    expect(
      deliveryLabel({
        allWaived: true,
        deliveredCount: 0,
        provenCount: 0,
        deliveredExternallyCriterionIds: [],
        totalInScope: 2,
      }),
    ).toBe("All delivery waived");
    expect(
      deliveryLabel({
        allWaived: false,
        deliveredCount: 0,
        provenCount: 0,
        deliveredExternallyCriterionIds: [],
        totalInScope: 0,
      }),
    ).toBe("No delivery scope");
  });
});
