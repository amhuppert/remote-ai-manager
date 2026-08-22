// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import ExecutionInspectorPanel from "./ExecutionInspectorPanel";

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
import { askQuestionItemSchema } from "@/lib/conversations/schemas";
import AskQuestionPanel from "@/components/AskQuestionPanel";
import { Fragment } from "react";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
// Radix-backed tabs activate on pointer-down (automatic activation), not on a
// bare synthetic click event.
function selectDetailTab(name: RegExp | string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

const baseHandlers = {
  onDeselectContext: vi.fn(),
  onAddTask: vi.fn(),
  onUpdateTask: vi.fn(),
  onRemoveTask: vi.fn(),
  onReorderTask: vi.fn(),
  onViewTask: vi.fn(),
  viewingTaskId: null,
  isMutating: false,
};

function makeValidationEvent(
  overrides: Partial<GraphWorkflowValidationResultEvent> = {},
): GraphWorkflowValidationResultEvent {
  return {
    type: "graph-workflow-validation-result",
    projectName: "project",
    sessionName: "session-1",
    executionId: "execution-1",
    contextId: "context-plan",
    validatorType: "context",
    kind: "context_validation",
    rejectedOutput: null,
    gateRepairAttempts: null,
    gateRepairBudget: null,
    pass: true,
    summary: "All good",
    issues: [],
    reopenTaskIds: [],
    ...overrides,
  };
}

// Overview destinations are drill rows (README §11, screen E3): the row states
// the count, the screen behind it holds the records.
function openOverviewRow(id: string) {
  fireEvent.click(screen.getByTestId(`overview-row-${id}`));
}

describe("ExecutionInspectorPanel — Launch Inputs audit surface", () => {
  it("renders the bound input snapshot for human inspection (R6.3)", () => {
    const execution = createWorkflowExecution({
      boundInputs: { feature: "search box", priority: "high" },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("overview-launch")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
    expect(screen.getByText("search box")).toBeInTheDocument();
    expect(screen.getByText("priority")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — parked user-input questions", () => {
  const QUESTION_TEXT = "Which database should we use?";
  const SECOND_QUESTION_TEXT = "Is the legacy token path in scope?";
  const parkedPanel = (questionText: string) => (
    <AskQuestionPanel
      questions={[
        askQuestionItemSchema.parse({
          id: "q1",
          question: questionText,
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        }),
      ]}
      questionId="qb-1"
      currentIndex={0}
      onNavigate={vi.fn()}
      onSubmit={vi.fn()}
      compact
    />
  );

  it("mounts one panel per waiting lane", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        userInputPanels={[
          <Fragment key="implementer">{parkedPanel(QUESTION_TEXT)}</Fragment>,
          <Fragment key="security">
            {parkedPanel(SECOND_QUESTION_TEXT)}
          </Fragment>,
        ]}
      />,
    );

    expect(screen.getByText(QUESTION_TEXT)).toBeInTheDocument();
    expect(screen.getByText(SECOND_QUESTION_TEXT)).toBeInTheDocument();
  });

  it("renders no question panel in the overview (no context selected) even if props carry a panel", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
        userInputPanels={parkedPanel(QUESTION_TEXT)}
      />,
    );

    expect(screen.queryByText(QUESTION_TEXT)).not.toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — Config tab + overview header", () => {
  it("shows a Config tab that renders the selected context's resolved config", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    // The config content is not mounted until the tab is selected.
    expect(screen.queryByTestId("context-config-tab")).not.toBeInTheDocument();

    selectDetailTab("Config");

    const tab = screen.getByTestId("context-config-tab");
    // context-plan's resolved implementer is claude opus, summarised on the
    // Agents card before the reader drills into it.
    expect(within(tab).getByText("Opus 5")).toBeInTheDocument();

    // Runtime facts live one screen in, under Placement (README §11).
    fireEvent.click(within(tab).getByRole("button", { name: /Placement/ }));
    expect(
      within(tab).getByTestId("config-row-runtime-isolation"),
    ).toHaveTextContent("session");
  });

  it("shows liveRevision and seed definition id@revision on the Launch card", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({
          liveRevision: 4,
          seedDefinitionId: "workflow-1",
          seedDefinitionRevision: 12,
        })}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("overview-live-revision")).toHaveTextContent(
      "liveRev 4",
    );
    expect(screen.getByTestId("overview-seed")).toHaveTextContent(
      "workflow-1@12",
    );
  });

  it("shows the charter amendment count and latest rationale in the overview", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({
          charterAmendments: [
            {
              seq: 1,
              amendedAt: "2026-07-29T10:00:00.000Z",
              source: "cli",
              rationale: "Invariant inv-2 was impossible",
              fieldsChanged: ["invariants"],
              charterHash: "hash-1",
            },
            {
              seq: 2,
              amendedAt: "2026-07-30T09:00:00.000Z",
              source: "ui",
              rationale: "Mission narrowed after descoping the importer",
              fieldsChanged: ["mission"],
              charterHash: "hash-2",
            },
          ],
        })}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    const note = screen.getByTestId("overview-charter-amendments");
    expect(note).toHaveTextContent("Charter amended ×2");
    expect(note).toHaveTextContent(
      "Mission narrowed after descoping the importer",
    );
  });
});

describe("ExecutionInspectorPanel — output-schema halt card (R3.2)", () => {
  function outputSchemaHaltFixture(): {
    execution: GraphWorkflowExecution;
    events: GraphWorkflowExecutionEvent[];
  } {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? { ...context, outputSchema: { type: "object", properties: {} } }
          : context,
    );
    return {
      execution: createWorkflowExecution({
        workingDefinition: definition,
        status: "halted",
        haltReason: {
          type: "circuit_breaker",
          contextId: "context-plan",
          condition: "output_schema_validation",
          failureCount: 3,
          summary: "Output schema not satisfied",
        },
      }),
      events: [
        {
          occurredAt: "2026-03-27T09:41:00.000Z",
          preReset: false,
          event: makeValidationEvent({
            kind: "output_schema",
            pass: false,
            summary: "Output rejected",
            issues: [
              {
                title: "/verdict",
                description: "not one of the allowed values",
                path: "/verdict",
              },
            ],
            rejectedOutput: '{ "verdict": "partial" }',
            gateRepairAttempts: null,
            gateRepairBudget: null,
          }),
        },
      ],
    };
  }

  it("offers Edit schema on the overview card, routing the host to the refusing context", () => {
    const { execution, events } = outputSchemaHaltFixture();
    const onEditSchema = vi.fn();

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        onEditSchema={onEditSchema}
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit schema" }));
    expect(onEditSchema).toHaveBeenCalledWith("context-plan");
  });
});

describe("ExecutionInspectorPanel — expansion receipts (R13.1)", () => {
  const acceptedReceipt = {
    requestId: "req-1",
    payloadHash: "a".repeat(64),
    invokerContextId: "context-plan",
    initiatorConversationId: "conv-1",
    rationale: "Fan out three candidate designs",
    addedContextIds: ["context-implement"],
    addedTaskIds: [],
    rejoinContextIds: ["context-verify"],
    liveRevision: 4,
    acceptedAt: "2026-03-27T14:22:00.000Z",
  };

  function expandedExecution(): GraphWorkflowExecution {
    return createWorkflowExecution({
      expansionReceipts: {
        accepted: [acceptedReceipt],
        refusals: [
          {
            requestId: "req-2",
            payloadHash: "b".repeat(64),
            invokerContextId: "context-plan",
            refusalCode: "expansion-context-cap-exceeded",
            refusedAt: "2026-03-27T14:25:00.000Z",
          },
        ],
      },
    });
  }

  it("shows the authorizing receipt on a runtime-added context", () => {
    render(
      <ExecutionInspectorPanel
        execution={expandedExecution()}
        events={[]}
        selectedContextId="context-implement"
        {...baseHandlers}
      />,
    );

    const section = screen.getByTestId("context-provenance");
    expect(section).toHaveTextContent("context-plan");
    expect(section).toHaveTextContent("Fan out three candidate designs");
    expect(section).toHaveTextContent("req-1");
  });

  it("lists accepted expansions and refusals in the overview", () => {
    render(
      <ExecutionInspectorPanel
        execution={expandedExecution()}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    openOverviewRow("expansion-ledger");

    const accepted = screen.getAllByTestId("expansion-accepted-row");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!).toHaveTextContent("Fan out three candidate designs");
    expect(accepted[0]!).toHaveTextContent("context-implement");

    const refusals = screen.getAllByTestId("expansion-refusal-row");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!).toHaveTextContent("expansion-context-cap-exceeded");
  });
});

describe("ExecutionInspectorPanel — execution-level advisory index (R9.4)", () => {
  function indexedExecution(): GraphWorkflowExecution {
    return createWorkflowExecution({
      advisoryIndex: [
        {
          identity: { roundSeq: 2, assignmentId: "security", ordinal: 1 },
          kind: "plan",
          title: "The plan skips the backfill",
          contextId: "context-plan",
        },
        {
          identity: { roundSeq: 1, assignmentId: "general", ordinal: 3 },
          kind: "out_of_scope",
          title: "The legacy importer is unreachable",
          contextId: "context-implement",
        },
      ],
    });
  }

  it("links an entry back to the context that raised it", () => {
    const onOpenAdvisoryOrigin = vi.fn();
    render(
      <ExecutionInspectorPanel
        execution={indexedExecution()}
        events={[]}
        selectedContextId={null}
        onOpenAdvisoryOrigin={onOpenAdvisoryOrigin}
        {...baseHandlers}
      />,
    );

    openOverviewRow("advisories");

    fireEvent.click(
      within(screen.getAllByTestId("advisory-index-entry")[1]!).getByTestId(
        "advisory-index-origin",
      ),
    );

    // The advisory's own identity travels, not just the number of the round it
    // names: a reset restarts the numbering, so the number alone cannot say
    // which round of that number the link means.
    expect(onOpenAdvisoryOrigin).toHaveBeenCalledWith({
      contextId: "context-implement",
      advisory: { roundSeq: 1, assignmentId: "general", ordinal: 3 },
    });
  });
});
