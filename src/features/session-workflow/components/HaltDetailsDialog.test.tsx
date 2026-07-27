// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import HaltDetailsDialog from "./HaltDetailsDialog";

const approvalHalt: GraphWorkflowHaltReason = {
  type: "delivery_gate_failed",
  unmet: [
    {
      criterionId: "spec-execution-1:gate:1",
      criterionHandle: "audit-log",
      outcome: "gate_blocked",
      reason: "The delivery gate requires human approval.",
    },
  ],
  instruction:
    "Approve delivery in Spec Studio: open the spec's Controls view → Merge gate → Approve delivery for merge, then resume the merge.",
  refusalCode: "approval_required",
  spec: {
    specSlug: "audit-log",
    specName: "Audit Log",
    projectName: "command-center",
  },
};

const criteriaHalt: GraphWorkflowHaltReason = {
  type: "delivery_gate_failed",
  unmet: [
    {
      criterionId: "criterion-1",
      criterionHandle: "R1.1",
      outcome: "proof_required",
      reason: "No current proof",
    },
  ],
  instruction: "Record fresh proof and re-dispatch the merge.",
  spec: {
    specSlug: "audit-log",
    specName: "Audit Log",
    projectName: "command-center",
  },
};

function renderDialog(primary: GraphWorkflowHaltReason) {
  return render(
    <HaltDetailsDialog
      open
      onOpenChange={() => undefined}
      primary={primary}
      conflictAnalysis={null}
      canResume
      onResume={() => undefined}
      isMutating={false}
      isResuming={false}
    />,
  );
}

describe("HaltDetailsDialog delivery-gate presentation", () => {
  it("renders the approval halt with the attention accent and the merge-gate link", () => {
    renderDialog(approvalHalt);

    expect(
      screen.getByText("Delivery gate — waiting on your approval"),
    ).toBeInTheDocument();
    // The status accent is the behavior: a sign-off wait must not present as
    // a red failure in the full read view either.
    expect(screen.getByText("Execution halted")).toHaveAttribute(
      "data-tone",
      "attention",
    );
    expect(
      screen.getByRole("link", { name: /Open the merge gate/ }),
    ).toHaveAttribute("href", "/specs/command-center/audit-log?el=delivery");
  });

  it("keeps the failure accent for unmet-criteria halts while offering the same link", () => {
    renderDialog(criteriaHalt);

    expect(
      screen.getByText(/Delivery gate refused publish — 1 unmet/),
    ).toBeInTheDocument();
    expect(screen.getByText("Execution halted")).toHaveAttribute(
      "data-tone",
      "blocked",
    );
    expect(
      screen.getByRole("link", { name: /Open the merge gate/ }),
    ).toHaveAttribute("href", "/specs/command-center/audit-log?el=delivery");
  });
});
