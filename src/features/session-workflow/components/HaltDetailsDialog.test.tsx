// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

describe("HaltDetailsDialog output-schema halt (R3.2)", () => {
  const outputSchemaHalt: GraphWorkflowHaltReason = {
    type: "circuit_breaker",
    contextId: "context-plan",
    condition: "output_schema_validation",
    failureCount: 3,
    summary: "Output schema not satisfied",
  };

  const evidence = {
    contextId: "context-plan",
    issues: [
      {
        path: "/verdict",
        title: "/verdict",
        description: "not one of the allowed values",
      },
    ],
    rejectedOutput: '{ "verdict": "partial" }',
    declaredSchema: {
      type: "object",
      properties: { verdict: { type: "string" } },
    },
    schemaEditedSinceRejection: false,
    failureCount: 3,
    breakerThreshold: 3,
    iteration: 3,
    maxIterations: 4,
    gateRepairAttempts: 1,
    gateRepairBudget: 1,
  };

  function renderOutputSchemaDialog(onEditSchema?: () => void) {
    return render(
      <HaltDetailsDialog
        open
        onOpenChange={() => undefined}
        primary={outputSchemaHalt}
        conflictAnalysis={null}
        canResume
        onResume={() => undefined}
        isMutating={false}
        isResuming={false}
        outputSchemaEvidence={{ "context-plan": evidence }}
        {...(onEditSchema ? { onEditSchema } : {})}
      />,
    );
  }

  it("shows the refused payload beside the declared contract with the issue paths", () => {
    renderOutputSchemaDialog();

    expect(screen.getByText("/verdict")).toBeInTheDocument();
    expect(
      screen.getByText(/not one of the allowed values/),
    ).toBeInTheDocument();
    expect(screen.getByText("Rejected output")).toBeInTheDocument();
    expect(screen.getByText(/"verdict": "partial"/)).toBeInTheDocument();
    expect(screen.getByText("Declared schema")).toBeInTheDocument();
    expect(screen.getByText(/"properties"/)).toBeInTheDocument();
  });

  // The dialog's own Edit schema action can replace the contract while the
  // halt stands. The payload must stay paired with the schema that refused it,
  // and the label must not claim that schema is still the declared one.
  it("marks the contract as history once the schema has been edited since the rejection", () => {
    render(
      <HaltDetailsDialog
        open
        onOpenChange={() => undefined}
        primary={outputSchemaHalt}
        conflictAnalysis={null}
        canResume
        onResume={() => undefined}
        isMutating={false}
        isResuming={false}
        outputSchemaEvidence={{
          "context-plan": { ...evidence, schemaEditedSinceRejection: true },
        }}
      />,
    );

    expect(
      screen.getByText("Declared schema (at rejection — since edited)"),
    ).toBeInTheDocument();
    expect(screen.getByText(/"properties"/)).toBeInTheDocument();
  });

  it("shows the gate-repair, breaker and iteration budget chips", () => {
    renderOutputSchemaDialog();

    // The gate's own repair turn, not a D1 plan-repair round: the numbers come
    // off the rejection record that this halt reports.
    expect(screen.getByText("schema repair turn · 1 of 1")).toBeInTheDocument();
    expect(screen.getByText("circuit breaker · 3 of 3")).toBeInTheDocument();
    expect(screen.getByText("iteration 3 of 4")).toBeInTheDocument();
  });

  it("offers an Edit schema action that deep-links to the context's config", () => {
    const onEditSchema = vi.fn();
    renderOutputSchemaDialog(onEditSchema);

    screen.getByRole("button", { name: "Edit schema" }).click();
    expect(onEditSchema).toHaveBeenCalledTimes(1);
  });

  it("omits the Edit schema action when the host cannot navigate there", () => {
    renderOutputSchemaDialog();

    expect(
      screen.queryByRole("button", { name: "Edit schema" }),
    ).not.toBeInTheDocument();
  });

  it("renders a concurrent secondary output-schema failure with its own evidence and action", () => {
    const onEditSchema = vi.fn();
    const secondaryReason: GraphWorkflowHaltReason = {
      type: "circuit_breaker",
      contextId: "context-build",
      condition: "output_schema_validation",
      failureCount: 2,
      summary: "Output schema not satisfied",
    };
    render(
      <HaltDetailsDialog
        open
        onOpenChange={() => undefined}
        primary={outputSchemaHalt}
        secondary={[secondaryReason]}
        conflictAnalysis={null}
        canResume
        onResume={() => undefined}
        isMutating={false}
        isResuming={false}
        outputSchemaEvidence={{
          "context-plan": evidence,
          "context-build": {
            ...evidence,
            contextId: "context-build",
            issues: [
              {
                path: "/artifact",
                title: "/artifact",
                description: "is required",
              },
            ],
            rejectedOutput: '{ "notes": "none" }',
          },
        }}
        onEditSchema={onEditSchema}
      />,
    );

    const secondary = within(screen.getByTestId("halt-secondary-reason"));
    expect(secondary.getByText("/artifact")).toBeInTheDocument();
    expect(secondary.getByText(/is required/)).toBeInTheDocument();
    expect(secondary.getByText(/"notes": "none"/)).toBeInTheDocument();

    secondary.getByRole("button", { name: "Edit schema" }).click();
    expect(onEditSchema).toHaveBeenCalledWith("context-build");
  });
});
