// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import ContextHaltCard from "./ContextHaltCard";
import type {
  OutputSchemaHaltEvidence,
  OutputSchemaHaltEvidenceByContext,
} from "./derive-output-schema-halt";

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
      screen.getByText("Output schema rejected by the engine"),
    ).toBeInTheDocument();
    expect(screen.getByText("resumable halt")).toBeInTheDocument();
    expect(
      screen.getByText("$.risks: expected array, received string"),
    ).toBeInTheDocument();
    // The fix is the contract, not the work: the copy must say so, otherwise
    // the operator reruns tasks that already did what was asked.
    expect(
      screen.getByText(
        /Repair the contract, then resume — resume starts the retry budget fresh./,
      ),
    ).toBeInTheDocument();
  });

  // Production issues come from `toOutputSchemaIssues`, which sets `title`
  // EQUAL to `path` and puts the engine's words in `description`. A card that
  // only names a keyword when title differs from path therefore names one for
  // hand-built evidence and never for a real refusal — so both fixtures below
  // are shaped exactly as that producer emits.
  const productionIssue = {
    path: "$.risks",
    title: "$.risks",
    description: "must be array",
  };

  it("names the offending keyword and the context that declared it", () => {
    render(
      <ContextHaltCard
        primary={outputSchemaHalt}
        outputSchemaEvidence={{
          "context-plan": {
            contextId: "context-plan",
            issues: [productionIssue],
            rejectedOutput: null,
            // A contract the subset validator cannot enforce: `format` is the
            // offending keyword and `auditTable` the property carrying it.
            declaredSchema: {
              type: "object",
              additionalProperties: false,
              required: ["auditTable"],
              properties: {
                auditTable: { type: "string", format: "email" },
              },
            },
            schemaEditedSinceRejection: false,
            contractUnchangedSinceRejection: true,
            failureCount: 3,
            breakerThreshold: 3,
            iteration: 3,
            maxIterations: 4,
            gateRepairAttempts: null,
            gateRepairBudget: null,
          },
        }}
      />,
    );

    expect(
      screen.getByText(/context-plan declares format on auditTable/),
    ).toBeInTheDocument();
  });

  it("names the refused path and the engine's own words when the contract is enforceable", () => {
    render(
      <ContextHaltCard
        primary={outputSchemaHalt}
        outputSchemaEvidence={{
          "context-plan": {
            contextId: "context-plan",
            issues: [productionIssue],
            rejectedOutput: null,
            declaredSchema: {
              type: "object",
              additionalProperties: false,
              required: ["risks"],
              properties: {
                risks: { type: "array", items: { type: "string" } },
              },
            },
            schemaEditedSinceRejection: false,
            contractUnchangedSinceRejection: true,
            failureCount: 3,
            breakerThreshold: 3,
            iteration: 3,
            maxIterations: 4,
            gateRepairAttempts: null,
            gateRepairBudget: null,
          },
        }}
      />,
    );

    // Never the bare locator: `$.risks` alone tells the operator nothing about
    // what the contract wanted there.
    expect(
      screen.getByText(/context-plan was refused at \$\.risks — must be array/),
    ).toBeInTheDocument();
  });

  function schemaEvidence(
    overrides: Partial<OutputSchemaHaltEvidence> = {},
  ): OutputSchemaHaltEvidenceByContext {
    return {
      "context-plan": {
        contextId: "context-plan",
        issues: [productionIssue],
        rejectedOutput: null,
        declaredSchema: {
          type: "object",
          additionalProperties: false,
          required: ["risks"],
          properties: { risks: { type: "array", items: { type: "string" } } },
        },
        schemaEditedSinceRejection: false,
        contractUnchangedSinceRejection: true,
        failureCount: 3,
        breakerThreshold: 3,
        iteration: 3,
        maxIterations: 4,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        ...overrides,
      },
    };
  }

  it("blocks Resume while the contract that refused is still in force", () => {
    render(
      <ContextHaltCard
        primary={outputSchemaHalt}
        outputSchemaEvidence={schemaEvidence()}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Resume — blocked until the contract is accepted",
      }),
    ).toBeDisabled();
  });

  // The card explains the halt; the execution controls own the act. Leaving a
  // disabled Resume here after the edit would contradict the enabled one the
  // status bar releases at the same moment.
  it("offers no Resume of its own once the contract has been edited", () => {
    render(
      <ContextHaltCard
        primary={outputSchemaHalt}
        outputSchemaEvidence={schemaEvidence({
          schemaEditedSinceRejection: true,
          contractUnchangedSinceRejection: false,
        })}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /^Resume/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Resume is available in the execution controls."),
    ).toBeInTheDocument();
  });

  it("offers Edit schema as the way out for the refusing context", async () => {
    const user = userEvent.setup();
    const onEditSchema = vi.fn();
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
            contractUnchangedSinceRejection: true,
            failureCount: 3,
            breakerThreshold: null,
            iteration: null,
            maxIterations: null,
            gateRepairAttempts: null,
            gateRepairBudget: null,
          },
        }}
        onEditSchema={onEditSchema}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit schema" }));
    expect(onEditSchema).toHaveBeenCalledWith("context-plan");
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
            contractUnchangedSinceRejection: true,
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
    // list rather than per-item, so assert it where it lives. The headline
    // sentence names the first refusal too, so the prose assertions are scoped
    // to the list rather than to the whole card.
    const list = locator.closest("ul");
    expect(list?.className).toContain("[&_code]:text-amber");
    expect(
      within(list as HTMLElement).getByText(/not one of the allowed values/),
    ).toBeInTheDocument();
    expect(
      within(list as HTMLElement).getByText("/confidence"),
    ).toBeInTheDocument();
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
            contractUnchangedSinceRejection: true,
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
            contractUnchangedSinceRejection: true,
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

    // Both refusals offer their own repair: the primary names context-plan, the
    // secondary context-build, and a single shared action would send the reader
    // to the wrong contract.
    const editActions = screen.getAllByRole("button", { name: "Edit schema" });
    expect(editActions).toHaveLength(2);
    await user.click(editActions[1]!);
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
      screen.getByText(/Criterion 3 requires a schema this context never owns/),
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

  // The field has been persisted since the halt existed but never reached the
  // card, so a repair round that spoke on this halt looked to the operator
  // exactly like one that never ran.
  it("replaces the generic remedy with the plan-repair verdict once it has spoken", () => {
    render(
      <ContextHaltCard
        primary={{
          ...candidateUnstableHalt,
          summary: "Plan repair declined: a dev server writes into the lane.",
        }}
      />,
    );

    expect(
      screen.getByText(
        "Plan repair declined: a dev server writes into the lane.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Find what keeps changing the worktree/),
    ).not.toBeInTheDocument();
  });
});

describe("ContextHaltCard lane-drift presentation", () => {
  const ownershipViolationHalt: GraphWorkflowHaltReason = {
    type: "ownership_violation",
    laneId: "delivery",
    contextId: "context-implement",
    unattributedPaths: ["src/generated/client.ts"],
    message: "the lane changed a path no member owns",
    summary: null,
  };

  it("leads with the unattributed paths and the generic widen-or-remove remedy", () => {
    render(<ContextHaltCard primary={ownershipViolationHalt} />);

    expect(
      screen.getByText(/Lane "delivery" changed 1 path\(s\) no member owns/),
    ).toBeInTheDocument();
    expect(screen.getByText("src/generated/client.ts")).toBeInTheDocument();
    expect(
      screen.getByText(/Widen a member's ownership to cover these paths/),
    ).toBeInTheDocument();
  });

  // Repair declines this halt often — the write frequently belongs to no plan
  // at all — and the decline is the whole product of a round the operator paid
  // for. Without it on the card, the round is invisible and the advice is the
  // same advice they already had.
  it("replaces the generic remedy with the plan-repair verdict once it has spoken", () => {
    render(
      <ContextHaltCard
        primary={{
          ...ownershipViolationHalt,
          summary: "Plan repair declined: no member may own a generated file.",
        }}
      />,
    );

    expect(
      screen.getByText(
        "Plan repair declined: no member may own a generated file.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Widen a member's ownership to cover these paths/),
    ).not.toBeInTheDocument();
  });
});

describe("ContextHaltCard plan-repair activity", () => {
  const breakerHalt: GraphWorkflowHaltReason = {
    type: "circuit_breaker",
    contextId: "context-plan",
    condition: "retry_exhaustion",
    failureCount: 3,
    summary: null,
  };

  const round = {
    seq: 2,
    contextId: "context-plan",
    haltType: "circuit_breaker" as const,
    loopGroupId: null,
    startedAt: "2026-08-25T12:04:00.000Z",
    settledAt: null,
    outcome: null,
    planningDefect: null,
    diagnosis: null,
    operationCount: 0,
    resumed: false,
    conversationId: null,
  };

  it("says the halt is under repair while a round is open", () => {
    render(
      <ContextHaltCard
        primary={breakerHalt}
        planRepairActivity={{
          kind: "working",
          openRound: round,
          rounds: [round],
        }}
      />,
    );

    expect(screen.getByTestId("halt-repair-line")).toHaveTextContent(
      /repair agent is working on/i,
    );
  });

  it("says nobody is working once the rounds have settled", () => {
    render(
      <ContextHaltCard
        primary={breakerHalt}
        planRepairActivity={{
          kind: "stopped",
          openRound: null,
          rounds: [
            {
              ...round,
              settledAt: "2026-08-25T12:08:00.000Z",
              outcome: "declined",
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId("halt-repair-line")).toHaveTextContent(
      /No agent is working on this halt/i,
    );
  });

  it("claims nothing about repair on a halt no round has answered", () => {
    render(
      <ContextHaltCard
        primary={breakerHalt}
        planRepairActivity={{ kind: "stopped", openRound: null, rounds: [] }}
      />,
    );

    expect(screen.queryByTestId("halt-repair-line")).toBeNull();
  });
});
