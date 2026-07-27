// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import ContextHaltCard from "./ContextHaltCard";

const joinFailureWithManyConflicts: GraphWorkflowHaltReason = {
  type: "join_failure",
  joinId: "join-final",
  joinKind: "final_publish",
  contextId: null,
  sourceLaneIds: ["lane-a", "lane-b"],
  targetLaneId: "__session__",
  message: "Pre-merge validation failed",
  conflictFiles: Array.from(
    { length: 60 },
    (_, i) => `src/lib/specs/file-${i}.ts`,
  ),
};

describe("ContextHaltCard detail bounding", () => {
  it("renders the detail inside a height-bounded scroll container so long conflict lists cannot grow the card", () => {
    render(<ContextHaltCard primary={joinFailureWithManyConflicts} />);

    const detailRegion = screen.getByTestId("halt-detail");
    // The height bound IS the behavior under test: an unbounded conflict list
    // previously grew the card (and its host) past the viewport.
    expect(detailRegion.className).toContain("max-h-");
    expect(detailRegion.className).toContain("overflow-y-auto");
    expect(detailRegion).toContainElement(
      screen.getByText("src/lib/specs/file-59.ts"),
    );
  });

  it("still shows headline and action outside the scroll region", () => {
    render(<ContextHaltCard primary={joinFailureWithManyConflicts} />);

    expect(
      screen.getByText(/Publish to session failed — 2 source lane\(s\)/),
    ).toBeInTheDocument();
    const action = screen.getByText(/Resolve conflicts in the target worktree/);
    expect(screen.getByTestId("halt-detail")).not.toContainElement(action);
  });
});

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

describe("ContextHaltCard delivery-gate presentation", () => {
  it("renders the approval refusal as an attention state with its own headline, not the unmet-criteria failure template", () => {
    render(<ContextHaltCard primary={approvalHalt} />);

    expect(
      screen.getByText("Delivery gate — waiting on your approval"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Audit Log requires a human delivery approval before this run can publish.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Approve delivery in Spec Studio, then resume this workflow.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/refused publish/)).not.toBeInTheDocument();
    // A sign-off wait must not read as a failure.
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "attention");
    expect(
      screen.getByRole("link", { name: /Open the merge gate/ }),
    ).toHaveAttribute("href", "/specs/command-center/audit-log?el=delivery");
  });

  it("keeps the failure template for unmet-criteria refusals and links to the same merge gate", () => {
    render(<ContextHaltCard primary={criteriaHalt} />);

    expect(
      screen.getByText(/Delivery gate refused publish — 1 unmet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "blocked");
    expect(
      screen.getByRole("link", { name: /Open the merge gate/ }),
    ).toHaveAttribute("href", "/specs/command-center/audit-log?el=delivery");
  });

  it("falls back to a generic approval line without a link when the halt predates the spec block", () => {
    const { spec: _spec, ...withoutSpec } = approvalHalt;
    render(<ContextHaltCard primary={withoutSpec} />);

    expect(
      screen.getByText(
        "This run requires a human delivery approval before it can publish.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
