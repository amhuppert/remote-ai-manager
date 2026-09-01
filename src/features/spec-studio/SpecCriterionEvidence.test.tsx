// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import SpecCriterionEvidence, {
  criterionEvidenceStatus,
} from "./SpecCriterionEvidence";

const base = {
  revisionApproved: true,
  disposition: null,
  evidenceCount: 0,
  currentVerdictCount: 0,
  waiverCurrent: false,
} as const;

describe("SpecCriterionEvidence", () => {
  it.each([
    ["Not approved", { ...base, revisionApproved: false }],
    ["Needs proof", base],
    ["Partially proven", { ...base, evidenceCount: 1 }],
    ["Proven", { ...base, currentVerdictCount: 1 }],
    ["Waived", { ...base, waiverCurrent: true }],
    ["Deferred", { ...base, disposition: "deferred" as const }],
    [
      "Delivered elsewhere",
      { ...base, disposition: "delivered_elsewhere" as const },
    ],
  ])("projects %s from one revision's records", (label, input) => {
    expect(criterionEvidenceStatus(input).label).toBe(label);
  });

  it("shows the validation strategy and evidence records with the status", async () => {
    render(
      <SpecCriterionEvidence
        revisionApproved
        disposition={null}
        evidence={["evidence-1"]}
        currentVerdictCount={0}
        waiverCurrent={false}
        validationKinds={["test"]}
        validationNote="Run the focused behavior test."
      />,
    );

    expect(screen.getByText("Partially proven")).toBeVisible();
    await userEvent.click(screen.getByText("Evidence"));
    expect(screen.getByText("evidence-1")).toBeVisible();
    expect(screen.getByText("Run the focused behavior test.")).toBeVisible();
  });
});
