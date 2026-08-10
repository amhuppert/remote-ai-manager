// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { evidenceEvaluatedStateSchema } from "@/lib/specs/schemas";
import {
  buildTraceabilityGraph,
  SpecEvidencePanel,
  SpecLintPanel,
  TraceabilityGraph,
  type CriterionProofView,
  type TraceabilityInput,
} from "./SpecEvidenceLintTrace";
import { executionViewFixture } from "./SpecControls.fixtures";

const NOW = "2026-07-18T12:00:00.000Z";

function proofViews(): CriterionProofView[] {
  return [
    {
      elementId: "criterion-1",
      handle: "R1.1",
      text: "The alias remains resolvable.",
      validationStrategy: { kinds: ["test_run"], note: "Run the alias test." },
      evidence: [
        {
          id: "evidence-1",
          spec_id: "spec-1",
          criterion_element_id: "criterion-1",
          revision_id: "revision-1",
          kind: "test_run",
          ref_json: JSON.stringify({
            type: "workflow_event",
            workflowExecutionId: "workflow-1",
            eventId: 7,
            contextId: "validation",
          }),
          evaluated_state_json: JSON.stringify(
            evidenceEvaluatedStateSchema.parse({
              commitSha: "abc123",
              relevantPaths: ["src/lib/alias.ts"],
              relevantTreeHash: "tree123",
            }),
          ),
          producer_json: JSON.stringify({ kind: "agent" }),
          execution_id: "execution-1",
          source_event_id: 7,
          created_at: NOW,
        },
      ],
      verdicts: [
        {
          id: "verdict-1",
          spec_id: "spec-1",
          criterion_element_id: "criterion-1",
          revision_id: "revision-1",
          execution_id: "execution-1",
          verdict_kind: "deterministic_validator",
          evidence_ids_json: JSON.stringify(["evidence-1"]),
          verdict_at: NOW,
          stale_at: null,
          stale_reason: null,
        },
      ],
      waiver: null,
      isPending: false,
      error: null,
    },
    {
      elementId: "criterion-2",
      handle: "R1.2",
      text: "The stale chip is visible.",
      validationStrategy: { kinds: ["validator_verdict"] },
      evidence: [],
      verdicts: [],
      waiver: null,
      isPending: false,
      error: null,
    },
    {
      elementId: "criterion-3",
      handle: "R2.1",
      text: "Pending evidence remains visible while it loads.",
      validationStrategy: { kinds: ["test_run"] },
      evidence: [],
      verdicts: [],
      waiver: null,
      isPending: true,
      error: null,
    },
    {
      elementId: "criterion-4",
      handle: "R2.2",
      text: "Stale proof is distinguished from current proof.",
      validationStrategy: { kinds: ["validator_verdict"] },
      evidence: [],
      verdicts: [
        {
          id: "verdict-stale",
          spec_id: "spec-1",
          criterion_element_id: "criterion-4",
          revision_id: "revision-1",
          execution_id: "execution-1",
          verdict_kind: "human",
          evidence_ids_json: JSON.stringify([]),
          verdict_at: NOW,
          stale_at: NOW,
          stale_reason: "The approved revision changed.",
        },
      ],
      waiver: null,
      isPending: false,
      error: null,
    },
    {
      elementId: "criterion-5",
      handle: "R2.3",
      text: "A waiver is shown separately from proof.",
      validationStrategy: { kinds: ["validator_verdict"] },
      evidence: [],
      verdicts: [],
      waiver: {
        id: "waiver-1",
        spec_id: "spec-1",
        criterion_element_id: "criterion-5",
        revision_id: "revision-1",
        reason: "The hardware fixture is unavailable.",
        waived_at: NOW,
        stale: 0,
      },
      isPending: false,
      error: null,
    },
    {
      elementId: "criterion-6",
      handle: "R3.1",
      text: "Deferred scope remains auditable.",
      validationStrategy: { kinds: ["test_run"] },
      evidence: [],
      verdicts: [],
      waiver: null,
      isPending: false,
      error: null,
    },
    {
      elementId: "criterion-7",
      handle: "R3.2",
      text: "Delivery by another execution remains auditable.",
      validationStrategy: { kinds: ["validator_verdict"] },
      evidence: [],
      verdicts: [],
      waiver: null,
      isPending: false,
      error: null,
    },
  ];
}

const criterionDispositions = [
  {
    execution_id: "execution-1",
    criterion_element_id: "criterion-5",
    disposition: "waived" as const,
    waiver_id: "waiver-1",
    delivered_by_execution_id: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    execution_id: "execution-1",
    criterion_element_id: "criterion-6",
    disposition: "deferred" as const,
    waiver_id: null,
    delivered_by_execution_id: null,
    created_at: NOW,
    updated_at: NOW,
  },
  {
    execution_id: "execution-1",
    criterion_element_id: "criterion-7",
    disposition: "delivered_elsewhere" as const,
    waiver_id: null,
    delivered_by_execution_id: "execution-previous",
    created_at: NOW,
    updated_at: NOW,
  },
];

describe("SpecEvidencePanel", () => {
  it("renders criterion and validation prose as markdown", async () => {
    const criteria = proofViews();
    criteria[0]!.text = "The **alias** remains resolvable.";
    criteria[0]!.validationStrategy.note = "Run the `alias` test.";

    render(<SpecEvidencePanel criteria={criteria} initialFilter="all" />);

    const proof = screen.getByRole("article", { name: "R1.1 proof" });
    expect(
      await within(proof).findByText("alias", { selector: "strong" }),
    ).toBeVisible();
    expect(
      await within(proof).findByText("alias", { selector: "code" }),
    ).toBeVisible();
  });

  it("renders proof state per criterion and an explicit nothing-proves-it state", () => {
    render(<SpecEvidencePanel criteria={proofViews()} initialFilter="all" />);

    const proven = screen.getByRole("article", { name: "R1.1 proof" });
    expect(within(proven).getByText("Proven")).toBeTruthy();
    expect(within(proven).getByText("Test run")).toBeTruthy();
    expect(within(proven).getByText(/Test run · evidence-1/)).toBeTruthy();
    expect(within(proven).getByText("Run the alias test.")).toBeTruthy();
    expect(within(proven).getByText("Deterministic validator")).toBeTruthy();

    const pending = screen.getByRole("article", { name: "R1.2 proof" });
    expect(
      within(pending).getByText("Nothing proves this criterion yet."),
    ).toBeTruthy();
    expect(within(pending).getByText("Validator verdict")).toBeTruthy();
  });

  it("summarizes in-scope readiness and groups compact criterion states by requirement", () => {
    render(
      <SpecEvidencePanel
        criteria={proofViews()}
        dispositions={criterionDispositions}
        initialFilter="all"
      />,
    );

    const readiness = screen.getByRole("region", {
      name: "Evidence readiness",
    });
    expect(within(readiness).getByText("1 / 4 in-scope proven")).toBeVisible();
    expect(
      within(readiness).getByText("3 in-scope criteria still need proof."),
    ).toBeVisible();
    expect(within(readiness).getByRole("progressbar")).toHaveClass(
      "h-[4px]",
      "bg-bg-base",
    );

    const requirementOne = screen.getByRole("region", {
      name: "Requirement R1 evidence",
    });
    expect(within(requirementOne).getByText("R1.1")).toBeVisible();
    expect(within(requirementOne).getByText("R1.2")).toBeVisible();

    expect(
      within(screen.getByRole("article", { name: "R2.1 proof" })).getByText(
        "Pending",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("article", { name: "R2.2 proof" })).getByText(
        "Stale",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("article", { name: "R2.3 proof" })).getByText(
        "Waived — not proof",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("article", { name: "R3.1 proof" })).getByText(
        "Deferred",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("article", { name: "R3.2 proof" })).getByText(
        "Delivered elsewhere",
      ),
    ).toBeVisible();
  });

  it("does not claim the candidate-specific merge gate is open from revision proof alone", () => {
    render(<SpecEvidencePanel criteria={[proofViews()[0]!]} />);

    const readiness = screen.getByRole("region", {
      name: "Evidence readiness",
    });
    expect(within(readiness).getByText("Proof complete")).toBeVisible();
    expect(
      within(readiness).getByText(
        "All in-scope criteria have current proof; candidate freshness is checked at publish.",
      ),
    ).toBeVisible();
    expect(within(readiness).queryByText("Merge gate open")).toBeNull();
  });

  it("filters proven criteria while retaining every unresolved or dispositioned state", async () => {
    const user = userEvent.setup();
    render(
      <SpecEvidencePanel
        criteria={proofViews()}
        dispositions={criterionDispositions}
      />,
    );

    expect(screen.getByRole("radio", { name: "Unproven" })).toBeChecked();

    expect(
      screen.queryByRole("article", { name: "R1.1 proof" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "R1.2 proof" })).toBeVisible();
    expect(screen.getByRole("article", { name: "R2.3 proof" })).toBeVisible();
    expect(screen.getByRole("article", { name: "R3.2 proof" })).toBeVisible();

    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByRole("article", { name: "R1.1 proof" })).toBeVisible();
  });

  it("matches the prototype's compact criterion-row composition and filter copy", () => {
    render(
      <SpecEvidencePanel
        criteria={proofViews()}
        dispositions={criterionDispositions}
        initialFilter="all"
      />,
    );

    const filters = screen.getByRole("radiogroup", {
      name: "Evidence filter",
    });
    expect(
      within(filters)
        .getAllByRole("radio")
        .map((control) => control.textContent),
    ).toEqual(["All criteria", "Unproven only"]);

    const row = screen.getByRole("article", { name: "R1.1 proof" });
    expect(row).toHaveClass("px-md", "py-sm");
    expect(row).not.toHaveClass("gap-sm", "p-md", "rounded-lg");
    expect(within(row).getByText("Proven")).toBeVisible();
    expect(within(row).getByText(/Test run · evidence-1/)).toBeVisible();
  });
});

describe("SpecLintPanel", () => {
  it("renders exactly the refused propose finding list with element deep links", () => {
    const findings = [
      {
        ruleId: "9.3.uncovered-criterion",
        severity: "blocks_propose" as const,
        elementHandle: "R1.2",
        message: "R1.2 has no covering task.",
      },
      {
        ruleId: "9.4.task-without-requirement",
        severity: "blocks_propose" as const,
        elementHandle: "T1",
        message: "T1 traces to no requirement.",
      },
    ];

    render(
      <SpecLintPanel
        projectName="command-center"
        slug="native-sdd"
        revisionId="revision-1"
        findings={findings}
        isPending={false}
        error={null}
      />,
    );

    expect(
      screen
        .getAllByTestId("lint-finding-message")
        .map((message) => message.textContent),
    ).toEqual(findings.map((finding) => finding.message));
    expect(screen.getByRole("link", { name: /T1/ })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=T1",
    );
  });

  it("groups findings by severity and counts what would block propose", () => {
    render(
      <SpecLintPanel
        projectName="command-center"
        slug="native-sdd"
        revisionId="revision-1"
        findings={[
          {
            ruleId: "9.12.serialized-plan",
            severity: "advisory" as const,
            elementHandle: "T2",
            message: "The plan serialises every task.",
          },
          {
            ruleId: "9.3.uncovered-criterion",
            severity: "blocks_propose" as const,
            elementHandle: "R1.2",
            message: "R1.2 has no covering task.",
          },
          {
            ruleId: "9.9.open-question",
            severity: "blocks_signoff" as const,
            elementHandle: "Q1",
            message: "Q1 is unanswered.",
          },
        ]}
        isPending={false}
        error={null}
      />,
    );

    // Same severity ranking the CLI panel and the status tier use, so the
    // reader who moves between them meets the findings in one order.
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Blocks propose (1)", "Blocks sign-off (1)", "Advisory (1)"]);
    expect(
      screen
        .getAllByTestId("lint-finding-message")
        .map((message) => message.textContent),
    ).toEqual([
      "R1.2 has no covering task.",
      "Q1 is unanswered.",
      "The plan serialises every task.",
    ]);
    expect(screen.getByText("1 of 3 would block propose")).toBeInTheDocument();
  });
});

describe("TraceabilityGraph", () => {
  const input: TraceabilityInput = {
    projectName: "command-center",
    slug: "native-sdd",
    requirements: [
      {
        elementId: "requirement-1",
        handle: "R1",
        label: "References remain stable",
        criterionElementIds: ["criterion-1"],
        approval: "stale",
      },
    ],
    decisions: [
      {
        elementId: "decision-1",
        handle: "D1",
        label: "Alias-aware lookup",
        tracedRequirementElementIds: ["requirement-1"],
      },
    ],
    tasks: [
      {
        elementId: "task-1",
        handle: "T1",
        label: "Implement alias lookup",
        tracedRequirementElementIds: ["requirement-1"],
        tracedDecisionElementIds: ["decision-1"],
        coveredCriterionElementIds: ["criterion-1"],
        isNewInRevision: true,
        revisionNumber: 4,
      },
    ],
    executions: [
      executionViewFixture({
        workflowExecutionId: "workflow-execution-1",
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ],
    criteria: proofViews().slice(0, 1),
    findings: [
      {
        ruleId: "9.3.uncovered-criterion",
        severity: "blocks_propose",
        elementHandle: "R1",
        message: "R1 needs coverage.",
      },
    ],
  };

  it("projects traceability into the prototype's requirement-to-criteria-to-task columns", () => {
    const graph = buildTraceabilityGraph(input);
    const edges = graph.edges.map(({ source, target }) => [source, target]);

    expect(edges).toEqual(
      expect.arrayContaining([
        ["requirement:requirement-1", "criterion:criterion-1"],
        ["criterion:criterion-1", "task:task-1"],
      ]),
    );
    expect(graph.nodes.map((node) => node.data.kind)).not.toEqual(
      expect.arrayContaining(["decision", "execution", "evidence"]),
    );
    expect(graph.width).toBe(762);
  });

  it("keeps execution and evidence records out of the fixed plan graph", () => {
    const graph = buildTraceabilityGraph({
      ...input,
      criteria: input.criteria.map((criterion) => ({
        ...criterion,
        evidence: [],
        verdicts: [],
      })),
    });

    expect(graph.nodes.map((node) => node.id)).not.toContain(
      "execution:execution-1",
    );
    expect(graph.nodes.some((node) => node.id.startsWith("evidence:"))).toBe(
      false,
    );
  });

  it("uses actual node heights when spacing criteria and tasks", () => {
    const criteria = proofViews().slice(0, 2);
    const graph = buildTraceabilityGraph({
      ...input,
      requirements: [
        {
          ...input.requirements[0]!,
          criterionElementIds: criteria.map((criterion) => criterion.elementId),
        },
      ],
      criteria,
      tasks: [
        {
          ...input.tasks[0]!,
          coveredCriterionElementIds: criteria.map(
            (criterion) => criterion.elementId,
          ),
        },
        {
          ...input.tasks[0]!,
          elementId: "task-2",
          handle: "T2",
          label: "Implement a second trace path with a longer status line",
          coveredCriterionElementIds: [criteria[1]!.elementId],
        },
      ],
      findings: [
        {
          ruleId: "9.3.uncovered-criterion",
          severity: "blocks_propose",
          elementHandle: criteria[0]!.handle,
          message: "The first criterion has a visible layout status.",
        },
      ],
    });
    const firstCriterion = graph.nodes.find(
      (node) => node.id === `criterion:${criteria[0]!.elementId}`,
    );
    const secondCriterion = graph.nodes.find(
      (node) => node.id === `criterion:${criteria[1]!.elementId}`,
    );
    const tasks = graph.nodes
      .filter((node) => node.data.kind === "task")
      .sort((left, right) => left.position.y - right.position.y);

    expect(firstCriterion).toBeDefined();
    expect(secondCriterion).toBeDefined();
    expect(secondCriterion!.position.y).toBeGreaterThanOrEqual(
      firstCriterion!.position.y + firstCriterion!.height + 10,
    );
    expect(tasks[1]!.position.y).toBeGreaterThanOrEqual(
      tasks[0]!.position.y + tasks[0]!.height + 8,
    );
  });

  it("keeps lint for absent elements out of the three-column plan graph", () => {
    render(
      <TraceabilityGraph
        input={{
          ...input,
          findings: [
            ...input.findings,
            {
              ruleId: "9.6.dangling-handle",
              severity: "blocks_propose",
              elementHandle: "T99",
              message: "T1 depends on removed task T99.",
            },
          ],
        }}
      />,
    );

    expect(
      screen.queryByRole("link", { name: /T1 depends on removed task T99/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("T1 depends on removed task T99."),
    ).not.toBeInTheDocument();
  });

  it("surfaces lint on graph nodes and links nodes back to Studio elements", async () => {
    const user = userEvent.setup();
    render(<TraceabilityGraph input={input} />);

    expect(screen.getAllByText("R1 needs coverage.")).toHaveLength(1);
    expect(
      screen.getByText("Select a node to inspect its chain."),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Select requirement R1" }),
    );
    expect(screen.getAllByText("R1 needs coverage.")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /^R1 ·/ })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=R1",
    );
    expect(
      screen.queryByRole("article", { name: /Evidence/ }),
    ).not.toBeInTheDocument();
  });

  it("renders the selected requirement's full prose as markdown in the inspector", async () => {
    const user = userEvent.setup();
    render(
      <TraceabilityGraph
        input={{
          ...input,
          requirements: input.requirements.map((requirement) => ({
            ...requirement,
            label: "References **remain stable**",
          })),
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Select requirement R1" }),
    );
    const inspector = screen.getByRole("group", { name: "Trace inspector" });
    expect(
      await within(inspector).findByText("remain stable", {
        selector: "strong",
      }),
    ).toBeVisible();
  });

  it("selects a trace chain, exposes an inspector deep link, and provides non-graph navigation", async () => {
    const user = userEvent.setup();
    render(<TraceabilityGraph input={input} />);

    await user.click(screen.getByRole("button", { name: "Select task T1" }));

    const selectedTask = screen.getByRole("article", { name: "Task T1" });
    expect(selectedTask).toHaveAttribute("data-trace-state", "selected");
    expect(
      screen.getByRole("article", { name: "Requirement R1" }),
    ).toHaveAttribute("data-trace-state", "chain");

    const inspector = screen.getByRole("group", {
      name: "Trace inspector",
    });
    expect(within(inspector).getByText("Implement alias lookup")).toBeVisible();
    expect(
      within(inspector).getByRole("link", { name: "Open T1" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=T1");

    const index = screen.getByRole("navigation", {
      name: "Traceability elements",
    });
    await user.click(
      within(index).getByRole("button", {
        name: "Select R1 from trace index",
      }),
    );
    expect(
      within(inspector).getByText("References remain stable"),
    ).toBeVisible();
  });

  it("renders the prototype focus strip, column labels, and verdict legend without generic graph chrome", () => {
    render(<TraceabilityGraph input={input} />);

    const focus = screen.getByRole("group", { name: "Trace focus" });
    expect(within(focus).getByRole("button", { name: "All" })).toBeVisible();
    expect(within(focus).getByRole("button", { name: "R1" })).toBeVisible();

    expect(screen.getByText("Tasks — plan")).toBeVisible();
    expect(screen.queryByText("Execution")).not.toBeInTheDocument();
    expect(screen.queryByText("Evidence · verdict")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "glyphs: ✓ approved · ○ pending · ↻ stale — click a node to inspect it",
      ),
    ).toBeVisible();

    expect(
      screen.queryByTestId("react-flow-background"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("react-flow-controls")).not.toBeInTheDocument();
  });

  it("keeps headers, nodes, and edges in one non-transformable coordinate system", () => {
    render(<TraceabilityGraph input={input} />);

    const graph = screen.getByRole("region", { name: "Fixed trace graph" });
    expect(graph).toHaveAttribute("data-viewport-behavior", "static");
    expect(graph).toHaveClass("overflow-hidden");
    expect(graph).not.toHaveAttribute("data-mobile-layout", "horizontal-pan");

    const layout = screen.getByTestId("trace-static-layout");
    expect(layout).toHaveStyle({ width: "762px" });
    expect(within(layout).getByText("Requirement")).toHaveAttribute(
      "data-column-x",
      "16",
    );
    expect(within(layout).getByText("Criteria")).toHaveAttribute(
      "data-column-x",
      "252",
    );
    expect(within(layout).getByText("Tasks — plan")).toHaveAttribute(
      "data-column-x",
      "532",
    );
    expect(layout.querySelector(".react-flow__viewport")).toBeNull();
  });

  it("uses the prototype gradient node card, neutral handle, status accent, and approval glyph", () => {
    render(<TraceabilityGraph input={input} />);

    const requirement = screen.getByRole("article", {
      name: "Requirement R1",
    });
    expect(requirement).toHaveClass(
      "rounded-lg",
      "bg-[linear-gradient(175deg,var(--cc-trace-node-grad-top),var(--cc-trace-node-grad-bottom))]",
    );
    expect(within(requirement).getByText("R1")).toHaveClass(
      "text-text-secondary",
    );
    expect(within(requirement).getByText("↻")).toBeVisible();
    expect(requirement.querySelector("[data-node-accent]")).toBeVisible();
  });
});
