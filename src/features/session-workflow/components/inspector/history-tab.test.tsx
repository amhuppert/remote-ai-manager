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
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationSpecialistEntry,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowAgentSessionState,
  GraphWorkflowExecution,
  GraphWorkflowValidationRound,
} from "@/lib/workflow-graph/schemas";
import ContextDetail from "./ContextDetail";

/**
 * History tab, rendered (design E3, README §11). The model behind these screens
 * is pinned by `conversation-history.test.ts` and
 * `validation-rounds-model.test.ts`; what is proved here is what the model
 * cannot: that a reader can actually reach an implementer transcript from a
 * conversation row and a validator's own transcript from the verdict it gave,
 * and that a round states its status, iteration and frozen roster on screen.
 */

const CONTEXT_ID = "context-plan";

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

// Radix tabs activate on pointer-down, not on a bare synthetic click.
function openHistory() {
  fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
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

function contextStatus(
  occurredAt: string,
  iterationCount: number,
): GraphWorkflowExecutionEvent {
  return {
    occurredAt,
    preReset: false,
    event: {
      type: "graph-workflow-context-status",
      projectName: "project",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: CONTEXT_ID,
      status: "running",
      remainingTaskCount: 1,
      iterationCount,
    },
  };
}

function taskCompleted(
  occurredAt: string,
  conversationId: string,
): GraphWorkflowExecutionEvent {
  return {
    occurredAt,
    preReset: false,
    event: {
      type: "graph-workflow-task-status",
      projectName: "project",
      sessionName: "session-1",
      executionId: "execution-1",
      taskId: "task-plan-1",
      contextId: CONTEXT_ID,
      status: "completed",
      source: "user",
      order: 1,
      lastConversationId: conversationId,
      completedAt: occurredAt,
    },
  };
}

function seatVerdict(
  overrides: Partial<GraphWorkflowValidationSpecialistEntry> = {},
): GraphWorkflowValidationSpecialistEntry {
  return {
    assignmentId: "security",
    profile: { tier: "project", id: "security-reviewer", revision: 1 },
    resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
    pass: false,
    summary: "the timeout path skips the audit record",
    issues: [],
    advisories: [],
    sessionRef: {
      backend: "claude",
      ref: "conv_val_security",
      lane: "context_validator",
      refKind: "conversation",
      workflowConversationId: "conv_val_security",
    },
    reviewArtifact: null,
    usage: null,
    ...overrides,
  };
}

function rejection(
  occurredAt: string,
  roundSeq: number,
): GraphWorkflowExecutionEvent {
  return {
    occurredAt,
    preReset: false,
    event: {
      type: "graph-workflow-validation-result",
      projectName: "project",
      sessionName: "session-1",
      executionId: "execution-1",
      contextId: CONTEXT_ID,
      validatorType: "context",
      kind: "context_validation",
      pass: false,
      summary: "cohort rejected",
      reopenTaskIds: ["task-plan-1"],
      issues: [],
      rejectedOutput: null,
      gateRepairAttempts: null,
      gateRepairBudget: null,
      roundSeq,
      specialists: [seatVerdict()],
    },
  };
}

function implementerLane(
  conversationId: string,
): Record<string, Record<string, GraphWorkflowAgentSessionState>> {
  return {
    [CONTEXT_ID]: {
      implementer: {
        lane: "implementer",
        contextId: CONTEXT_ID,
        backend: "claude",
        refKind: "conversation",
        workflowConversationId: conversationId,
        metrics: { rotateBeforeNextTurn: false },
        limitEvaluation: "supported",
        lastUsedAt: "2026-03-27T11:09:00.000Z",
      },
    },
  };
}

function runningExecution(
  overrides: Partial<GraphWorkflowExecution> = {},
): GraphWorkflowExecution {
  const base = createWorkflowExecution({ status: "running", ...overrides });
  return {
    ...base,
    contextStates: {
      ...base.contextStates,
      [CONTEXT_ID]: {
        ...base.contextStates[CONTEXT_ID]!,
        status: "running",
        iterationCount: 2,
        ...(overrides.contextStates?.[CONTEXT_ID] ?? {}),
      },
    },
  };
}

/** One conversation that did the work, was rejected by a seat, and stays live. */
function rejectedHistory(): {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
} {
  return {
    execution: runningExecution({ laneStates: implementerLane("conv_a9c2") }),
    events: [
      contextStatus("2026-03-27T09:40:00.000Z", 1),
      taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
      rejection("2026-03-27T10:42:00.000Z", 1),
    ],
  };
}

describe("History tab — transcript reachability", () => {
  it("opens the implementer transcript from the conversation row that owns it", () => {
    const onViewConversation = vi.fn();
    const { execution, events } = rejectedHistory();

    render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId={CONTEXT_ID}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );
    openHistory();

    const row = screen.getByTestId("conversation-row");
    expect(row).toHaveAttribute("data-conversation-id", "conv_a9c2");
    fireEvent.click(within(row).getByTestId("conversation-transcript-button"));

    expect(onViewConversation).toHaveBeenCalledWith(
      "conv_a9c2",
      "implementer",
      CONTEXT_ID,
      undefined,
    );
  });

  // The whole reason the validator link sits on the verdict rather than on the
  // row: one conversation's history holds several seats' judgements, and each
  // seat wrote its own transcript.
  it("opens the seat's own transcript from the verdict it gave, under its assignment label", () => {
    const onViewConversation = vi.fn();
    const { execution, events } = rejectedHistory();

    render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId={CONTEXT_ID}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );
    openHistory();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open security validator transcript",
      }),
    );

    expect(onViewConversation).toHaveBeenCalledWith(
      "conv_val_security",
      "context_validator",
      CONTEXT_ID,
      "Validator · security",
    );
  });

  it("renders the verdict and the rotation copy as events inside the row, not as rows of their own", () => {
    const { execution, events } = rejectedHistory();

    render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId={CONTEXT_ID}
        onViewConversation={vi.fn()}
        {...baseHandlers}
      />,
    );
    openHistory();

    const row = screen.getByTestId("conversation-row");
    const kinds = within(row)
      .getAllByTestId("conversation-event")
      .map((event) => event.getAttribute("data-event-kind"));

    expect(kinds).toContain("started");
    expect(kinds).toContain("task_completed");
    expect(kinds).toContain("verdict");
    expect(within(row).getByText(/security rejected/)).toBeInTheDocument();
  });

  // The execution records no rotation provenance, and every fresh implementer
  // conversation coincides with an iteration increment — so adjacency proves the
  // transition and nothing about its cause.
  it("names the transition in both directions without claiming why a conversation was replaced", () => {
    const events = [
      contextStatus("2026-03-27T09:40:00.000Z", 1),
      taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
      rejection("2026-03-27T10:42:00.000Z", 1),
      contextStatus("2026-03-27T10:42:30.000Z", 2),
      taskCompleted("2026-03-27T11:04:00.000Z", "conv_b41f"),
    ];

    render(
      <ContextDetail
        execution={runningExecution({
          laneStates: implementerLane("conv_b41f"),
        })}
        events={events}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    const rows = screen.getAllByTestId("conversation-row");
    const [successor, predecessor] = rows;
    expect(successor).toHaveAttribute("data-conversation-id", "conv_b41f");
    expect(predecessor).toHaveAttribute("data-conversation-id", "conv_a9c2");

    // Both directions of the chain are walkable.
    expect(
      within(successor as HTMLElement).getByText(/took over from conv_a9c2/),
    ).toBeInTheDocument();
    expect(
      within(predecessor as HTMLElement).getByText(/superseded by conv_b41f/),
    ).toBeInTheDocument();

    for (const row of rows) {
      expect(row.textContent ?? "").not.toMatch(
        /context limit|continues|fresh conversation/i,
      );
    }
  });

  // The row is the conversation, and a conversation is not an iteration: a
  // returning validation reopens work inside the conversation already live, so
  // the row names every iteration its events belong to rather than one.
  it("names each iteration a conversation hosted events for", () => {
    const events = [
      contextStatus("2026-03-27T09:40:00.000Z", 1),
      taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
      rejection("2026-03-27T10:42:00.000Z", 1),
      contextStatus("2026-03-27T10:42:30.000Z", 2),
      taskCompleted("2026-03-27T11:04:00.000Z", "conv_a9c2"),
    ];

    render(
      <ContextDetail
        execution={runningExecution({
          laneStates: implementerLane("conv_a9c2"),
        })}
        events={events}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    const row = screen.getByTestId("conversation-row");
    expect(
      within(row).getByTestId("conversation-iterations"),
    ).toHaveTextContent("iterations 1, 2");
  });

  it("names the one iteration a conversation stayed inside", () => {
    const { execution, events } = rejectedHistory();

    render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    expect(
      within(screen.getByTestId("conversation-row")).getByTestId(
        "conversation-iterations",
      ),
    ).toHaveTextContent("iteration 1");
  });

  // A rejection and the status mark it causes are consecutive writes and can
  // share a millisecond. The round judged the iteration it was opened in, not
  // the one its own verdict began.
  it("labels a round with the iteration it judged when the next mark shares its millisecond", () => {
    const tied = "2026-03-27T10:42:00.000Z";

    render(
      <ContextDetail
        execution={runningExecution({
          laneStates: implementerLane("conv_a9c2"),
        })}
        events={[
          contextStatus("2026-03-27T09:40:00.000Z", 1),
          taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
          rejection(tied, 1),
          contextStatus(tied, 2),
        ]}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    expect(screen.getByTestId("validation-round-row")).toHaveTextContent(
      "round 1 · iteration 1",
    );
  });

  it("offers no transcript control at all when the host owns no Log surface", () => {
    const { execution, events } = rejectedHistory();

    render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    expect(screen.queryByTestId("conversation-transcript-button")).toBeNull();
    expect(screen.queryByTestId("validator-transcript-button")).toBeNull();
  });
});

describe("History tab — validation rounds card states", () => {
  function withLiveRound(
    round: GraphWorkflowValidationRound,
    events: GraphWorkflowExecutionEvent[],
  ): {
    execution: GraphWorkflowExecution;
    events: GraphWorkflowExecutionEvent[];
  } {
    const execution = runningExecution({
      laneStates: implementerLane("conv_a9c2"),
    });
    return {
      execution: {
        ...execution,
        contextStates: {
          ...execution.contextStates,
          [CONTEXT_ID]: {
            ...execution.contextStates[CONTEXT_ID]!,
            validationRound: round,
          },
        },
      },
      events,
    };
  }

  it("shows a round still in flight with the roster it froze", () => {
    const { execution, events } = withLiveRound(
      {
        seq: 2,
        candidate: {
          headSha: "head-2",
          candidateTreeHash: "tree-2",
          taskStateHash: "tasks-2",
          identityScope: "wholeTree",
        },
        roster: [
          {
            assignmentId: "security",
            profileRef: { tier: "project", id: "security-reviewer" },
            revision: 1,
            resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
            strategy: "conversation",
          },
          {
            assignmentId: "performance",
            profileRef: { tier: "project", id: "performance-reviewer" },
            revision: 1,
            resolvedInstructionHash: `sha256:${"d".repeat(64)}`,
            strategy: "conversation",
          },
        ],
        specialists: {
          security: {
            state: "running",
            attempts: 1,
            summary: null,
            issues: [],
            advisories: [],
            questionToken: null,
            sessionRef: null,
            reviewArtifact: null,
            lastInfraFailure: null,
          },
        },
        phase: "specialists",
        outcome: null,
        startedAt: "2026-03-27T11:05:00.000Z",
      },
      [contextStatus("2026-03-27T09:40:00.000Z", 2)],
    );

    render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    const row = screen
      .getByTestId("validation-rounds")
      .querySelector('[data-testid="validation-round-row"]');
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("data-status", "in_flight");
    expect(row).toHaveTextContent("round 2 · iteration 2");
    expect(
      within(row as HTMLElement).getByTestId("validation-round-roster"),
    ).toHaveTextContent("roster frozen: security, performance");
  });

  // The footer is round metadata, not an artifact: a reader comparing rounds
  // reads spend and references off the list without opening anything.
  it("states a round's spend and references on the row, before anything is expanded", () => {
    const execution = runningExecution({
      laneStates: implementerLane("conv_a9c2"),
    });
    const spent = rejection("2026-03-27T10:42:00.000Z", 1);
    if (spent.event.type !== "graph-workflow-validation-result") {
      throw new Error("fixture is a validation result");
    }
    spent.event.specialists = [
      seatVerdict({
        reviewArtifact: {
          backend: "claude",
          kind: "response",
          ref: "artifact/security-round-1",
          response: "the timeout path skips the audit record",
          usage: {
            inputTokens: 900,
            cachedInputTokens: 0,
            outputTokens: 120,
            costUsd: 0.42,
          },
        },
      }),
    ];

    render(
      <ContextDetail
        execution={execution}
        events={[
          contextStatus("2026-03-27T09:40:00.000Z", 1),
          taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
          spent,
        ]}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    const row = screen
      .getByTestId("validation-rounds")
      .querySelector(
        '[data-testid="validation-round-row"][data-round-seq="1"]',
      ) as HTMLElement;
    const footer = within(row).getByTestId("validation-round-footer");
    expect(footer).toHaveTextContent("$0.42");
    expect(footer).toHaveTextContent("artifact/security-round-1");
    // Still closed: the footer is not the artifacts.
    expect(row).not.toHaveTextContent(
      "the timeout path skips the audit record",
    );
  });

  // The aggregate carries only the lanes that reported a verdict, so a seat the
  // round froze and then lost to infrastructure is absent from it. The roster
  // line must still name the seat that was on the round.
  it("names a frozen seat that never reported, from the incident that took it out", () => {
    const execution = runningExecution({
      laneStates: implementerLane("conv_a9c2"),
    });
    const exhausted: GraphWorkflowExecutionEvent = {
      occurredAt: "2026-03-27T10:41:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-incident",
        projectName: "project",
        sessionName: "session-1",
        executionId: "execution-1",
        contextId: CONTEXT_ID,
        incident: "infra_exhausted",
        roundSeq: 1,
        stage: "specialist_result",
        assignmentId: "performance",
        attempts: 3,
        driftedComponents: "",
        message: "performance spent every attempt on infrastructure failures",
      },
    };

    render(
      <ContextDetail
        execution={execution}
        events={[
          contextStatus("2026-03-27T09:40:00.000Z", 1),
          taskCompleted("2026-03-27T10:38:00.000Z", "conv_a9c2"),
          exhausted,
          rejection("2026-03-27T10:42:00.000Z", 1),
        ]}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    const row = screen
      .getByTestId("validation-rounds")
      .querySelector(
        '[data-testid="validation-round-row"][data-round-seq="1"]',
      ) as HTMLElement;
    expect(
      within(row).getByTestId("validation-round-roster"),
    ).toHaveTextContent("roster frozen: security, performance");
  });

  it("shows a concluded rejection, and keeps what the round produced behind its Artifacts control", () => {
    const { execution, events } = rejectedHistory();

    render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    const row = screen
      .getByTestId("validation-rounds")
      .querySelector(
        '[data-testid="validation-round-row"][data-round-seq="1"]',
      );
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("data-status", "rejected");
    expect(
      within(row as HTMLElement).getByTestId("validation-round-roster"),
    ).toHaveTextContent("roster frozen: security");

    // Closed by default: the rounds list is a list of rounds, not of findings.
    expect(row).not.toHaveTextContent(
      "the timeout path skips the audit record",
    );

    fireEvent.click(
      within(row as HTMLElement).getByTestId("validation-round-artifacts"),
    );
    expect(row).toHaveTextContent("the timeout path skips the audit record");
  });

  // Every claim this tab makes — that a round left no record, that these are
  // the conversations the context worked in — is a claim about the WHOLE log.
  // While the reader still holds only part of it, a retained round can sit
  // outside the part held, and calling its number a gap states the opposite of
  // what the execution recorded.
  it("makes no claim about a round's record while the execution log is still being read", () => {
    const { execution, events } = withLiveRound(
      {
        seq: 2,
        candidate: {
          headSha: "head-2",
          candidateTreeHash: "tree-2",
          taskStateHash: "tasks-2",
          identityScope: "wholeTree",
        },
        roster: [
          {
            assignmentId: "security",
            profileRef: { tier: "project", id: "security-reviewer" },
            revision: 1,
            resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
            strategy: "conversation",
          },
        ],
        specialists: {},
        phase: "specialists",
        outcome: null,
        startedAt: "2026-03-27T11:05:00.000Z",
      },
      [contextStatus("2026-03-27T09:40:00.000Z", 2)],
    );

    render(
      <ContextDetail
        execution={execution}
        events={events}
        eventsAreComplete={false}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    expect(screen.queryByTestId("validation-rounds")).toBeNull();
    expect(screen.queryByTestId("conversation-row")).toBeNull();
    expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
      /reading the execution log/i,
    );
  });

  it("says so plainly when a context has never been validated", () => {
    render(
      <ContextDetail
        execution={runningExecution()}
        events={[contextStatus("2026-03-27T09:40:00.000Z", 1)]}
        contextId={CONTEXT_ID}
        {...baseHandlers}
      />,
    );
    openHistory();

    expect(screen.getByTestId("validation-rounds")).toHaveTextContent(
      "No validation has run for this context yet.",
    );
  });
});
