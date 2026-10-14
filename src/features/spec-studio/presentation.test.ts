import { describe, expect, it } from "vitest";

import {
  importedSpecDetailFixture,
  importedThenAmendedSpecDetailFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import { revisionAdmittedByImport } from "./presentation";

describe("revisionAdmittedByImport", () => {
  it("answers for the revision the import created", () => {
    const detail = importedSpecDetailFixture();

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
        importedSpecDetailFixture().gateAdmissions,
        null,
      ),
    ).toBe(false);
  });
});
