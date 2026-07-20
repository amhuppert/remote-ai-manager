// @vitest-environment jsdom
import type { ComponentType, ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@xyflow/react", () => ({
  Background: () => null,
  Controls: () => null,
  Handle: () => null,
  MarkerType: { ArrowClosed: "arrowclosed" },
  Position: { Left: "left", Right: "right" },
  ReactFlow: ({
    nodes,
    nodeTypes,
  }: {
    nodes: Array<{ id: string; type?: string; data: unknown }>;
    nodeTypes: Record<string, ComponentType<{ data: unknown }>>;
  }) => (
    <div data-testid="traceability-canvas">
      {nodes.map((node) => {
        const NodeComponent = nodeTypes[node.type ?? "default"];
        if (NodeComponent === undefined) return null;
        return <NodeComponent key={node.id} data={node.data} />;
      })}
    </div>
  ),
}));

import {
  buildTraceabilityGraph,
  SpecEvidencePanel,
  SpecLintPanel,
  TraceabilityGraph,
  type CriterionProofView,
  type TraceabilityInput,
} from "./SpecEvidenceLintTrace";

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
          evaluated_state_json: JSON.stringify({
            commitHash: "abc123",
            relevantTreeHash: "tree123",
            surfaceHash: null,
            mergeCandidateRef: null,
          }),
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
      validationStrategy: { kinds: ["screenshot"] },
      evidence: [],
      verdicts: [],
      waiver: null,
      isPending: false,
      error: null,
    },
  ];
}

describe("SpecEvidencePanel", () => {
  it("renders proof state per criterion and an explicit nothing-proves-it state", () => {
    render(<SpecEvidencePanel criteria={proofViews()} />);

    const proven = screen.getByRole("article", { name: "R1.1 proof" });
    expect(within(proven).getByText("Proven")).toBeTruthy();
    expect(within(proven).getAllByText("Test run")).toHaveLength(2);
    expect(within(proven).getByText("Run the alias test.")).toBeTruthy();
    expect(within(proven).getByText("Deterministic validator")).toBeTruthy();

    const pending = screen.getByRole("article", { name: "R1.2 proof" });
    expect(
      within(pending).getByText("Nothing proves this criterion yet."),
    ).toBeTruthy();
    expect(within(pending).getByText("Screenshot")).toBeTruthy();
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
      },
    ],
    executions: [
      {
        id: "execution-1",
        spec_id: "spec-1",
        revision_id: "revision-1",
        scope_json: JSON.stringify({
          selectedTaskIds: ["task-1"],
          selectedCriterionIds: ["criterion-1"],
          exclusionDispositions: [],
        }),
        state: "running",
        workflow_definition_id: "workflow-definition-1",
        workflow_execution_id: "workflow-execution-1",
        session_name: "native-sdd-run",
        delivered_at: null,
        abandoned_reason: null,
        created_at: NOW,
        updated_at: NOW,
      },
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

  it("renders the durable requirement-to-decision-to-task traceability chain", () => {
    const graph = buildTraceabilityGraph(input);
    const edges = graph.edges.map(({ source, target }) => [source, target]);

    expect(edges).toEqual(
      expect.arrayContaining([
        ["requirement:requirement-1", "decision:decision-1"],
        ["decision:decision-1", "task:task-1"],
        ["task:task-1", "execution:execution-1"],
        ["execution:execution-1", "evidence:evidence-1"],
      ]),
    );
  });

  it("renders active executions before they have evidence", () => {
    const graph = buildTraceabilityGraph({
      ...input,
      criteria: input.criteria.map((criterion) => ({
        ...criterion,
        evidence: [],
        verdicts: [],
      })),
    });

    expect(graph.nodes.map((node) => node.id)).toContain(
      "execution:execution-1",
    );
    expect(
      graph.edges.map(({ source, target }) => [source, target]),
    ).toContainEqual(["task:task-1", "execution:execution-1"]);
  });

  it("surfaces lint whose element is absent from the selected revision", () => {
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
      screen.getByRole("link", { name: /T1 depends on removed task T99/ }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=T99");
  });

  it("surfaces lint on graph nodes and links nodes back to Studio elements", () => {
    render(<TraceabilityGraph input={input} />);

    expect(screen.getByText("R1 needs coverage.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /^R1 ·/ })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=R1",
    );
    expect(
      screen.getByRole("link", { name: /Evidence evidence-1/ }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=R1.1");
  });
});
