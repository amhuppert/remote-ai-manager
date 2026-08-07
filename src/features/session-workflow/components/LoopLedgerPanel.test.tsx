// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLoopDecisionRecord,
} from "@/lib/workflow-graph/schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import LoopLedgerPanel from "./LoopLedgerPanel";

const PROJECT_NAME = "project-1";
const SESSION_NAME = "session-1";
const EXECUTION_ID = "execution-1";

function decision(
  overrides: Partial<GraphWorkflowLoopDecisionRecord> = {},
): GraphWorkflowLoopDecisionRecord {
  return {
    loopGroupId: "refine",
    pass: 1,
    loopControlRevision: 0,
    templateVersion: 1,
    exitContextId: "refine__p1__judge",
    exitCaptureIteration: 1,
    verdict: "unsatisfied",
    outcome: "materialized",
    nextPass: 2,
    decidedAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

function decisionEvent(
  seq: number,
  record: GraphWorkflowLoopDecisionRecord,
): unknown {
  return {
    seq,
    occurredAt: record.decidedAt,
    preReset: false,
    event: {
      type: "graph-workflow-loop-decision",
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
      executionId: EXECUTION_ID,
      ...record,
    },
  };
}

/** Pass 2 concluded at revision 0, then was re-decided at revision 1. */
const PASS_TWO_ORIGINAL = decision({
  pass: 2,
  exitContextId: "refine__p2__judge",
  verdict: "satisfied",
  outcome: "concluded",
  nextPass: null,
});
const PASS_TWO_AMENDED = decision({
  pass: 2,
  exitContextId: "refine__p2__judge",
  loopControlRevision: 1,
  verdict: "unsatisfied",
  outcome: "materialized",
  nextPass: 3,
});

function executionWithLoop(): GraphWorkflowExecution {
  const execution = createWorkflowExecution({ id: EXECUTION_ID });
  return {
    ...execution,
    workingDefinition: {
      ...execution.workingDefinition,
      loopGroups: [
        {
          id: "refine",
          entryContextId: "worker",
          exitContextId: "judge",
          until: { schema: { type: "object" as const } },
          maxPasses: 4,
          templateVersion: 1,
          template: { contexts: [], tasks: [], edges: [] },
          planRepair: { enabled: true, maxAttemptsPerContext: 2 },
        },
      ],
    },
    loopStates: {
      refine: {
        loopGroupId: "refine",
        activation: "running" as const,
        loopControlRevision: 1,
        passCount: 3,
        slotLedger: [],
        boundaryInputs: null,
        decisions: {
          "1": decision(),
          "2": PASS_TWO_AMENDED,
        },
        passTemplateVersions: {},
        concludingExitContextId: null,
        activatedAt: "2026-08-04T00:00:00.000Z",
        settledAt: "2026-08-04T00:00:00.000Z",
      },
    },
  };
}

function renderPanel(execution: GraphWorkflowExecution) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LoopLedgerPanel
        projectName={PROJECT_NAME}
        sessionName={SESSION_NAME}
        execution={execution}
      />
    </QueryClientProvider>,
  );
}

describe("LoopLedgerPanel (D4 R16.2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the full decision history, paging the shared cursor reader", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        requested.push(url);
        // Newest-first pages, exactly as the reader serves them.
        const body = url.includes("cursor=2")
          ? { events: [decisionEvent(1, decision())], nextCursor: null }
          : {
              events: [
                decisionEvent(3, PASS_TWO_AMENDED),
                decisionEvent(2, PASS_TWO_ORIGINAL),
              ],
              nextCursor: 2,
            };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    renderPanel(executionWithLoop());

    await waitFor(() => {
      expect(screen.getAllByTestId("loop-ledger-decision")).toHaveLength(3);
    });
    expect(requested[0]).toContain("page=true");
    expect(requested[0]).toContain("direction=desc");

    // The loaded window is rendered in log order, and the superseded conclusion
    // is still readable beside the record that replaced it. Pass 1 is not in
    // this window, so it degrades to the blob's current record rather than
    // disappearing.
    const firstWindow = screen.getAllByTestId("loop-ledger-decision");
    expect(firstWindow[0]).toHaveTextContent("Pass 2 · satisfied → concluded");
    expect(firstWindow[0]).toHaveTextContent("superseded");
    expect(firstWindow[1]).toHaveTextContent(
      "Pass 2 · unsatisfied → materialized",
    );
    expect(firstWindow[1]).not.toHaveTextContent("superseded");
    expect(firstWindow[2]).toHaveTextContent("Pass 1");
    expect(firstWindow[2]).toHaveTextContent("from current state");

    await userEvent.click(
      screen.getByRole("button", { name: /older decisions/i }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /older decisions/i }),
      ).not.toBeInTheDocument();
    });
    expect(requested[1]).toContain("cursor=2");

    // With the older page loaded, every row is log-sourced and pass 1 takes its
    // real position at the head of the history.
    const fullWindow = screen.getAllByTestId("loop-ledger-decision");
    expect(fullWindow).toHaveLength(3);
    expect(fullWindow[0]).toHaveTextContent("Pass 1");
    expect(fullWindow[0]).not.toHaveTextContent("from current state");
    expect(fullWindow[2]).toHaveTextContent(
      "Pass 2 · unsatisfied → materialized",
    );
  });

  it("renders nothing for an execution that declares no loops", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("a loop-free execution must not fetch the ledger");
      }),
    );

    const { container } = renderPanel({
      ...executionWithLoop(),
      workingDefinition: {
        ...createWorkflowExecution({ id: EXECUTION_ID }).workingDefinition,
      },
      loopStates: {},
    });

    expect(container).toBeEmptyDOMElement();
  });
});
