// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import OverviewSurface from "./OverviewSurface";
import { InspectorNavigationProvider } from "./InspectorNavigationContext";
import { GATE_CONTEXT } from "./navigation";

function render(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

function openRow(id: string) {
  fireEvent.click(screen.getByTestId(`overview-row-${id}`));
}

describe("OverviewSurface — the §11 Overview destinations", () => {
  it("states the launch snapshot, its origin and its bound inputs", () => {
    render(
      <OverviewSurface
        execution={createWorkflowExecution({
          seedDefinitionId: "wf_checkout_v2",
          seedDefinitionRevision: 4,
          boundInputs: { target_branch: "main" },
        })}
        events={[]}
        draftRevision={5}
      />,
    );

    const launch = screen.getByTestId("overview-launch");
    expect(launch).toHaveTextContent("definition r4");
    expect(launch).toHaveTextContent("immutable snapshot");
    expect(launch).toHaveTextContent("wf_checkout_v2@4");
    expect(launch).toHaveTextContent("execution-1");
    expect(launch).toHaveTextContent("target_branch");
    expect(launch).toHaveTextContent("main");
    expect(screen.getByTestId("overview-draft-note")).toHaveTextContent(
      "The builder draft is r5. Saved edits do not reach this run.",
    );
  });

  it("states the graph's shape", () => {
    render(
      <OverviewSurface execution={createWorkflowExecution()} events={[]} />,
    );

    expect(screen.getByTestId("overview-shape")).toHaveTextContent(
      "3 contexts · 3 tasks · 2 edges · 0 joins · 3 lanes",
    );
  });

  it("offers a row for every drillable destination", () => {
    render(
      <OverviewSurface execution={createWorkflowExecution()} events={[]} />,
    );

    for (const id of [
      "gates",
      "advisories",
      "loop-ledger",
      "expansion-ledger",
      "approvals",
      "documents",
      "events",
    ]) {
      expect(screen.getByTestId(`overview-row-${id}`)).toBeInTheDocument();
    }
  });

  it("holds the durable result until the run reaches a terminal state", () => {
    render(
      <OverviewSurface execution={createWorkflowExecution()} events={[]} />,
    );

    expect(screen.getByTestId("overview-result")).toHaveTextContent(
      "Durable result appears when the run reaches a terminal state.",
    );
  });

  it("shows the recorded boundary result of a finished run", () => {
    render(
      <OverviewSurface
        execution={createWorkflowExecution({ status: "completed" })}
        events={[]}
        result={{
          cursor: 1,
          occurredAt: "2026-03-27T11:00:00.000Z",
          executionId: "execution-1",
          boundaryKind: "completion",
          status: "completed",
          contextId: null,
          pendingActions: [],
          outputs: {
            kind: "declared_outputs",
            byContext: { "context-verify": { verdict: "GO" } },
          },
          name: "checkout-v2",
          origin: {
            kind: "template",
            definitionId: "workflow-1",
            definitionRevision: 1,
            tier: "project",
          },
          originConversationId: null,
          startedAt: "2026-03-27T10:00:00.000Z",
          completedAt: "2026-03-27T11:00:00.000Z",
          haltReason: null,
          abandonment: null,
          documents: [],
          deepLink: "/x",
        }}
      />,
    );

    const result = screen.getByTestId("overview-result");
    expect(result).toHaveTextContent("completion");
    expect(result).toHaveTextContent("context-verify.verdict");
    expect(result).toHaveTextContent("GO");
  });
});

describe("OverviewSurface — Gates", () => {
  function executionAwaitingApproval(): GraphWorkflowExecution {
    const base = createWorkflowExecution({ status: "running" });
    const planState = base.contextStates["context-plan"]!;
    return {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...planState,
          status: "awaiting_approval",
          pendingApproval: {
            conversationId: "conv-approval",
            requestedAt: "2026-03-27T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" },
          },
        },
      },
    };
  }

  it("counts what is waiting on the human and marks the row amber", () => {
    render(
      <OverviewSurface execution={executionAwaitingApproval()} events={[]} />,
    );

    const row = screen.getByTestId("overview-row-gates");
    expect(row).toHaveTextContent("1 context approval · 0 parked questions");
  });

  it("lists the open gates with a count once the row is opened", () => {
    render(
      <OverviewSurface execution={executionAwaitingApproval()} events={[]} />,
    );

    openRow("gates");

    const list = screen.getByTestId("execution-gates-list");
    expect(within(list).getByTestId("gates-count")).toHaveTextContent("1");
    expect(screen.getByTestId("execution-gate-row")).toHaveTextContent(
      "context approval · iteration 0 candidate",
    );
  });

  it("opens the context a gate belongs to through the navigation handle", () => {
    const openContext = vi.fn();
    render(
      <InspectorNavigationProvider handle={{ openContext }}>
        <OverviewSurface execution={executionAwaitingApproval()} events={[]} />
      </InspectorNavigationProvider>,
    );

    openRow("gates");
    fireEvent.click(screen.getByTestId("execution-gate-row"));

    expect(openContext).toHaveBeenCalledWith("context-plan", GATE_CONTEXT);
  });

  it("opens the gates screen when a host asks for it", () => {
    const { rerender } = render(
      <OverviewSurface execution={executionAwaitingApproval()} events={[]} />,
    );

    expect(
      screen.queryByTestId("execution-gates-list"),
    ).not.toBeInTheDocument();

    rerender(
      <OverviewSurface
        execution={executionAwaitingApproval()}
        events={[]}
        screenRequest={{ screen: "gates", seq: 1 }}
      />,
    );

    expect(screen.getByTestId("execution-gates-list")).toBeInTheDocument();
  });

  it("leaves the reader where they navigate after honouring a request", () => {
    const execution = executionAwaitingApproval();
    const request = { screen: "gates", seq: 1 } as const;
    const { rerender } = render(
      <OverviewSurface
        execution={execution}
        events={[]}
        screenRequest={request}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    rerender(
      <OverviewSurface
        execution={execution}
        events={[]}
        screenRequest={request}
      />,
    );

    expect(
      screen.queryByTestId("execution-gates-list"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("overview-row-gates")).toBeInTheDocument();
  });
});

describe("OverviewSurface — push navigation", () => {
  it("returns to the row list from a drilled screen", () => {
    render(
      <OverviewSurface
        execution={createWorkflowExecution({
          sharedDocuments: [
            {
              id: "doc-1",
              relativePath: "docs/threat-model.md",
              description: "Threat model",
              readWhen: "Before touching the payment path",
              kind: "shared",
              createdAt: "2026-03-27T10:00:00.000Z",
              updatedAt: "2026-03-27T10:00:00.000Z",
              lastUpdatedByConversationId: null,
            },
          ],
        })}
        events={[]}
      />,
    );

    openRow("documents");
    const screenRegion = screen.getByRole("region", { name: "Documents" });
    expect(
      within(screenRegion).getByText("docs/threat-model.md"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));

    expect(screen.getByTestId("overview-row-documents")).toBeInTheDocument();
  });
});
