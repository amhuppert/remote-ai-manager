// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeImplementerAssignment,
  makeValidatorAssignment,
  seedAssignment,
} from "@/lib/workflow-graph/test-fixtures";
import { TESTFAKE_BACKEND_ID } from "@/lib/agent-backends/testing/testfake-backend";
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
  GraphWorkflowValidationIncidentEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationReviewArtifact,
  GraphWorkflowValidationRound,
  GraphWorkflowValidationSessionRef,
} from "@/lib/workflow-graph/schemas";
import type { SeededValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
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

function conversationValidationRef(
  ref: string,
): GraphWorkflowValidationSessionRef {
  return {
    backend: "claude",
    ref,
    lane: "context_validator",
    refKind: "conversation",
    workflowConversationId: ref,
  };
}

function responseValidationRef(ref: string): GraphWorkflowValidationSessionRef {
  return {
    backend: "codex",
    ref,
    lane: "context_validator",
    refKind: "backend",
  };
}

function responseReviewArtifact(
  ref: string,
  response: string,
): GraphWorkflowValidationReviewArtifact {
  return {
    backend: "codex",
    kind: "response",
    ref,
    response,
    usage: null,
  };
}

function makeExecutionWithHistory(
  events: GraphWorkflowValidationResultEvent[],
): {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
} {
  const history = events.map((event, i) => ({
    occurredAt: `2026-03-27T10:0${i}:00.000Z`,
    event,
    preReset: false,
  }));
  return { execution: createWorkflowExecution(), events: history };
}

describe("ExecutionInspectorPanel — ValidationCard markdown formatting", () => {
  it("renders summary with markdown inline code for any validator", async () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        summary: "All 23 tests passed via `bunx vitest run`",
        sessionRef: conversationValidationRef("conv-md"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // The canonical Markdown adapter defers its renderer — wait for it to mount.
    // Cold-load of the dynamic chunk can exceed the 1000ms default timeout
    // under parallel test-suite load.
    const codeEl = await screen.findByText("bunx vitest run", undefined, {
      timeout: 15000,
    });
    expect(codeEl.closest("code")).toBeTruthy();
  });

  it("renders issue descriptions as markdown for any validator", async () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        pass: false,
        summary: "Failed",
        issues: [
          {
            taskId: "task-1",
            title: "Missing coverage",
            description: "No tests for `handleSubmit` function",
          },
        ],
        sessionRef: conversationValidationRef("conv-md-2"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    const codeEl = await screen.findByText("handleSubmit");
    expect(codeEl.closest("code")).toBeTruthy();
  });

  it("routes summary and issue descriptions through the compact canonical adapter", async () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        pass: false,
        summary: "Uses ~~legacy~~ **canonical** rendering",
        issues: [
          {
            taskId: "task-1",
            title: "Missing coverage",
            description: "No test for the ~~old~~ path",
          },
        ],
        sessionRef: {
          backend: "claude",
          ref: "conv-canonical",
          lane: "context_validator",
          refKind: "conversation",
          workflowConversationId: "conv-canonical",
        },
      }),
    ]);

    const { container } = render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // GFM strikethrough proves it flows through the canonical renderer.
    const del = await screen.findByText("legacy", undefined, {
      timeout: 15000,
    });
    expect(del.tagName).toBe("DEL");
    expect(del.closest('[data-markdown-intent="compact"]')).not.toBeNull();
    // Migrated inspector fields no longer lean on the generated-descendant hook.
    expect(container.querySelector(".wb-markdown-inline")).toBeNull();
  });
});

describe("ExecutionInspectorPanel — ValidationCard lane and backend badges", () => {
  it("renders Context badge for context_validator lane", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: conversationValidationRef("conv-1"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Context")).toBeInTheDocument();
  });

  it("renders backend badge showing claude", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: conversationValidationRef("conv-1"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("claude")).toBeInTheDocument();
  });

  it("renders backend badge showing codex", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: responseReviewArtifact("thread-xyz", "Looks good"),
        sessionRef: responseValidationRef("thread-xyz"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("codex")).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — View Transcript button", () => {
  it("opens the workflow conversation owned by a provider-neutral validator ref", () => {
    const onViewConversation = vi.fn();
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        contextId: "context-plan",
        sessionRef: {
          backend: TESTFAKE_BACKEND_ID,
          ref: "testfake-native-ref",
          lane: "context_validator",
          refKind: "conversation",
          workflowConversationId: "workflow-conversation-1",
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("testfake")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /View Transcript/i }));
    expect(onViewConversation).toHaveBeenCalledWith(
      "workflow-conversation-1",
      "context_validator",
      "context-plan",
    );
  });

  it("shows View Transcript button for claude validation when handler is provided", () => {
    const onViewConversation = vi.fn();
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: conversationValidationRef("conv-abc"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    expect(
      screen.getByRole("button", { name: /View Transcript/i }),
    ).toBeInTheDocument();
  });

  it("calls onViewConversation with correct args when View Transcript is clicked", () => {
    const onViewConversation = vi.fn();
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        contextId: "context-plan",
        sessionRef: conversationValidationRef("conv-abc"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /View Transcript/i }));

    expect(onViewConversation).toHaveBeenCalledWith(
      "conv-abc",
      "context_validator",
      "context-plan",
    );
  });

  it("does not show View Transcript button when onViewConversation is not provided", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: conversationValidationRef("conv-abc"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /View Transcript/i }),
    ).not.toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — Codex review artifact", () => {
  it("renders a response artifact under its actual backend identity", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: {
          backend: TESTFAKE_BACKEND_ID,
          kind: "response",
          ref: "testfake-review-ref",
          response: "Testfake review response",
          usage: null,
        },
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Testfake Review")).toBeInTheDocument();
    expect(screen.getByText("testfake-review-ref")).toBeInTheDocument();
  });

  it("displays codex thread ID in artifact section", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: responseReviewArtifact(
          "thread-codex-99",
          "Code looks correct",
        ),
        sessionRef: responseValidationRef("thread-codex-99"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("thread-codex-99")).toBeInTheDocument();
  });

  it("displays codex response text in artifact section", async () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: responseReviewArtifact(
          "thread-1",
          "Everything checks out.",
        ),
        sessionRef: responseValidationRef("thread-1"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // The plain-text response first paints in the adapter's streaming
    // fallback, which is then swapped for the loaded canonical root. Poll until
    // the text lands inside that root so we never assert on the detached
    // fallback node (cold chunk load can exceed the 1000ms default).
    await waitFor(
      () =>
        expect(
          screen
            .getByText("Everything checks out.")
            .closest('[data-markdown-intent="compact"]'),
        ).not.toBeNull(),
      { timeout: 15000 },
    );
  });

  it("parses JSON codex response and renders summary as markdown instead of raw JSON", async () => {
    const jsonResponse = JSON.stringify({
      pass: true,
      summary: "Validated with `bunx vitest run` command. All 23 tests passed.",
      issues: [],
    });
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: responseReviewArtifact("thread-json-1", jsonResponse),
        sessionRef: responseValidationRef("thread-json-1"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // Summary text should be rendered (markdown strips backticks into <code>);
    // the canonical adapter loads its renderer behind one dynamic import.
    const codeEl = await screen.findByText("bunx vitest run", undefined, {
      timeout: 15000,
    });
    expect(codeEl.closest("code")).toBeTruthy();
    expect(screen.getByText(/All 23 tests passed/)).toBeInTheDocument();
    // Raw JSON must NOT appear
    expect(screen.queryByText(jsonResponse)).not.toBeInTheDocument();
  });

  it("renders issues from parsed codex response JSON", async () => {
    const jsonResponse = JSON.stringify({
      pass: false,
      summary: "Found issues in implementation",
      issues: [
        {
          title: "Missing test coverage",
          description: "The `handleSubmit` function has no unit tests",
        },
        {
          title: "Type error",
          description: "Parameter type mismatch in `processData`",
        },
      ],
    });
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: responseReviewArtifact("thread-json-2", jsonResponse),
        sessionRef: responseValidationRef("thread-json-2"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // Issue titles rendered
    expect(screen.getByText("Missing test coverage")).toBeInTheDocument();
    expect(screen.getByText("Type error")).toBeInTheDocument();
    // Issue descriptions rendered with markdown (backtick code) once the
    // canonical adapter's renderer resolves behind its dynamic import.
    const codeEl = await screen.findByText("handleSubmit", undefined, {
      timeout: 15000,
    });
    expect(codeEl.closest("code")).toBeTruthy();
    expect(screen.getByText("processData").closest("code")).toBeTruthy();
  });

  it("renders non-JSON codex response as markdown", async () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        reviewArtifact: responseReviewArtifact(
          "thread-plain",
          "All tests pass with `vitest` runner.",
        ),
        sessionRef: responseValidationRef("thread-plain"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // Inline code from backticks should be rendered as <code> once the
    // canonical adapter's renderer resolves behind its dynamic import.
    const codeEl = await screen.findByText("vitest", undefined, {
      timeout: 15000,
    });
    expect(codeEl.closest("code")).toBeTruthy();
  });
});

describe("ExecutionInspectorPanel — continued session badge", () => {
  it("shows continued badge when the same session is reused in a newer validation", () => {
    // Two events in the same lane with the same conversationId — the newer one (index 0
    // in the reversed display) gets the badge when the older one set the session.
    const olderEvent = makeValidationEvent({
      sessionRef: conversationValidationRef("conv-shared"),
    });
    const newerEvent = makeValidationEvent({
      sessionRef: conversationValidationRef("conv-shared"),
    });
    const history = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: olderEvent,
        preReset: false,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: newerEvent,
        preReset: false,
      },
    ];
    const execution = createWorkflowExecution();
    const events = history;

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // "↺ continued" badge should appear for the reused session
    expect(screen.getByText("↺ continued")).toBeInTheDocument();
  });

  it("uses workflow conversation ownership when a legacy native ref rotates", () => {
    const legacyConversationRef = (
      ref: string,
    ): GraphWorkflowValidationSessionRef => ({
      backend: "claude",
      ref,
      lane: "context_validator",
      refKind: "conversation",
      workflowConversationId: "conv-shared",
    });
    const history = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: makeValidationEvent({
          sessionRef: legacyConversationRef("sdk-session-1"),
        }),
        preReset: false,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: makeValidationEvent({
          sessionRef: legacyConversationRef("sdk-session-2"),
        }),
        preReset: false,
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution()}
        events={history}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("↺ continued")).toBeInTheDocument();
  });

  it("does not show continued badge when sessions differ between validations", () => {
    const firstEvent = makeValidationEvent({
      sessionRef: conversationValidationRef("conv-1"),
    });
    const secondEvent = makeValidationEvent({
      sessionRef: conversationValidationRef("conv-2"),
    });
    const history = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: firstEvent,
        preReset: false,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: secondEvent,
        preReset: false,
      },
    ];
    const execution = createWorkflowExecution();
    const events = history;

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.queryByText("↺ continued")).not.toBeInTheDocument();
  });

  it("both validation history entries remain independently viewable when they share the same session", () => {
    const onViewConversation = vi.fn();
    const sharedConvId = "conv-shared";

    const olderEvent = makeValidationEvent({
      contextId: "context-plan",
      sessionRef: conversationValidationRef(sharedConvId),
    });
    const newerEvent = makeValidationEvent({
      contextId: "context-plan",
      sessionRef: conversationValidationRef(sharedConvId),
    });
    const history = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: olderEvent,
        preReset: false,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: newerEvent,
        preReset: false,
      },
    ];
    const execution = createWorkflowExecution();
    const events = history;

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    // Both history entries must render a View Transcript button
    const buttons = screen.getAllByRole("button", { name: /View Transcript/i });
    expect(buttons).toHaveLength(2);

    // Each button calls onViewConversation with the shared conversationId
    fireEvent.click(buttons[0]!);
    expect(onViewConversation).toHaveBeenCalledWith(
      sharedConvId,
      "context_validator",
      "context-plan",
    );
    fireEvent.click(buttons[1]!);
    expect(onViewConversation).toHaveBeenCalledTimes(2);
  });
});

describe("ExecutionInspectorPanel — reopened tasks", () => {
  it("renders reopened task ids for failed context validation", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        pass: false,
        reopenTaskIds: ["task-plan-1", "task-implement-1"],
        sessionRef: conversationValidationRef("conv-reopen"),
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Reopened Tasks (2)")).toBeInTheDocument();
    expect(screen.getByText("task-plan-1")).toBeInTheDocument();
    expect(screen.getByText("task-implement-1")).toBeInTheDocument();
  });
});

// R12.2: a multi-assignment round adds specialist entries to the aggregate and
// nulls its single-reviewer refs. The panel's newest-first derivation reads the
// top-level verdict, which is unchanged — the entries are additive, and no
// existing rendering may start behaving differently because they are present.
describe("ExecutionInspectorPanel — multi-assignment cohort rounds", () => {
  const COHORT_SPECIALISTS = [
    {
      assignmentId: "general",
      profile: {
        tier: "builtin" as const,
        id: "general-reviewer",
        revision: 1,
      },
      resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
      advisories: [],
      pass: true,
      summary: "general: ok",
      issues: [],
      sessionRef: null,
      reviewArtifact: null,
      usage: null,
    },
    {
      assignmentId: "security",
      profile: {
        tier: "project" as const,
        id: "security-reviewer",
        revision: 4,
      },
      resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
      advisories: [],
      pass: false,
      summary: "security: no",
      issues: [],
      sessionRef: null,
      reviewArtifact: null,
      usage: null,
    },
  ];

  it("derives the newest verdict from the aggregate, ignoring the cohort detail", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        pass: true,
        summary: "An older round that passed",
        sessionRef: conversationValidationRef("conv-older"),
      }),
      makeValidationEvent({
        pass: false,
        summary: "The cohort rejected the work",
        reopenTaskIds: ["task-plan-1"],
        roundSeq: 2,
        specialists: COHORT_SPECIALISTS,
        // No single reviewer owns a multi-specialist round.
        sessionRef: null,
        reviewArtifact: null,
      }),
    ]);

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    // Newest first: the cohort round is the verdict on top, and its aggregate
    // reopen list renders exactly as a single reviewer's would.
    expect(
      screen.getByText("The cohort rejected the work"),
    ).toBeInTheDocument();
    expect(screen.getByText("Reopened Tasks (1)")).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — shared implementer session task history", () => {
  it("tasks sharing the same implementer lastConversationId both show independent View buttons", () => {
    const onViewTask = vi.fn();

    // Extend the default definition with a second task in context-plan
    const baseDef = createResolvedWorkflowDefinition();
    const definition = {
      ...baseDef,
      tasks: [
        ...baseDef.tasks,
        {
          id: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          title: "Write tests",
          instructions: "Add test coverage.",
          source: "user" as const,
        },
      ],
    };

    const sharedConvId = "conv-impl-shared";
    const execution = createWorkflowExecution({
      workingDefinition: definition,
      activeContextIds: ["context-plan"],
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "completed",
          summary: "Inspected",
          startedAt: "2026-03-27T10:00:00.000Z",
          completedAt: "2026-03-27T10:05:00.000Z",
          lastConversationId: sharedConvId,
          failureMessage: null,
          failureHistory: [],
        },
        "task-plan-2": {
          taskId: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          status: "completed",
          summary: "Tests written",
          startedAt: "2026-03-27T10:05:00.000Z",
          completedAt: "2026-03-27T10:10:00.000Z",
          lastConversationId: sharedConvId,
          failureMessage: null,
          failureHistory: [],
        },
        "task-implement-1": {
          taskId: "task-implement-1",
          contextId: "context-implement",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-verify-1": {
          taskId: "task-verify-1",
          contextId: "context-verify",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onViewTask={onViewTask}
        viewingTaskId={null}
      />,
    );

    // Both completed tasks with a shared implementer session should show "View"
    const viewButtons = screen.getAllByRole("button", { name: "View" });
    expect(viewButtons).toHaveLength(2);

    // Each button independently invokes onViewTask with its own task ID
    fireEvent.click(viewButtons[0]!);
    expect(onViewTask).toHaveBeenCalledWith("task-plan-1");

    fireEvent.click(viewButtons[1]!);
    expect(onViewTask).toHaveBeenCalledWith("task-plan-2");

    // No deduplication — both calls occurred
    expect(onViewTask).toHaveBeenCalledTimes(2);
  });
});

describe("ExecutionInspectorPanel — live implementer viewing", () => {
  it("shows Watch for an incomplete task when the active iteration is live", () => {
    const onViewTask = vi.fn();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: "2026-03-27T10:00:00.000Z",
          completedAt: null,
          lastConversationId: "conv-live",
          failureMessage: null,
          failureHistory: [],
        },
        "task-implement-1": {
          taskId: "task-implement-1",
          contextId: "context-implement",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-verify-1": {
          taskId: "task-verify-1",
          contextId: "context-verify",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
      machineSnapshot: {
        schemaVersion: 1,
        lifecycleStatus: "running",
        activeContextId: "context-plan",
        recoveryMode: "none",
        hasLiveIteration: true,
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onViewTask={onViewTask}
      />,
    );

    expect(screen.getByRole("button", { name: "Watch" })).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — task editability", () => {
  it("does not show edit controls for a running task", () => {
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      taskStates: {
        ...baseExecution.taskStates,
        "task-plan-1": {
          ...baseExecution.taskStates["task-plan-1"]!,
          status: "running",
        },
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getByText("Inspect code"));

    expect(screen.queryByText("Edit Title")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("does not show edit controls while a live iteration is active for the task context", () => {
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      taskStates: {
        ...baseExecution.taskStates,
        "task-plan-1": {
          ...baseExecution.taskStates["task-plan-1"]!,
          status: "pending",
          lastConversationId: "conversation-live",
        },
      },
      machineSnapshot: {
        schemaVersion: 1,
        lifecycleStatus: "running",
        activeContextId: "context-plan",
        recoveryMode: "none",
        hasLiveIteration: true,
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getByText("Inspect code"));

    expect(screen.queryByText("Edit Title")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove" }),
    ).not.toBeInTheDocument();
  });

  it("reorders only editable tasks within a context", () => {
    const onReorderTask = vi.fn();
    const baseDefinition = createResolvedWorkflowDefinition();
    const definition = {
      ...baseDefinition,
      tasks: [
        {
          id: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          title: "Inspect code",
          instructions: "Read the relevant files.",
          source: "user" as const,
        },
        {
          id: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          title: "Write plan",
          instructions: "Document the plan.",
          source: "user" as const,
        },
        {
          id: "task-plan-3",
          contextId: "context-plan",
          order: 3,
          title: "Capture risks",
          instructions: "Summarize the remaining risks.",
          source: "user" as const,
        },
        ...baseDefinition.tasks.filter(
          (task) => task.contextId !== "context-plan",
        ),
      ],
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: definition,
    });
    const execution = createWorkflowExecution({
      status: "paused",
      workingDefinition: definition,
      taskStates: {
        ...baseExecution.taskStates,
        "task-plan-1": {
          ...baseExecution.taskStates["task-plan-1"]!,
          status: "completed",
          completedAt: "2026-03-27T10:05:00.000Z",
        },
        "task-plan-2": {
          ...baseExecution.taskStates["task-plan-2"]!,
          status: "pending",
        },
        "task-plan-3": {
          taskId: "task-plan-3",
          contextId: "context-plan",
          order: 3,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          totalTaskCount: 3,
          completedTaskCount: 1,
        },
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onReorderTask={onReorderTask}
      />,
    );

    fireEvent.click(screen.getByText("Capture risks"));
    fireEvent.click(screen.getByRole("button", { name: "▴ Up" }));

    expect(onReorderTask).toHaveBeenCalledWith("context-plan", [
      "task-plan-3",
      "task-plan-2",
    ]);
  });
});

describe("ExecutionInspectorPanel — awaiting-approval status badge", () => {
  it("shows an Awaiting Approval badge for a parked context in the detail view", () => {
    const baseExecution = createWorkflowExecution({ status: "running" });
    const execution = createWorkflowExecution({
      status: "running",
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "awaiting_approval",
        },
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    const badge = screen.getByText("Awaiting Approval");
    expect(badge).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — Reset Context", () => {
  it("shows a Reset button when execution is paused and context is not completed", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /reset context/i }),
    ).toBeInTheDocument();
  });

  it("shows a Reset button when execution is halted and context is not completed", () => {
    const execution = createWorkflowExecution({ status: "halted" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /reset context/i }),
    ).toBeInTheDocument();
  });

  it("hides the Reset button when execution is running", () => {
    const execution = createWorkflowExecution({ status: "running" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /reset context/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the Reset button when the selected context is completed", () => {
    const baseExecution = createWorkflowExecution({ status: "paused" });
    const execution = createWorkflowExecution({
      status: "paused",
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
        },
      },
    });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /reset context/i }),
    ).not.toBeInTheDocument();
  });

  it("hides the Reset button when no onResetContext handler is provided", () => {
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /reset context/i }),
    ).not.toBeInTheDocument();
  });

  it("opens a confirmation dialog on Reset and calls onResetContext after confirming", () => {
    const onResetContext = vi.fn();
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={onResetContext}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reset context/i }));

    expect(screen.getByText("Reset context?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));

    expect(onResetContext).toHaveBeenCalledWith("context-plan");
  });

  it("does not call onResetContext when the confirmation dialog is cancelled", () => {
    const onResetContext = vi.fn();
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onResetContext={onResetContext}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /reset context/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onResetContext).not.toHaveBeenCalled();
    expect(screen.queryByText("Reset context?")).not.toBeInTheDocument();
  });

  it("hides history entries flagged as preReset in the detail history tab", () => {
    const visibleEvent = makeValidationEvent({
      contextId: "context-plan",
      summary: "Kept after reset",
    });
    const hiddenEvent = makeValidationEvent({
      contextId: "context-plan",
      summary: "Discarded by reset",
    });
    const execution = createWorkflowExecution({ status: "paused" });
    const events = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: hiddenEvent,
        preReset: true,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: visibleEvent,
        preReset: false,
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab(/history/i);

    expect(screen.getByText("Kept after reset")).toBeInTheDocument();
    expect(screen.queryByText("Discarded by reset")).not.toBeInTheDocument();
  });

  it("hides history entries flagged as preReset in the overview validations section", () => {
    const visibleEvent = makeValidationEvent({
      contextId: "context-plan",
      summary: "Kept after reset",
    });
    const hiddenEvent = makeValidationEvent({
      contextId: "context-plan",
      summary: "Discarded by reset",
    });
    const execution = createWorkflowExecution({ status: "paused" });
    const events = [
      {
        occurredAt: "2026-03-27T10:00:00.000Z",
        event: hiddenEvent,
        preReset: true,
      },
      {
        occurredAt: "2026-03-27T10:01:00.000Z",
        event: visibleEvent,
        preReset: false,
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Kept after reset")).toBeInTheDocument();
    expect(screen.queryByText("Discarded by reset")).not.toBeInTheDocument();
  });
});

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

    expect(screen.getByText("Launch Inputs")).toBeInTheDocument();
    expect(screen.getByText("feature")).toBeInTheDocument();
    expect(screen.getByText("search box")).toBeInTheDocument();
    expect(screen.getByText("priority")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("omits the Launch Inputs section for a zero-input execution", () => {
    const execution = createWorkflowExecution({ boundInputs: {} });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.queryByText("Launch Inputs")).not.toBeInTheDocument();
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

  it("mounts the question panel for the selected parked context when userInputPanels is provided", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        userInputPanels={parkedPanel(QUESTION_TEXT)}
      />,
    );

    expect(screen.getByText(QUESTION_TEXT)).toBeInTheDocument();
    expect(screen.getByText("Postgres")).toBeInTheDocument();
  });

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

  it("renders no question panel when userInputPanels is null", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        userInputPanels={null}
      />,
    );

    expect(screen.queryByText(QUESTION_TEXT)).not.toBeInTheDocument();
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
    // context-plan's resolved implementer is claude opus.
    const impl = within(tab).getByTestId("config-block-implementer");
    expect(within(impl).getByText("Opus 5")).toBeInTheDocument();
    // Runtime facts render for the selected context.
    expect(within(tab).getByTestId("runtime-isolation")).toHaveTextContent(
      "session",
    );
  });

  it("keeps the Tasks tab as the default detail view", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    // Tasks content is present by default; config is not.
    expect(screen.getByText("Inspect code")).toBeInTheDocument();
    expect(screen.queryByTestId("context-config-tab")).not.toBeInTheDocument();
  });

  it("shows liveRevision and seed definition id@revision in the overview header", () => {
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

  it("renders no charter amendment note when the charter was never amended", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution()}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(
      screen.queryByTestId("overview-charter-amendments"),
    ).not.toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — Config tab editing wiring", () => {
  it("forwards a composed update-context op batch through onSaveContextConfig", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    selectDetailTab("Config");
    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSaveContextConfig).toHaveBeenCalledWith([
      {
        type: "update-context",
        contextId: "context-plan",
        iterationPolicy: { maxIterations: 7, continuity: { enabled: true } },
      },
    ]);
  });

  it("shows a pause-to-edit affordance for a started context on a running execution", () => {
    const onPauseExecution = vi.fn();
    const base = createWorkflowExecution({ status: "running" });
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          status: "ready",
          iterationCount: 1,
        },
      },
    });

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={vi.fn()}
        onPauseExecution={onPauseExecution}
      />,
    );

    selectDetailTab("Config");
    fireEvent.click(screen.getByRole("button", { name: "Pause to edit" }));
    expect(onPauseExecution).toHaveBeenCalledTimes(1);
  });

  it("surfaces the revision-conflict retry notice in the Config tab", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={vi.fn()}
        configEditConflict
      />,
    );

    selectDetailTab("Config");
    expect(screen.getByTestId("config-affordance-conflict")).toHaveTextContent(
      /execution changed/i,
    );
  });
});

describe("ExecutionInspectorPanel — brief markdown + focus modal", () => {
  function makeBriefExecution(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? {
              ...context,
              description: "Plan the **entire** implementation",
              acceptanceCriteria: "1. Criteria uses `deepEqualJson` everywhere",
              humanApprovalGate: { enabled: true },
            }
          : context,
    );
    return createWorkflowExecution({ workingDefinition: definition });
  }

  function renderDetail() {
    return render(
      <ExecutionInspectorPanel
        execution={makeBriefExecution()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );
  }

  function renderScriptSetup(scriptValidator: { commands: string[] }): Element {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? { ...context, scriptValidator }
          : context,
    );
    const { container } = render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution({ workingDefinition: definition })}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );
    const strip = container.querySelector('[data-section="resolved-setup"]');
    expect(strip).not.toBeNull();
    return strip!;
  }

  it("renders description and acceptance criteria as formatted markdown", async () => {
    renderDetail();

    const bold = await screen.findByText("entire", undefined, {
      timeout: 15000,
    });
    expect(bold.closest("strong")).toBeTruthy();
    const code = await screen.findByText("deepEqualJson");
    expect(code.closest("code")).toBeTruthy();
  });

  it("opens the acceptance criteria in a focus modal on click", async () => {
    renderDetail();

    fireEvent.click(
      screen.getByRole("button", { name: /view acceptance criteria/i }),
    );

    const dialog = await screen.findByRole("dialog", {}, { timeout: 15000 });
    expect(within(dialog).getByText("Plan")).toBeInTheDocument();
    const code = await within(dialog).findByText("deepEqualJson");
    expect(code.closest("code")).toBeTruthy();
  });

  it("opens the description in a focus modal on click", async () => {
    renderDetail();

    fireEvent.click(screen.getByRole("button", { name: /view description/i }));

    const dialog = await screen.findByRole("dialog", {}, { timeout: 15000 });
    const bold = await within(dialog).findByText("entire");
    expect(bold.closest("strong")).toBeTruthy();
  });

  it("shows resolved implementer and enabled gate chips for the selected context", () => {
    const { container } = renderDetail();

    const strip = container.querySelector('[data-section="resolved-setup"]');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain("Claude opus · high");
    expect(strip!.textContent).toContain("Approval");
    // Disabled gates render no chip.
    expect(strip!.textContent).not.toContain("Script");
    expect(strip!.textContent).not.toContain("Questions");
  });

  it("shows the Script chip when the command selection is non-empty", () => {
    const strip = renderScriptSetup({
      commands: ["typecheck"],
    });

    expect(strip.textContent).toContain("Script");
  });

  it("hides the Script chip when the command selection is empty", () => {
    const strip = renderScriptSetup({ commands: [] });

    expect(strip.textContent).not.toContain("Script");
  });
});

describe("ExecutionInspectorPanel — output-schema validation card (R3.2)", () => {
  const schemaRejection = makeValidationEvent({
    kind: "output_schema",
    pass: false,
    summary: "Output rejected — 1 of 1 required field failed the contract.",
    sessionRef: conversationValidationRef("conv-1"),
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
  });

  function renderHistory(event: GraphWorkflowValidationResultEvent) {
    const { execution, events } = makeExecutionWithHistory([event]);
    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
        onViewConversation={vi.fn()}
      />,
    );
    selectDetailTab("History");
  }

  it("badges a schema rejection with its kind and drops the lane badge", () => {
    renderHistory(schemaRejection);

    expect(screen.getByText("Output schema")).toBeInTheDocument();
    // The engine produced this verdict, not a validator lane agent.
    expect(screen.queryByText("Context")).not.toBeInTheDocument();
  });

  it("offers no transcript link for a schema rejection", () => {
    renderHistory(schemaRejection);

    expect(
      screen.queryByRole("button", { name: "View Transcript" }),
    ).not.toBeInTheDocument();
  });

  it("renders the instance path as the issue title", () => {
    renderHistory(schemaRejection);

    const title = screen.getByText("/verdict");
    expect(title.tagName).toBe("CODE");
  });

  it("keeps the lane badge and transcript link for an agent-validator failure", () => {
    renderHistory(
      makeValidationEvent({
        pass: false,
        summary: "Root cause not evidenced",
        sessionRef: conversationValidationRef("conv-1"),
        issues: [
          { title: "Missing job reference", description: "Criterion 1" },
        ],
      }),
    );

    expect(screen.getByText("Context")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "View Transcript" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Output schema")).not.toBeInTheDocument();
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

  it("lists the refused instance paths in the context halt card", () => {
    const { execution, events } = outputSchemaHaltFixture();

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      /Output schema not satisfied in context-plan/,
    );
    expect(within(alert).getByText("/verdict")).toBeInTheDocument();
    expect(
      within(alert).getByText(/not one of the allowed values/),
    ).toBeInTheDocument();
  });

  it("lists the refused instance paths on the overview card, which is the first halt surface seen", () => {
    const { execution, events } = outputSchemaHaltFixture();

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("/verdict")).toBeInTheDocument();
    expect(
      within(alert).getByText(/not one of the allowed values/),
    ).toBeInTheDocument();
  });

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

  it("renders a concurrent secondary output-schema failure with its own paths", () => {
    const { execution, events } = outputSchemaHaltFixture();
    const withSecondary: GraphWorkflowExecution = {
      ...execution,
      secondaryHaltReasons: [
        {
          type: "circuit_breaker",
          contextId: "context-build",
          condition: "output_schema_validation",
          failureCount: 2,
          summary: "Output schema not satisfied",
        },
      ],
    };
    const withBuildRejection: GraphWorkflowExecutionEvent[] = [
      ...events,
      {
        occurredAt: "2026-03-27T09:42:00.000Z",
        preReset: false,
        event: makeValidationEvent({
          contextId: "context-build",
          kind: "output_schema",
          pass: false,
          summary: "Output rejected",
          issues: [
            {
              title: "/artifact",
              description: "is required",
              path: "/artifact",
            },
          ],
          rejectedOutput: "{}",
          gateRepairAttempts: null,
          gateRepairBudget: null,
        }),
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={withSecondary}
        events={withBuildRejection}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /1 more failure/ }));
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("/artifact")).toBeInTheDocument();
    expect(within(alert).getByText(/is required/)).toBeInTheDocument();
  });
});

describe("ExecutionInspectorPanel — captured output group", () => {
  const outputSchema = {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
  };

  function withSchema(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan" ? { ...context, outputSchema } : context,
    );
    return createWorkflowExecution({ workingDefinition: definition });
  }

  it("omits the Output group entirely for a context with no declared schema (R7.6)", () => {
    const { container } = render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(container.querySelector('[data-section="output"]')).toBeNull();
  });

  it("renders the pending Output group for a schema-declaring context (R7.6)", () => {
    const { container } = render(
      <ExecutionInspectorPanel
        execution={withSchema()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(container.querySelector('[data-section="output"]')).not.toBeNull();
    expect(screen.getByTestId("captured-output-contract")).toHaveTextContent(
      "object · 1 field · 1 required",
    );
  });

  it("renders the captured payload once the context banks its output (R7.6)", () => {
    const execution = withSchema();
    render(
      <ExecutionInspectorPanel
        execution={{
          ...execution,
          contextOutputs: {
            "context-plan": {
              value: { verdict: "pass" },
              capturedAt: "2026-03-27T14:22:00.000Z",
              iteration: 2,
              parse: { source: "native" },
            },
          },
        }}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("captured-output-status")).toHaveTextContent(
      "Captured",
    );
    expect(screen.getByText('"verdict":')).toBeInTheDocument();
  });

  it("renders the rejected state from the recorded output-schema failure (R3.2)", () => {
    const execution = withSchema();
    const events: GraphWorkflowExecutionEvent[] = [
      {
        occurredAt: "2026-03-27T09:41:00.000Z",
        preReset: false,
        event: makeValidationEvent({
          kind: "output_schema",
          pass: false,
          summary: "Output rejected — 1 issue",
          rejectedOutput: '{ "verdict": "partial" }',
          gateRepairAttempts: null,
          gateRepairBudget: null,
          issues: [{ title: "/verdict", description: "not allowed" }],
        }),
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("captured-output-status")).toHaveTextContent(
      "Rejected",
    );
    expect(screen.getByTestId("captured-output-rejected")).toHaveTextContent(
      '"verdict": "partial"',
    );
  });
});

// R7.8: the execution inspector's rows are EXECUTION-derived — the same
// predecessors the prompt injects, with what each has actually banked.
describe("ExecutionInspectorPanel — upstream inputs", () => {
  const planSchema = {
    type: "object",
    properties: { verdict: { type: "string" }, notes: { type: "string" } },
    required: ["verdict"],
  };

  function executionWithPlanSchema(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? { ...context, outputSchema: planSchema }
          : context,
    );
    return createWorkflowExecution({ workingDefinition: definition });
  }

  it("omits the block for a root context", () => {
    render(
      <ExecutionInspectorPanel
        execution={executionWithPlanSchema()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.queryByTestId("upstream-inputs")).toBeNull();
  });

  it("lists the direct predecessor with its declared fields, still uncaptured", () => {
    render(
      <ExecutionInspectorPanel
        execution={executionWithPlanSchema()}
        events={[]}
        selectedContextId="context-implement"
        {...baseHandlers}
      />,
    );

    const rows = screen.getAllByTestId("upstream-input-row");
    expect(rows.map((row) => row.dataset.contextId)).toEqual(["context-plan"]);
    expect(
      within(rows[0]!)
        .getAllByTestId("upstream-input-field")
        .map((chip) => chip.textContent),
    ).toEqual(["verdict", "notes"]);
    expect(rows[0]!.dataset.captured).toBe("false");
  });

  it("marks the predecessor captured once its output is banked", () => {
    const execution = executionWithPlanSchema();
    render(
      <ExecutionInspectorPanel
        execution={{
          ...execution,
          contextOutputs: {
            "context-plan": {
              value: { verdict: "pass", notes: "none" },
              capturedAt: "2026-03-27T14:22:00.000Z",
              iteration: 1,
              parse: { source: "native" },
            },
          },
        }}
        events={[]}
        selectedContextId="context-implement"
        {...baseHandlers}
      />,
    );

    expect(
      screen.getAllByTestId("upstream-input-row")[0]!.dataset.captured,
    ).toBe("true");
  });

  it("keeps a schema-less predecessor listed as prose-only", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution()}
        events={[]}
        selectedContextId="context-implement"
        {...baseHandlers}
      />,
    );

    const rows = screen.getAllByTestId("upstream-input-row");
    expect(rows.map((row) => row.dataset.contextId)).toEqual(["context-plan"]);
    expect(rows[0]!.dataset.declared).toBe("false");
    expect(within(rows[0]!).getByTestId("upstream-input-prose")).toBeTruthy();
  });
});

// R12.3: the execution inspector's per-assignment display. A cohort round is
// the only surface on which "who reviewed this, on which bytes, and did the
// tree move" is answerable, so every assertion here reads the frozen round
// record and the aggregate result — never the live library or a colour.
describe("ExecutionInspectorPanel — per-assignment cohort inspector (R12.3)", () => {
  const GENERAL_HASH = `sha256:${"b".repeat(64)}`;
  const SECURITY_HASH = `sha256:${"c".repeat(64)}`;

  function cohortAssignments(): SeededValidatorAssignment[] {
    return [
      seedAssignment(
        makeValidatorAssignment({
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
        }),
        { name: "General Reviewer", resolvedInstructionHash: GENERAL_HASH },
      ),
      seedAssignment(
        makeValidatorAssignment({
          id: "security",
          profile: { tier: "project", id: "security-reviewer" },
          strategy: "task",
          agent: {
            backend: "codex",
            model: "gpt-5.6-sol",
            reasoningEffort: "high",
          },
        }),
        {
          name: "Security Reviewer",
          revision: 4,
          resolvedInstructionHash: SECURITY_HASH,
        },
      ),
    ];
  }

  function makeRound(
    overrides: Partial<GraphWorkflowValidationRound> = {},
  ): GraphWorkflowValidationRound {
    return {
      seq: 2,
      candidate: {
        identityScope: "wholeTree",
        headSha: "head-sha-1",
        candidateTreeHash: "tree-hash-1",
        taskStateHash: "task-hash-1",
      },
      roster: [
        {
          assignmentId: "general",
          profileRef: { tier: "builtin", id: "general-reviewer" },
          revision: 1,
          resolvedInstructionHash: GENERAL_HASH,
          strategy: "conversation",
        },
        {
          assignmentId: "security",
          profileRef: { tier: "project", id: "security-reviewer" },
          revision: 4,
          resolvedInstructionHash: SECURITY_HASH,
          strategy: "task",
        },
      ],
      specialists: {
        general: {
          state: "verdict_pass",
          attempts: 1,
          summary: "No blocking findings.",
          issues: [],
          advisories: [],
          questionToken: null,
          sessionRef: {
            backend: "claude",
            ref: "conv-general",
            lane: "context_validator",
            assignmentId: "general",
            refKind: "conversation",
            workflowConversationId: "conv-general",
          },
          reviewArtifact: null,
          lastInfraFailure: null,
        },
        security: {
          state: "infra_failed",
          attempts: 2,
          summary: null,
          issues: [],
          advisories: [],
          questionToken: null,
          sessionRef: null,
          reviewArtifact: null,
          lastInfraFailure: {
            reason: "unparseable",
            message: "Validator returned no parseable verdict",
            engine: "codex",
          },
        },
      },
      phase: "specialists",
      outcome: null,
      startedAt: "2026-03-27T10:00:00.000Z",
      ...overrides,
    };
  }

  function cohortExecution(
    round: GraphWorkflowValidationRound | null,
  ): GraphWorkflowExecution {
    const base = createResolvedWorkflowDefinition();
    const execution = createWorkflowExecution({
      status: "running",
      workingDefinition: {
        ...base,
        executionContexts: base.executionContexts.map((ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                implementer: seedAssignment(
                  makeImplementerAssignment({
                    backend: "claude",
                    model: "opus",
                    reasoningEffort: "high",
                  }),
                  { name: "General Implementer", revision: 3 },
                ),
                contextValidator: {
                  enabled: true,
                  assignments: cohortAssignments(),
                },
              }
            : ctx,
        ),
      },
    });
    const planState = execution.contextStates["context-plan"];
    if (!planState) throw new Error("fixture is missing context-plan state");
    return {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...planState,
          validationRound: round,
        },
      },
    };
  }

  function incidentEvent(
    overrides: Partial<GraphWorkflowValidationIncidentEvent> = {},
  ): GraphWorkflowExecutionEvent {
    return {
      occurredAt: "2026-03-27T10:05:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-incident",
        projectName: "project",
        sessionName: "session-1",
        executionId: "execution-1",
        contextId: "context-plan",
        incident: "infra_failure",
        roundSeq: 2,
        stage: "specialist_result",
        assignmentId: "security",
        attempts: 2,
        driftedComponents: "",
        message: "Validator returned no parseable verdict",
        ...overrides,
      },
    };
  }

  it("shows the implementer assignment's profile identity and revision on the context", () => {
    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(makeRound())}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("setup-implementer-profile")).toHaveTextContent(
      "builtin:general-implementer@3",
    );
  });

  it("lists each roster seat with its frozen profile identity, revision and lane status", () => {
    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(makeRound())}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");

    const rows = screen.getAllByTestId("cohort-member");
    expect(rows.map((row) => row.dataset.assignmentId)).toEqual([
      "general",
      "security",
    ]);

    expect(
      within(rows[0]!).getByTestId("cohort-member-profile"),
    ).toHaveTextContent("builtin:general-reviewer@1");
    expect(
      within(rows[0]!).getByTestId("cohort-member-state"),
    ).toHaveTextContent("Passed");

    expect(
      within(rows[1]!).getByTestId("cohort-member-profile"),
    ).toHaveTextContent("project:security-reviewer@4");
    expect(
      within(rows[1]!).getByTestId("cohort-member-state"),
    ).toHaveTextContent("Infrastructure failure");
  });

  it("separates an infrastructure lane outcome from a semantic verdict in the round record", () => {
    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(makeRound())}
        events={[incidentEvent()]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");

    const rows = screen.getAllByTestId("cohort-member");
    expect(rows[0]!.dataset.outcomeKind).toBe("semantic");
    expect(rows[1]!.dataset.outcomeKind).toBe("infrastructure");
    // Not a verdict: the reason is spelled out, so the distinction survives
    // without reading the tone.
    expect(rows[1]!).toHaveTextContent(
      "Validator returned no parseable verdict",
    );
    expect(rows[1]!).toHaveTextContent("2 attempts");

    const incident = screen.getByTestId("cohort-incident");
    expect(incident.dataset.incident).toBe("infra_failure");
    expect(incident).toHaveTextContent("Infrastructure");
  });

  it("labels the round's deterministic aggregate outcome", () => {
    const { rerender } = render(
      <ExecutionInspectorPanel
        execution={cohortExecution(
          makeRound({ phase: "concluded", outcome: "failed" }),
        )}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    const aggregate = screen.getByTestId("cohort-round-aggregate");
    expect(aggregate).toHaveTextContent("Cohort rejected");
    expect(aggregate.dataset.outcomeKind).toBe("semantic");

    rerender(
      <ExecutionInspectorPanel
        execution={cohortExecution(
          makeRound({ phase: "concluded", outcome: "candidate_mismatch" }),
        )}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    const infra = screen.getByTestId("cohort-round-aggregate");
    expect(infra).toHaveTextContent("Candidate changed under the cohort");
    expect(infra.dataset.outcomeKind).toBe("infrastructure");
  });

  it("omits the round section entirely for a context that has never had one", () => {
    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(null)}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    expect(screen.queryByTestId("cohort-round")).not.toBeInTheDocument();
  });

  it("opens one cohort member's lane conversation with an assignment-labeled header", () => {
    const onViewConversation = vi.fn();
    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(makeRound())}
        events={[]}
        selectedContextId="context-plan"
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    const rows = screen.getAllByTestId("cohort-member");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /view transcript/i }),
    );

    expect(onViewConversation).toHaveBeenCalledWith(
      "conv-general",
      "context_validator",
      "context-plan",
      "Validator · general",
    );
  });

  it("groups per-assignment verdicts and artifacts under one aggregate round result", async () => {
    const { execution } = makeExecutionWithHistory([]);
    void execution;
    const events: GraphWorkflowExecutionEvent[] = [
      {
        occurredAt: "2026-03-27T10:10:00.000Z",
        preReset: false,
        event: makeValidationEvent({
          pass: false,
          summary: "The cohort rejected the work",
          reopenTaskIds: ["task-plan-1"],
          roundSeq: 2,
          sessionRef: null,
          reviewArtifact: null,
          specialists: [
            {
              assignmentId: "general",
              profile: {
                tier: "builtin",
                id: "general-reviewer",
                revision: 1,
              },
              resolvedInstructionHash: GENERAL_HASH,
              advisories: [],
              pass: true,
              summary: "Implementation matches the criteria.",
              issues: [],
              sessionRef: {
                backend: "claude",
                ref: "conv-general",
                lane: "context_validator",
                assignmentId: "general",
                refKind: "conversation",
                workflowConversationId: "conv-general",
              },
              reviewArtifact: null,
              usage: null,
            },
            {
              assignmentId: "security",
              profile: {
                tier: "project",
                id: "security-reviewer",
                revision: 4,
              },
              resolvedInstructionHash: SECURITY_HASH,
              advisories: [],
              pass: false,
              summary: "Secret is logged in plaintext.",
              issues: [
                {
                  taskId: "task-plan-1",
                  title: "Plaintext secret",
                  description: "`token` is written to the log line.",
                },
              ],
              sessionRef: responseValidationRef("thread-security"),
              reviewArtifact: responseReviewArtifact(
                "thread-security",
                "Reviewed the auth path.",
              ),
              usage: null,
            },
          ],
        }),
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(makeRound())}
        events={events}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");

    // ONE aggregate card, carrying the deterministic round verdict.
    const aggregates = screen.getAllByTestId("validation-aggregate");
    expect(aggregates).toHaveLength(1);
    const aggregate = aggregates[0]!;
    expect(aggregate).toHaveTextContent("The cohort rejected the work");
    expect(aggregate).toHaveTextContent("Round 2");

    // …with one card per assignment nested inside it.
    const specialists = within(aggregate).getAllByTestId(
      "validation-specialist",
    );
    expect(specialists.map((card) => card.dataset.assignmentId)).toEqual([
      "general",
      "security",
    ]);
    expect(
      within(specialists[0]!).getByTestId("validation-specialist-profile"),
    ).toHaveTextContent("builtin:general-reviewer@1");
    expect(specialists[0]!.dataset.verdict).toBe("pass");
    expect(specialists[1]!.dataset.verdict).toBe("fail");
    expect(specialists[1]!).toHaveTextContent("Secret is logged in plaintext.");
    expect(specialists[1]!).toHaveTextContent("Issues (1)");
    // The failing member's own artifact renders under its own card. The
    // canonical Markdown adapter is loaded lazily, so the card is re-queried on
    // each poll rather than held across the mount.
    await waitFor(
      () => {
        const securityCard = screen.getAllByTestId("validation-specialist")[1];
        expect(securityCard).toBeDefined();
        expect(
          within(securityCard!).getByText("Reviewed the auth path.", {
            exact: false,
          }),
        ).toBeTruthy();
      },
      { timeout: 15000 },
    );
  });

  it("routes each specialist's transcript link to that assignment's lane", () => {
    const onViewConversation = vi.fn();
    const events: GraphWorkflowExecutionEvent[] = [
      {
        occurredAt: "2026-03-27T10:10:00.000Z",
        preReset: false,
        event: makeValidationEvent({
          pass: false,
          summary: "Cohort verdict",
          roundSeq: 2,
          sessionRef: null,
          reviewArtifact: null,
          specialists: [
            {
              assignmentId: "security",
              profile: {
                tier: "project",
                id: "security-reviewer",
                revision: 4,
              },
              resolvedInstructionHash: SECURITY_HASH,
              advisories: [],
              pass: false,
              summary: "No.",
              issues: [],
              sessionRef: {
                backend: "claude",
                ref: "conv-security",
                lane: "context_validator",
                assignmentId: "security",
                refKind: "conversation",
                workflowConversationId: "conv-security",
              },
              reviewArtifact: null,
              usage: null,
            },
          ],
        }),
      },
    ];

    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(null)}
        events={events}
        selectedContextId="context-plan"
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    const specialist = screen.getByTestId("validation-specialist");
    fireEvent.click(
      within(specialist).getByRole("button", { name: /view transcript/i }),
    );

    expect(onViewConversation).toHaveBeenCalledWith(
      "conv-security",
      "context_validator",
      "context-plan",
      "Validator · security",
    );
  });

  // The production shape a rejecting cohort actually publishes: `concludeCohort`
  // concatenates every failing lane's findings onto the aggregate AND
  // `buildSpecialistEntries` carries each lane's own copy, both stamped with the
  // raising assignment. A card that renders both lists shows every finding
  // twice, and the aggregate copy carries no visible attribution.
  function cohortRejectionEvent(
    issueOverrides: {
      aggregateExtras?: GraphWorkflowValidationResultEvent["issues"];
    } = {},
  ): GraphWorkflowExecutionEvent {
    const securityFindings = [
      {
        taskId: "task-plan-1",
        title: "Plaintext secret",
        description: "`token` is written to the log line.",
        assignmentId: "security",
      },
      {
        taskId: "task-plan-1",
        title: "Unbounded retry",
        description: "The auth retry loop has no ceiling.",
        assignmentId: "security",
      },
    ];
    const docsFindings = [
      {
        taskId: "task-plan-1",
        title: "Undocumented route",
        description: "`POST /login` is missing from the route table.",
        assignmentId: "docs",
      },
    ];

    return {
      occurredAt: "2026-03-27T10:10:00.000Z",
      preReset: false,
      event: makeValidationEvent({
        pass: false,
        summary: "The cohort rejected the work",
        reopenTaskIds: ["task-plan-1"],
        roundSeq: 2,
        sessionRef: null,
        reviewArtifact: null,
        // Contiguous, in cohort order — exactly what concludeCohort builds.
        issues: [
          ...securityFindings,
          ...docsFindings,
          ...(issueOverrides.aggregateExtras ?? []),
        ],
        specialists: [
          {
            assignmentId: "security",
            profile: { tier: "project", id: "security-reviewer", revision: 4 },
            resolvedInstructionHash: SECURITY_HASH,
            advisories: [],
            pass: false,
            summary: "Secret is logged in plaintext.",
            issues: securityFindings,
            sessionRef: {
              backend: "claude",
              ref: "conv-security",
              lane: "context_validator",
              assignmentId: "security",
              refKind: "conversation",
              workflowConversationId: "conv-security",
            },
            reviewArtifact: null,
            usage: null,
          },
          {
            assignmentId: "docs",
            profile: { tier: "global", id: "docs-reviewer", revision: 2 },
            resolvedInstructionHash: GENERAL_HASH,
            advisories: [],
            pass: false,
            summary: "The route docs are stale.",
            issues: docsFindings,
            sessionRef: null,
            reviewArtifact: null,
            usage: null,
          },
        ],
      }),
    };
  }

  it("renders each cohort finding once, inside the assignment that raised it", () => {
    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(null)}
        events={[cohortRejectionEvent()]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");

    // No duplicate copies: every finding appears exactly once on the card.
    for (const title of [
      "Plaintext secret",
      "Unbounded retry",
      "Undocumented route",
    ]) {
      expect(screen.getAllByText(title)).toHaveLength(1);
    }

    // …and each one sits inside the assignment group that raised it.
    const cards = screen.getAllByTestId("validation-specialist");
    const security = cards.find(
      (card) => card.dataset.assignmentId === "security",
    );
    const docs = cards.find((card) => card.dataset.assignmentId === "docs");
    expect(within(security!).getByText("Plaintext secret")).toBeInTheDocument();
    expect(within(security!).getByText("Unbounded retry")).toBeInTheDocument();
    expect(within(docs!).getByText("Undocumented route")).toBeInTheDocument();

    // The unattributed aggregate list is gone: every finding was attributed.
    expect(
      screen.queryByTestId("validation-aggregate-issues"),
    ).not.toBeInTheDocument();
  });

  it("keeps a finding no listed assignment raised visible on the aggregate", () => {
    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(null)}
        events={[
          cohortRejectionEvent({
            aggregateExtras: [
              {
                taskId: "task-plan-1",
                title: "Round-level objection",
                description: "Raised by nobody the round can name.",
              },
              {
                taskId: "task-plan-1",
                title: "Orphaned finding",
                description: "Its seat produced no publishable entry.",
                assignmentId: "dropped-seat",
              },
            ],
          }),
        ]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");

    // Suppression is by attribution, not by "a cohort was present": a finding
    // that names no listed assignment would otherwise vanish entirely.
    const unattributed = screen.getByTestId("validation-aggregate-issues");
    expect(unattributed).toHaveTextContent("Unattributed Issues (2)");
    expect(
      within(unattributed).getByText("Round-level objection"),
    ).toBeInTheDocument();
    expect(
      within(unattributed).queryByText("Plaintext secret"),
    ).not.toBeInTheDocument();

    // A finding whose raiser produced no entry has no group to sit in, so it
    // carries its attribution inline rather than reading as anonymous.
    const orphan = within(unattributed)
      .getByText("Orphaned finding")
      .closest("li");
    expect(orphan).not.toBeNull();
    expect(orphan!).toHaveTextContent("dropped-seat");
  });

  it("leaves a single-reviewer result's issue list exactly as it was", () => {
    render(
      <ExecutionInspectorPanel
        execution={cohortExecution(null)}
        events={[
          {
            occurredAt: "2026-03-27T10:10:00.000Z",
            preReset: false,
            event: makeValidationEvent({
              pass: false,
              summary: "One reviewer rejected the work",
              issues: [
                {
                  taskId: "task-plan-1",
                  title: "Missing coverage",
                  description: "No test for the new branch.",
                },
              ],
              sessionRef: conversationValidationRef("conv-solo"),
            }),
          },
        ]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");

    const issues = screen.getByTestId("validation-aggregate-issues");
    expect(issues).toHaveTextContent("Issues (1)");
    expect(issues).not.toHaveTextContent("Unattributed");
    expect(within(issues).getByText("Missing coverage")).toBeInTheDocument();
  });
});

// ============================================================
// D4 read surfaces (R13.1)
// ============================================================

function guardedExecution(): GraphWorkflowExecution {
  const definition = createResolvedWorkflowDefinition();
  definition.executionContexts = definition.executionContexts.map((context) =>
    context.id === "context-plan"
      ? {
          ...context,
          outputSchema: {
            type: "object",
            properties: { verdict: { type: "string" } },
          },
        }
      : context,
  );
  definition.edges = definition.edges.map((edge) =>
    edge.id === "edge-plan-implement"
      ? {
          ...edge,
          when: { schema: { properties: { verdict: { const: "broken" } } } },
        }
      : edge,
  );
  return createWorkflowExecution({ workingDefinition: definition });
}

describe("ExecutionInspectorPanel — routing section (R13.1)", () => {
  it("renders no routing section for a context with no guarded route", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution()}
        events={[]}
        selectedContextId="context-implement"
        {...baseHandlers}
      />,
    );

    expect(screen.queryByTestId("context-routing")).toBeNull();
  });

  it("lists each incoming guard with its resolution", () => {
    const execution = guardedExecution();
    render(
      <ExecutionInspectorPanel
        execution={{
          ...execution,
          contextStates: {
            ...execution.contextStates,
            "context-plan": {
              ...execution.contextStates["context-plan"]!,
              status: "completed",
            },
          },
          contextOutputs: {
            "context-plan": {
              value: { verdict: "broken" },
              capturedAt: "2026-03-27T14:22:00.000Z",
              iteration: 1,
              parse: { source: "native" },
            },
          },
        }}
        events={[]}
        selectedContextId="context-implement"
        {...baseHandlers}
      />,
    );

    const rows = screen.getAllByTestId("context-route-row");
    expect(rows.map((row) => row.dataset.edgeId)).toEqual([
      "edge-plan-implement",
    ]);
    expect(rows[0]!.dataset.guard).toBe("schema");
    expect(rows[0]!.dataset.resolution).toBe("active");
    expect(rows[0]!).toHaveTextContent("context-plan");
  });

  it("badges a skipped context as Skipped rather than Pending", () => {
    const execution = guardedExecution();
    render(
      <ExecutionInspectorPanel
        execution={{
          ...execution,
          contextStates: {
            ...execution.contextStates,
            "context-implement": {
              ...execution.contextStates["context-implement"]!,
              status: "skipped",
              skipReason: {
                at: "2026-03-27T14:30:00.000Z",
                edgeEvaluations: [
                  { edgeId: "edge-plan-implement", verdict: "inactive" },
                ],
              },
            },
          },
        }}
        events={[]}
        selectedContextId="context-implement"
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Skipped")).toBeTruthy();
  });

  it("renders the recorded skip reason of a skipped context", () => {
    const execution = guardedExecution();
    render(
      <ExecutionInspectorPanel
        execution={{
          ...execution,
          contextStates: {
            ...execution.contextStates,
            "context-implement": {
              ...execution.contextStates["context-implement"]!,
              status: "skipped",
              skipReason: {
                at: "2026-03-27T14:30:00.000Z",
                edgeEvaluations: [
                  { edgeId: "edge-plan-implement", verdict: "inactive" },
                ],
              },
            },
          },
        }}
        events={[]}
        selectedContextId="context-implement"
        {...baseHandlers}
      />,
    );

    const skip = screen.getByTestId("context-skip-reason");
    expect(skip).toHaveTextContent(/branch not taken/i);
    expect(skip).toHaveTextContent("edge-plan-implement");
    expect(skip).toHaveTextContent("inactive");
  });
});

describe("ExecutionInspectorPanel — loop pass section (R13.1)", () => {
  function loopExecution(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition();
    const body = definition.executionContexts.filter(
      (context) => context.id !== "context-plan",
    );
    definition.executionContexts = [
      definition.executionContexts[0]!,
      ...body.map((context) => ({
        ...context,
        id: `loop-a__p2__${context.id}`,
      })),
    ];
    definition.tasks = [];
    definition.edges = [];
    definition.loopGroups = [
      {
        id: "loop-a",
        entryContextId: "context-implement",
        exitContextId: "context-verify",
        until: { schema: { properties: { done: { const: true } } } },
        maxPasses: 4,
        templateVersion: 2,
        template: { contexts: body, tasks: [], edges: [] },
        planRepair: { enabled: false, maxAttemptsPerContext: 0 },
      },
    ];
    return createWorkflowExecution({
      workingDefinition: definition,
      loopStates: {
        "loop-a": {
          loopGroupId: "loop-a",
          activation: "running",
          loopControlRevision: 1,
          passCount: 2,
          slotLedger: [],
          boundaryInputs: null,
          decisions: {},
          passTemplateVersions: { "1": 1, "2": 2 },
          concludingExitContextId: null,
          activatedAt: "2026-03-27T14:00:00.000Z",
          settledAt: null,
        },
      },
    });
  }

  it("reports the pass, budget and template version of a pass instance", () => {
    render(
      <ExecutionInspectorPanel
        execution={loopExecution()}
        events={[]}
        selectedContextId="loop-a__p2__context-implement"
        {...baseHandlers}
      />,
    );

    const section = screen.getByTestId("context-loop");
    expect(section).toHaveTextContent("loop-a");
    expect(section).toHaveTextContent("Pass 2 of 4");
    expect(section).toHaveTextContent(/running/i);
    expect(section).toHaveTextContent("template v2");
    expect(section).toHaveTextContent("context-implement");
  });

  it("renders no loop section for a context outside every loop", () => {
    render(
      <ExecutionInspectorPanel
        execution={loopExecution()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.queryByTestId("context-loop")).toBeNull();
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

  it("shows no provenance section on an authored context", () => {
    render(
      <ExecutionInspectorPanel
        execution={expandedExecution()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.queryByTestId("context-provenance")).toBeNull();
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

    const accepted = screen.getAllByTestId("expansion-accepted-row");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!).toHaveTextContent("Fan out three candidate designs");
    expect(accepted[0]!).toHaveTextContent("context-implement");

    const refusals = screen.getAllByTestId("expansion-refusal-row");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!).toHaveTextContent("expansion-context-cap-exceeded");
  });

  it("renders no expansion section for an execution that never expanded", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution()}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.queryByTestId("expansion-ledger")).toBeNull();
  });
});

describe("ExecutionInspectorPanel — advisories in the round history (R9.2/R9.3/R9.5)", () => {
  function advisoryExecution(): GraphWorkflowExecution {
    const base = createResolvedWorkflowDefinition();
    const execution = createWorkflowExecution({
      status: "running",
      workingDefinition: {
        ...base,
        executionContexts: base.executionContexts.map((ctx) =>
          ctx.id === "context-plan"
            ? {
                ...ctx,
                contextValidator: {
                  enabled: true,
                  assignments: [
                    seedAssignment(
                      makeValidatorAssignment({
                        id: "acceptance-criteria",
                        authority: "blocking",
                      }),
                    ),
                    seedAssignment(
                      makeValidatorAssignment({
                        id: "security",
                        profile: { tier: "project", id: "security-reviewer" },
                        authority: "advisory",
                      }),
                    ),
                  ],
                },
              }
            : ctx,
        ),
      },
    });
    const planState = execution.contextStates["context-plan"];
    if (!planState) throw new Error("fixture is missing context-plan state");
    return {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...planState,
          validationRound: {
            seq: 2,
            candidate: {
              identityScope: "wholeTree",
              headSha: "head-1",
              candidateTreeHash: "tree-hash-1",
              taskStateHash: "tasks-1",
            },
            roster: [
              {
                assignmentId: "acceptance-criteria",
                profileRef: { tier: "builtin", id: "general-reviewer" },
                revision: 1,
                resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
                strategy: "conversation",
              },
              {
                assignmentId: "security",
                profileRef: { tier: "project", id: "security-reviewer" },
                revision: 4,
                resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
                strategy: "conversation",
              },
            ],
            specialists: {
              "acceptance-criteria": {
                state: "verdict_pass",
                attempts: 1,
                summary: "Every criterion is met.",
                issues: [],
                advisories: [],
                questionToken: null,
                sessionRef: null,
                reviewArtifact: null,
                lastInfraFailure: null,
              },
              security: {
                state: "verdict_pass",
                attempts: 1,
                summary: "Nothing blocking.",
                issues: [],
                advisories: [
                  {
                    kind: "plan",
                    title: "The plan skips the backfill",
                    description: "Nothing writes the historic rows.",
                    identity: {
                      roundSeq: 2,
                      assignmentId: "security",
                      ordinal: 1,
                    },
                    deliveredAt: "2026-03-27T10:05:00.000Z",
                    disposition: {
                      outcome: "declined",
                      reason: "The backfill is a separate approved task.",
                      recordedAt: "2026-03-27T10:20:00.000Z",
                    },
                  },
                ],
                questionToken: null,
                sessionRef: null,
                reviewArtifact: null,
                lastInfraFailure: null,
              },
            },
            phase: "concluded",
            outcome: "passed",
            startedAt: "2026-03-27T10:00:00.000Z",
          },
          advisoryResponse: {
            roundSeq: 2,
            phase: "awaiting_response",
            enteredAt: "2026-03-27T10:10:00.000Z",
          },
        },
      },
    };
  }

  it("renders the advisory, its authority badges and its disposition on the history tab", () => {
    render(
      <ExecutionInspectorPanel
        execution={advisoryExecution()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );
    selectDetailTab(/history/i);

    const rows = screen.getAllByTestId("cohort-member");
    expect(rows.map((row) => row.getAttribute("data-authority"))).toEqual([
      "blocking",
      "advisory",
    ]);

    const advisory = within(rows[1]!).getByTestId("cohort-advisory");
    expect(
      within(advisory).getByTestId("cohort-advisory-kind"),
    ).toHaveTextContent("Plan");
    expect(
      within(advisory).getByTestId("cohort-advisory-disposition"),
    ).toHaveAttribute("data-disposition", "declined");
    expect(
      screen.getByText("The backfill is a separate approved task."),
    ).toBeInTheDocument();
  });

  /**
   * The round-2 aggregate as the engine publishes it: the specialist entries
   * carry the advisories that lane raised, and no disposition, because the
   * publication goes out when the round settles — before the advisory-response
   * turn that produces one.
   */
  function roundTwoAggregate(): GraphWorkflowExecutionEvent {
    return {
      occurredAt: "2026-03-27T10:06:00.000Z",
      preReset: false,
      event: makeValidationEvent({
        roundSeq: 2,
        pass: true,
        summary: "The cohort passed",
        specialists: [
          {
            assignmentId: "acceptance-criteria",
            profile: { tier: "builtin", id: "general-reviewer", revision: 1 },
            resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
            pass: true,
            summary: "Every criterion is met.",
            issues: [],
            advisories: [],
            sessionRef: null,
            reviewArtifact: null,
            usage: null,
          },
          {
            assignmentId: "security",
            profile: { tier: "project", id: "security-reviewer", revision: 4 },
            resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
            pass: true,
            summary: "Nothing blocking.",
            issues: [],
            advisories: [
              {
                kind: "plan",
                title: "The plan skips the backfill",
                description: "Nothing writes the historic rows.",
                identity: {
                  roundSeq: 2,
                  assignmentId: "security",
                  ordinal: 1,
                },
                deliveredAt: null,
                disposition: null,
              },
            ],
            sessionRef: null,
            reviewArtifact: null,
            usage: null,
          },
        ],
      }),
    };
  }

  it("shows an advisory's disposition once and only from the round record (R9.3)", () => {
    render(
      <ExecutionInspectorPanel
        execution={advisoryExecution()}
        events={[roundTwoAggregate()]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );
    selectDetailTab(/history/i);

    // The event's copy of this advisory was published before the response turn
    // recorded the decline, so rendering it would put a second, contradicting
    // "No disposition" copy of the same advisory on the same tab.
    const advisories = screen.getAllByTestId("cohort-advisory");
    expect(advisories).toHaveLength(1);
    expect(
      within(advisories[0]!).getByTestId("cohort-advisory-disposition"),
    ).toHaveAttribute("data-disposition", "declined");
    expect(screen.queryByText("No disposition")).toBeNull();
  });

  it("carries a tone-coded authority badge on every specialist row, live round or not (R9.5)", () => {
    render(
      <ExecutionInspectorPanel
        execution={advisoryExecution()}
        events={[roundTwoAggregate()]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );
    selectDetailTab(/history/i);

    // The rows of a round read off its validation-result event answer the
    // authority question the same way the live round's roster rows do.
    const historicalRows = screen.getAllByTestId("validation-specialist");
    expect(
      historicalRows.map((row) => row.getAttribute("data-authority")),
    ).toEqual(["blocking", "advisory"]);
    const badges = historicalRows.map((row) =>
      within(row).getByTestId("cohort-member-authority"),
    );
    expect(
      badges.map((badge) => [
        badge.textContent,
        badge.getAttribute("data-tone"),
      ]),
    ).toEqual([
      ["Blocking", "amber"],
      ["Advisory", "neutral"],
    ]);
    // Never the failure tone: authority is not a verdict.
    for (const badge of badges) {
      expect(badge).not.toHaveAttribute("data-tone", "red");
    }
  });

  it("badges a seat the live cohort no longer holds as unknown rather than advisory (R9.5)", () => {
    const execution = advisoryExecution();
    const base = execution.workingDefinition;
    render(
      <ExecutionInspectorPanel
        execution={{
          ...execution,
          workingDefinition: {
            ...base,
            executionContexts: base.executionContexts.map((ctx) =>
              ctx.id === "context-plan"
                ? {
                    ...ctx,
                    contextValidator: { enabled: true, assignments: [] },
                  }
                : ctx,
            ),
          },
        }}
        events={[roundTwoAggregate()]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );
    selectDetailTab(/history/i);

    // Claiming "Advisory" would tell the reader this seat could never have
    // failed the context — which nothing in the record supports.
    const rows = screen.getAllByTestId("validation-specialist");
    expect(rows.map((row) => row.getAttribute("data-authority"))).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(
      within(rows[0]!).getByTestId("cohort-member-authority"),
    ).toHaveTextContent("Authority unknown");
  });

  it("shows the advisory-response step on the round timeline", () => {
    render(
      <ExecutionInspectorPanel
        execution={advisoryExecution()}
        events={[]}
        selectedContextId="context-plan"
        {...baseHandlers}
      />,
    );
    selectDetailTab(/history/i);

    const steps = screen.getAllByTestId("cohort-round-step");
    expect(steps[steps.length - 1]).toHaveAttribute(
      "data-step",
      "advisory_response",
    );
    expect(steps[steps.length - 1]).toHaveAttribute("data-state", "current");
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

  it("aggregates every long-lived advisory on the overview, no round opened", () => {
    render(
      <ExecutionInspectorPanel
        execution={indexedExecution()}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    const entries = screen.getAllByTestId("advisory-index-entry");
    expect(entries).toHaveLength(2);
    // Two different contexts and two different rounds, in one list.
    expect(entries.map((el) => el.getAttribute("data-context-id"))).toEqual([
      "context-plan",
      "context-implement",
    ]);
    expect(
      within(entries[0]!).getByTestId("advisory-index-origin"),
    ).toHaveTextContent("Plan · Round 2 · security");
    expect(
      within(entries[1]!).getByTestId("advisory-index-origin"),
    ).toHaveTextContent("Implement · Round 1 · general");
  });

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

    fireEvent.click(
      within(screen.getAllByTestId("advisory-index-entry")[1]!).getByTestId(
        "advisory-index-origin",
      ),
    );

    expect(onOpenAdvisoryOrigin).toHaveBeenCalledWith({
      contextId: "context-implement",
      roundSeq: 1,
    });
  });

  it("renders no advisory section for a run that raised none", () => {
    render(
      <ExecutionInspectorPanel
        execution={createWorkflowExecution()}
        events={[]}
        selectedContextId={null}
        {...baseHandlers}
      />,
    );

    expect(screen.queryByTestId("advisory-index")).toBeNull();
  });
});

describe("ExecutionInspectorPanel — an origin link reaches the originating round (R9.4)", () => {
  // jsdom has no layout, so it does not implement the scroll the deep link
  // performs on its way to the round.
  Element.prototype.scrollIntoView = () => {};

  const SECURITY_HASH = `sha256:${"c".repeat(64)}`;

  // As the engine publishes it: the aggregate goes out when the round settles,
  // which is before any advisory-response turn can record a disposition.
  const roundOneAdvisory = {
    kind: "plan" as const,
    title: "The plan skips the backfill",
    description: "Nothing writes the historic rows.",
    identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
    deliveredAt: null,
    disposition: null,
  };

  function securityEntry(
    advisories: (typeof roundOneAdvisory)[],
  ): NonNullable<GraphWorkflowValidationResultEvent["specialists"]>[number] {
    return {
      assignmentId: "security",
      profile: { tier: "project", id: "security-reviewer", revision: 4 },
      resolvedInstructionHash: SECURITY_HASH,
      pass: true,
      summary: "Nothing blocking.",
      issues: [],
      advisories,
      sessionRef: null,
      reviewArtifact: null,
      usage: null,
    };
  }

  /**
   * A context that has moved on: round 1 raised the advisory, rounds 2 and 3
   * followed, and round 3 is the one the context state still holds. This is the
   * shape that tells a link to the ORIGIN apart from a link to "the tab".
   */
  function advancedContext(): {
    execution: GraphWorkflowExecution;
    events: GraphWorkflowExecutionEvent[];
  } {
    const base = createWorkflowExecution();
    const planState = base.contextStates["context-plan"];
    if (!planState) throw new Error("fixture is missing context-plan state");
    const liveRound: GraphWorkflowValidationRound = {
      seq: 3,
      candidate: {
        identityScope: "wholeTree",
        headSha: "head-3",
        candidateTreeHash: "tree-hash-3",
        taskStateHash: "tasks-3",
      },
      roster: [
        {
          assignmentId: "security",
          profileRef: { tier: "project", id: "security-reviewer" },
          revision: 4,
          resolvedInstructionHash: SECURITY_HASH,
          strategy: "conversation",
        },
      ],
      specialists: {
        security: {
          state: "verdict_pass",
          attempts: 1,
          summary: "Still nothing blocking.",
          issues: [],
          advisories: [],
          questionToken: null,
          sessionRef: null,
          reviewArtifact: null,
          lastInfraFailure: null,
        },
      },
      phase: "concluded",
      outcome: "passed",
      startedAt: "2026-03-27T12:00:00.000Z",
    };
    return {
      execution: {
        ...base,
        advisoryIndex: [
          {
            identity: roundOneAdvisory.identity,
            kind: "plan",
            title: roundOneAdvisory.title,
            contextId: "context-plan",
          },
        ],
        contextStates: {
          ...base.contextStates,
          "context-plan": { ...planState, validationRound: liveRound },
        },
      },
      events: [1, 2, 3].map((seq) => ({
        occurredAt: `2026-03-27T1${seq}:00:00.000Z`,
        preReset: false,
        event: makeValidationEvent({
          roundSeq: seq,
          summary: `Round ${seq} concluded`,
          specialists: [securityEntry(seq === 1 ? [roundOneAdvisory] : [])],
        }),
      })),
    };
  }

  function renderAtRound(roundSeq: number) {
    const { execution, events } = advancedContext();
    return render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        contextTabRequest={{
          contextId: "context-plan",
          tab: "history",
          roundSeq,
          seq: 1,
        }}
        {...baseHandlers}
      />,
    );
  }

  it("focuses the round the advisory came from, not the round the context is on now", () => {
    const { container } = renderAtRound(1);

    expect(screen.getByRole("tab", { name: /history/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-round-seq", "1");
    // The context is on round 3; landing there would show a record that never
    // raised this advisory.
    expect(screen.getByTestId("cohort-round")).toHaveAttribute(
      "data-round-seq",
      "3",
    );
    expect(screen.getByTestId("cohort-round")).not.toHaveAttribute(
      "data-focused-round",
      "true",
    );
  });

  it("moves keyboard focus onto the round it navigated to", () => {
    const { container } = renderAtRound(1);

    expect(document.activeElement).toBe(
      container.querySelector('[data-focused-round="true"]'),
    );
  });

  it("names the round it landed on", () => {
    const { container } = renderAtRound(1);

    const focused = container.querySelector('[data-focused-round="true"]');
    if (!(focused instanceof HTMLElement)) {
      throw new Error("no round was focused");
    }
    expect(focused).toHaveTextContent("Round 1");
  });

  it("focuses the live round record when the advisory came from that round", () => {
    const { container } = renderAtRound(3);

    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toBe(screen.getByTestId("cohort-round"));
  });

  it("focuses nothing when the deep link names no round", () => {
    const { execution, events } = advancedContext();
    const { container } = render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        contextTabRequest={{
          contextId: "context-plan",
          tab: "config",
          seq: 1,
        }}
        {...baseHandlers}
      />,
    );

    expect(container.querySelector('[data-focused-round="true"]')).toBeNull();
  });

  /**
   * A context reset retires the round history — `validationRound` is dropped
   * and every prior event is marked pre-reset — but leaves the execution's
   * advisory index standing. The entries raised before the reset are still
   * listed, so their links must still reach the round that raised them.
   */
  function resetContext(): {
    execution: GraphWorkflowExecution;
    events: GraphWorkflowExecutionEvent[];
  } {
    const { execution, events } = advancedContext();
    const planState = execution.contextStates["context-plan"];
    if (!planState) throw new Error("fixture is missing context-plan state");
    const { validationRound: _retired, ...afterReset } = planState;
    return {
      execution: {
        ...execution,
        contextStates: {
          ...execution.contextStates,
          "context-plan": afterReset,
        },
      },
      events: events.map((entry) => ({ ...entry, preReset: true })),
    };
  }

  it("still reaches a round the context reset retired", () => {
    const { execution, events } = resetContext();
    const { container } = render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        contextTabRequest={{
          contextId: "context-plan",
          tab: "history",
          roundSeq: 1,
          seq: 1,
        }}
        {...baseHandlers}
      />,
    );

    // The reset emptied the ordinary history...
    expect(screen.queryByTestId("cohort-round")).toBeNull();
    expect(screen.getByText("No validations yet")).toBeInTheDocument();
    // ...and the link still lands on round 1, with the retired record itself
    // and a plain statement of why it sits outside the current attempt.
    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-round-seq", "1");
    const linked = screen.getByTestId("linked-round");
    expect(linked).toHaveTextContent("retired when this context was reset");
    expect(
      within(linked).getByTestId("validation-aggregate"),
    ).toHaveTextContent("Round 1 concluded");
  });

  it("still names a round that left no record at all", () => {
    const { execution, events } = advancedContext();
    const { container } = render(
      <ExecutionInspectorPanel
        execution={execution}
        events={events}
        selectedContextId="context-plan"
        contextTabRequest={{
          contextId: "context-plan",
          tab: "history",
          roundSeq: 7,
          seq: 1,
        }}
        {...baseHandlers}
      />,
    );

    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-round-seq", "7");
    expect(screen.getByTestId("linked-round")).toHaveTextContent(
      "Round 7 left no record",
    );
    // A round with no record has nothing to show beyond saying so.
    expect(
      within(screen.getByTestId("linked-round")).queryByTestId(
        "validation-aggregate",
      ),
    ).toBeNull();
  });
});
