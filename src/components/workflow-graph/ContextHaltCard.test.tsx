// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("ContextHaltCard circuit-breaker conditions", () => {
  const retryExhaustionHalt: GraphWorkflowHaltReason = {
    type: "circuit_breaker",
    contextId: "context-plan",
    condition: "retry_exhaustion",
    failureCount: 3,
    summary: "Validator kept reopening task-plan-2",
  };

  const outputSchemaHalt: GraphWorkflowHaltReason = {
    type: "circuit_breaker",
    contextId: "context-plan",
    condition: "output_schema_validation",
    failureCount: 3,
    summary: "$.risks: expected array, received string",
  };

  it("points an output-schema breaker trip at the context's output contract rather than its tasks", () => {
    render(<ContextHaltCard primary={outputSchemaHalt} />);

    expect(
      screen.getByText(
        /Output schema not satisfied in context-plan \(3 attempts\)/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("$.risks: expected array, received string"),
    ).toBeInTheDocument();
    // The fix is the schema, not the work: the action must say so, otherwise
    // the operator reruns tasks that already did what was asked.
    expect(
      screen.getByText(/Loosen or correct that schema on the context/),
    ).toBeInTheDocument();
  });

  it("keeps the generic breaker headline for retry exhaustion", () => {
    render(<ContextHaltCard primary={retryExhaustionHalt} />);

    expect(
      screen.getByText("Circuit breaker tripped in context-plan"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Output schema not satisfied/),
    ).not.toBeInTheDocument();
  });

  it("lists the refused instance paths with the amber-locator recipe (R3.2)", () => {
    render(
      <ContextHaltCard
        primary={outputSchemaHalt}
        outputSchemaEvidence={{
          "context-plan": {
            contextId: "context-plan",
            issues: [
              {
                path: "/verdict",
                title: "/verdict",
                description: "not one of the allowed values",
              },
              {
                path: "/confidence",
                title: "/confidence",
                description: "wrong type",
              },
            ],
            rejectedOutput: '{ "verdict": "partial" }',
            declaredSchema: { type: "object" },
            schemaEditedSinceRejection: false,
            failureCount: 3,
            breakerThreshold: 3,
            iteration: 3,
            maxIterations: 4,
            gateRepairAttempts: null,
            gateRepairBudget: 1,
          },
        }}
      />,
    );

    const locator = screen.getByText("/verdict");
    expect(locator.tagName).toBe("CODE");
    // Amber locator + prose is the shared halt-path recipe, applied by the
    // list rather than per-item, so assert it where it lives.
    expect(locator.closest("ul")?.className).toContain("[&_code]:text-amber");
    expect(
      screen.getByText(/not one of the allowed values/),
    ).toBeInTheDocument();
    expect(screen.getByText("/confidence")).toBeInTheDocument();
    // The compact card stays compact: the payload and the contract belong to
    // the details dialog, not to a card embedded in the inspector.
    expect(screen.queryByText(/Rejected output/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Declared schema/)).not.toBeInTheDocument();
  });

  it("falls back to the breaker summary when no rejection record survives", () => {
    render(
      <ContextHaltCard
        primary={outputSchemaHalt}
        outputSchemaEvidence={{
          "context-plan": {
            contextId: "context-plan",
            issues: [],
            rejectedOutput: null,
            declaredSchema: null,
            schemaEditedSinceRejection: false,
            failureCount: 3,
            breakerThreshold: null,
            iteration: null,
            maxIterations: null,
            gateRepairAttempts: null,
            gateRepairBudget: null,
          },
        }}
      />,
    );

    expect(
      screen.getByText("$.risks: expected array, received string"),
    ).toBeInTheDocument();
  });

  it("renders a secondary output-schema failure with its own instance paths and Edit schema action (R3.2)", async () => {
    const user = userEvent.setup();
    const onEditSchema = vi.fn();
    const secondary: GraphWorkflowHaltReason = {
      type: "circuit_breaker",
      contextId: "context-build",
      condition: "output_schema_validation",
      failureCount: 2,
      summary: "Output schema not satisfied",
    };
    render(
      <ContextHaltCard
        primary={outputSchemaHalt}
        secondary={[secondary]}
        outputSchemaEvidence={{
          "context-build": {
            contextId: "context-build",
            issues: [
              {
                path: "/artifact",
                title: "/artifact",
                description: "is required",
              },
            ],
            rejectedOutput: '{ "notes": "none" }',
            declaredSchema: { type: "object" },
            schemaEditedSinceRejection: false,
            failureCount: 2,
            breakerThreshold: 3,
            iteration: 2,
            maxIterations: 4,
            gateRepairAttempts: 1,
            gateRepairBudget: 1,
          },
        }}
        onEditSchema={onEditSchema}
      />,
    );

    await user.click(screen.getByRole("button", { name: /1 more failure/ }));

    const locator = screen.getByText("/artifact");
    expect(locator.tagName).toBe("CODE");
    expect(screen.getByText(/is required/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Edit schema" }));
    expect(onEditSchema).toHaveBeenCalledWith("context-build");
  });
});

describe("ContextHaltCard plan-defect presentation", () => {
  const planDefectHalt: GraphWorkflowHaltReason = {
    type: "plan_defect",
    contextId: "context-plan",
    roundSeq: 2,
    summary: null,
    planDefects: [
      {
        assignmentId: "seat-contract",
        title: "Criterion 3 requires a schema this context never owns",
        description: "The criterion names src/lib/foo/schemas.ts.",
        whyNotLocallyRemediable:
          "No task in context-plan may write that module.",
        conflictingContract: "acceptance criterion 3",
      },
      {
        assignmentId: "seat-scope",
        title: "The charter's non-goals exclude the migration task 2 assumes",
        description: "Task 2 assumes a migration the charter forbids.",
        whyNotLocallyRemediable: "The exclusion is a charter clause.",
        conflictingContract: "charter non-goal 1",
      },
    ],
  };

  it("leads with the finding and never leaks the halt-reason enum", () => {
    render(<ContextHaltCard primary={planDefectHalt} />);

    expect(
      screen.getByText(
        /Plan defect in "context-plan" — 2 blocking finding\(s\)/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Criterion 3 requires a schema this context never owns/,
      ),
    ).toBeInTheDocument();
    // The contract clause is the locator, and it takes the same amber `<code>`
    // recipe the path halts use.
    const locator = screen.getByText("acceptance criterion 3");
    expect(locator.tagName).toBe("CODE");
    expect(screen.getByText("charter non-goal 1").tagName).toBe("CODE");
    expect(screen.queryByText(/plan_defect/)).not.toBeInTheDocument();
  });

  it("names the plan as the thing to repair and says nothing was reopened", () => {
    render(<ContextHaltCard primary={planDefectHalt} />);

    // A plan defect charges no attempt and reopens no task, so an action that
    // reads like the retry halts would send the operator to re-run the work.
    expect(
      screen.getByText(
        /Repair the plan the finding names — the contract, not the work/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert").dataset["tone"]).toBe("attention");
  });

  it("replaces the generic remedy with the plan-repair supervisor's verdict once it has spoken", () => {
    render(
      <ContextHaltCard
        primary={{
          ...planDefectHalt,
          summary: "Plan repair declined: the defect is locally remediable.",
        }}
      />,
    );

    expect(
      screen.getByText(
        "Plan repair declined: the defect is locally remediable.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Repair the plan the finding names/),
    ).not.toBeInTheDocument();
  });
});

describe("ContextHaltCard candidate-unstable presentation", () => {
  const candidateUnstableHalt: GraphWorkflowHaltReason = {
    type: "candidate_unstable",
    contextId: "context-engine",
    stage: "diff_render",
    driftedComponents: "candidateTreeHash",
    lastIncident: "candidate_mismatch",
    consecutiveCount: 5,
    message:
      'Validation of execution context "context-engine" concluded without a verdict 5 times in a row because the reviewed candidate kept moving.',
    summary: null,
  };

  /**
   * The same count reached with nothing moving: every round's result belonged
   * to a round that was already over.
   */
  const staleTokenHalt: GraphWorkflowHaltReason = {
    type: "candidate_unstable",
    contextId: "context-engine",
    stage: "specialist_result",
    driftedComponents: "",
    lastIncident: "stale_result_rejected",
    consecutiveCount: 5,
    message:
      'Validation of execution context "context-engine" concluded without a verdict 5 times in a row, and no candidate movement was observed.',
    summary: null,
  };

  it("leads with the drift the rounds kept hitting and never leaks the halt-reason enum", () => {
    render(<ContextHaltCard primary={candidateUnstableHalt} />);

    expect(
      screen.getByText(
        /"context-engine" could not be reviewed — the candidate moved 5 rounds in a row/,
      ),
    ).toBeInTheDocument();
    // The stage and the moved component are what an operator diagnoses from;
    // the raw enum name tells them nothing they can act on.
    expect(screen.getByText(/diff_render/)).toBeInTheDocument();
    expect(screen.queryByText(/candidate_unstable/)).not.toBeInTheDocument();
  });

  it("points at the churn rather than at the reviewed work", () => {
    render(<ContextHaltCard primary={candidateUnstableHalt} />);

    // No verdict was rendered, so an action that read like the retry halts
    // would send the operator to re-run work nobody rejected.
    expect(
      screen.getByText(/Find what keeps changing the worktree/),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert").dataset["tone"]).toBe("attention");
  });

  // Same halt type, opposite diagnosis. Copy about a moving tree would send the
  // operator to look for churn that provably did not happen.
  it("claims no movement when the rounds were rejected for stale round tokens", () => {
    render(<ContextHaltCard primary={staleTokenHalt} />);

    expect(
      screen.getByText(
        /"context-engine" could not be reviewed — 5 rounds in a row reached no verdict/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/stale round token/)).toBeInTheDocument();
    expect(screen.queryByText(/the candidate moved/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Find what keeps changing the worktree/),
    ).not.toBeInTheDocument();
  });
});
