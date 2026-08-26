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
import { modelDisplayLabel } from "@/lib/agent-backends/catalog";
import type { WorkflowAdvisoryIdentity } from "@/lib/workflow-graph/definition-schemas";
import ContextDetail from "./ContextDetail";

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

// README §11 relocates validation rounds and artifacts from the Overview to the
// selected context's History tab. These cases assert on that content, so they
// render the context and open the tab that now owns it.
function renderContextHistory(ui: React.ReactElement) {
  const result = render(ui);
  selectDetailTab(/History/);
  return result;
}

/**
 * A round's cards sit behind its Artifacts control (design E3): the rounds card
 * lists rounds, and opening one is how a reader reaches what it produced.
 */
function openRoundArtifacts(seq: number) {
  const row = screen
    .getByTestId("validation-rounds")
    .querySelector(
      `[data-testid="validation-round-row"][data-round-seq="${seq}"]`,
    );
  if (!(row instanceof HTMLElement)) throw new Error(`no round row ${seq}`);
  fireEvent.click(
    within(row).getByTestId("validation-round-artifacts") as HTMLElement,
  );
  return row;
}

describe("ContextDetail — ValidationCard markdown formatting", () => {
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

    const { container } = renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

describe("ContextDetail — ValidationCard lane and backend badges", () => {
  it("renders Context badge for context_validator lane", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: conversationValidationRef("conv-1"),
      }),
    ]);

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Context")).toBeInTheDocument();
  });
});

describe("ContextDetail — View Transcript button", () => {
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

  it("does not show View Transcript button when onViewConversation is not provided", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        sessionRef: conversationValidationRef("conv-abc"),
      }),
    ]);

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /View Transcript/i }),
    ).not.toBeInTheDocument();
  });
});

describe("ContextDetail — Codex review artifact", () => {
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Testfake Review")).toBeInTheDocument();
    expect(screen.getByText("testfake-review-ref")).toBeInTheDocument();
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

describe("ContextDetail — continued session badge", () => {
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    // the "continued" badge should appear for the reused session
    expect(screen.getByText("continued")).toBeInTheDocument();
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

    renderContextHistory(
      <ContextDetail
        execution={createWorkflowExecution()}
        events={history}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("continued")).toBeInTheDocument();
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.queryByText("continued")).not.toBeInTheDocument();
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

describe("ContextDetail — reopened tasks", () => {
  it("renders reopened task ids for failed context validation", () => {
    const { execution, events } = makeExecutionWithHistory([
      makeValidationEvent({
        pass: false,
        reopenTaskIds: ["task-plan-1", "task-implement-1"],
        sessionRef: conversationValidationRef("conv-reopen"),
      }),
    ]);

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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
describe("ContextDetail — multi-assignment cohort rounds", () => {
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

    renderContextHistory(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    // Newest first: the cohort round is the round on top, and its aggregate
    // reopen list renders exactly as a single reviewer's would.
    openRoundArtifacts(2);
    expect(
      screen.getByText("The cohort rejected the work"),
    ).toBeInTheDocument();
    expect(screen.getByText("Reopened Tasks (1)")).toBeInTheDocument();
  });
});

describe("ContextDetail — shared implementer session task history", () => {
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
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

describe("ContextDetail — live implementer viewing", () => {
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
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
        onViewTask={onViewTask}
      />,
    );

    expect(screen.getByRole("button", { name: "Watch" })).toBeInTheDocument();
  });
});

describe("ContextDetail — task editability", () => {
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
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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
        // The shared fixture only carries `task-plan-1`; this test's extra
        // tasks need their state spelled out in full.
        "task-plan-2": {
          taskId: "task-plan-2",
          contextId: "context-plan",
          order: 2,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
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
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
        onReorderTask={onReorderTask}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Capture risks/ }));
    fireEvent.click(screen.getByRole("button", { name: "Up" }));

    expect(onReorderTask).toHaveBeenCalledWith("context-plan", [
      "task-plan-3",
      "task-plan-2",
    ]);
  });
});

describe("ContextDetail — Tasks tab task history", () => {
  function executionWithSendBacks(): GraphWorkflowExecution {
    const base = createWorkflowExecution({ status: "running" });
    return {
      ...base,
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "running",
          startedAt: "2026-03-27T10:31:00.000Z",
          failureMessage: "audit log bypassed on the timeout path",
          failureHistory: [
            {
              message: "acceptance criteria 2 unmet",
              timestamp: "2026-03-27T10:12:00.000Z",
            },
            {
              message: "audit log bypassed on the timeout path",
              timestamp: "2026-03-27T10:42:00.000Z",
            },
          ],
        },
      },
    };
  }

  it("marks a task that validators sent back, without expanding it", () => {
    render(
      <ContextDetail
        execution={executionWithSendBacks()}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("task-reopened-marker")).toHaveTextContent(
      "reopened 2×",
    );
  });

  it("states every attempt, not only the newest failure, once expanded", () => {
    render(
      <ContextDetail
        execution={executionWithSendBacks()}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getAllByTestId("wf-task-item")[0]!);

    const history = screen.getByTestId("task-history");
    expect(history).toHaveTextContent("acceptance criteria 2 unmet");
    expect(history).toHaveTextContent("audit log bypassed on the timeout path");
    expect(
      within(history)
        .getAllByTestId("task-history-entry")
        .map((entry) => entry.getAttribute("data-kind")),
    ).toEqual(["rejected", "started", "rejected"]);
  });

  it("says nothing about a task that has not run", () => {
    render(
      <ContextDetail
        execution={createWorkflowExecution({ status: "running" })}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    fireEvent.click(screen.getAllByTestId("wf-task-item")[0]!);

    expect(screen.queryByTestId("task-history")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("task-reopened-marker"),
    ).not.toBeInTheDocument();
  });
});

describe("ContextDetail — awaiting-approval status badge", () => {
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
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    // The header reads its label from the node's status vocabulary, so the
    // rail and the canvas name the same state the same way.
    const badge = screen.getByText("Awaiting approval");
    expect(badge).toBeInTheDocument();
  });
});

describe("ContextDetail — Reset Context", () => {
  // README section 11 relocates the destructive reset into the Config tab's
  // danger footer, so this asserts the WIRING reaches it there. The admission
  // matrix (running / completed / no handler / authority lost mid-dialog) now
  // belongs to the panel that owns the control, and is tested there.
  it("reaches the relocated reset through the Config tab and confirms with the context id", () => {
    const onResetContext = vi.fn();
    const execution = createWorkflowExecution({ status: "paused" });
    const events: GraphWorkflowExecutionEvent[] = [];

    render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
        onResetContext={onResetContext}
      />,
    );

    // Not in the header any more — the relocation is a move, not a copy.
    expect(
      screen.queryByRole("button", { name: /reset context/i }),
    ).not.toBeInTheDocument();

    selectDetailTab("Config");

    fireEvent.click(screen.getByRole("button", { name: /reset context/i }));
    expect(screen.getByText("Reset context?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));
    expect(onResetContext).toHaveBeenCalledWith("context-plan");
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
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab(/history/i);

    expect(screen.getByText("Kept after reset")).toBeInTheDocument();
    expect(screen.queryByText("Discarded by reset")).not.toBeInTheDocument();
  });
});

describe("ContextDetail — Config tab editing wiring", () => {
  it("forwards a composed update-context op batch through onSaveContextConfig", () => {
    const onSaveContextConfig = vi.fn();
    render(
      <ContextDetail
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    selectDetailTab("Config");
    // The panel drills: the root card opens Execution policy, which is where
    // the iteration ceiling lives.
    fireEvent.click(screen.getByRole("button", { name: /Execution policy/ }));
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
      <ContextDetail
        execution={execution}
        events={[]}
        contextId="context-plan"
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
    // The conflict has to be reported for a save THIS context submitted: the
    // runtime-edit mutation is shared across the execution, so an unsubmitted
    // context showing its flags would be announcing someone else's failure.
    const onSaveContextConfig = vi.fn();
    const { rerender } = render(
      <ContextDetail
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={onSaveContextConfig}
      />,
    );

    selectDetailTab("Config");
    fireEvent.click(screen.getByRole("button", { name: /Execution policy/ }));
    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSaveContextConfig).toHaveBeenCalledTimes(1);

    rerender(
      <ContextDetail
        execution={createWorkflowExecution({ status: "paused" })}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={onSaveContextConfig}
        configEditConflict
      />,
    );

    expect(screen.getByTestId("config-save-alert")).toHaveTextContent(
      /execution changed/i,
    );
  });
});

describe("ContextDetail — brief markdown + focus modal", () => {
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
      <ContextDetail
        execution={makeBriefExecution()}
        events={[]}
        contextId="context-plan"
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
      <ContextDetail
        execution={createWorkflowExecution({ workingDefinition: definition })}
        events={[]}
        contextId="context-plan"
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

  // #69 change 4 stage 1: record-shaped criteria render as numbered records
  // citing each id — the same citable form validator verdicts key on.
  it("renders record-shaped criteria as numbered records citing ids", async () => {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? {
              ...context,
              acceptanceCriteria: [
                { id: "ac-1", statement: "The endpoint returns 200" },
                { id: "audit-log", statement: "The audit log records it" },
              ],
            }
          : context,
    );
    render(
      <ContextDetail
        execution={createWorkflowExecution({ workingDefinition: definition })}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    const first = await screen.findByText(
      "[ac-1] The endpoint returns 200",
      undefined,
      { timeout: 15000 },
    );
    // Numbered records, not prose: markdown renders the canonical numbered
    // lines as an ordered list.
    expect(first.closest("ol")).toBeTruthy();
    expect(
      screen.getByText("[audit-log] The audit log records it"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /view acceptance criteria/i }),
    );
    const dialog = await screen.findByRole("dialog", {}, { timeout: 15000 });
    expect(
      await within(dialog).findByText("[audit-log] The audit log records it"),
    ).toBeInTheDocument();
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
    // The catalog's canonical long name, not the short id the config holds.
    expect(strip!.textContent).toContain(
      `Claude ${modelDisplayLabel("claude", "opus")} · effort=high`,
    );
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

describe("ContextDetail — output-schema validation card (R3.2)", () => {
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
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

describe("ContextDetail — context data composition", () => {
  it("mounts the selected context's captured output and direct upstream input", () => {
    const outputSchema = {
      type: "object",
      properties: { verdict: { type: "string" } },
      required: ["verdict"],
    };
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan" || context.id === "context-implement"
          ? { ...context, outputSchema }
          : context,
    );
    const execution = createWorkflowExecution({
      workingDefinition: definition,
      contextOutputs: {
        "context-plan": {
          value: { verdict: "ready" },
          capturedAt: "2026-03-27T14:20:00.000Z",
          iteration: 1,
          parse: { source: "native" },
        },
        "context-implement": {
          value: { verdict: "pass" },
          capturedAt: "2026-03-27T14:22:00.000Z",
          iteration: 2,
          parse: { source: "native" },
        },
      },
    });

    render(
      <ContextDetail
        execution={execution}
        events={[]}
        contextId="context-implement"
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("captured-output-status")).toHaveTextContent(
      "Captured",
    );
    const upstream = screen.getByTestId("upstream-inputs");
    expect(within(upstream).getByTestId("upstream-input-row")).toHaveAttribute(
      "data-context-id",
      "context-plan",
    );
  });
});

// R12.3: the execution inspector's per-assignment display. A cohort round is
// the only surface on which "who reviewed this, on which bytes, and did the
// tree move" is answerable, so every assertion here reads the frozen round
// record and the aggregate result — never the live library or a colour.
describe("ContextDetail — per-assignment cohort inspector (R12.3)", () => {
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
            modelSelection: {
              modelId: "gpt-5.6-sol",
              parameters: { reasoning: "high", fast: "false" },
            },
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
                    modelSelection: {
                      modelId: "opus",
                      parameters: { effort: "high" },
                    },
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
      <ContextDetail
        execution={cohortExecution(makeRound())}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    expect(screen.getByTestId("setup-implementer-profile")).toHaveTextContent(
      "builtin:general-implementer@3",
    );
  });

  it("lists each roster seat with its frozen profile identity, revision and lane status", () => {
    render(
      <ContextDetail
        execution={cohortExecution(makeRound())}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    openRoundArtifacts(2);

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
      <ContextDetail
        execution={cohortExecution(makeRound())}
        events={[incidentEvent()]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    openRoundArtifacts(2);

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
      <ContextDetail
        execution={cohortExecution(
          makeRound({ phase: "concluded", outcome: "failed" }),
        )}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    openRoundArtifacts(2);
    const aggregate = screen.getByTestId("cohort-round-aggregate");
    expect(aggregate).toHaveTextContent("Cohort rejected");
    expect(aggregate.dataset.outcomeKind).toBe("semantic");

    rerender(
      <ContextDetail
        execution={cohortExecution(
          makeRound({ phase: "concluded", outcome: "candidate_mismatch" }),
        )}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    // The row stays open across the rerender — the component is not remounted.
    const infra = screen.getByTestId("cohort-round-aggregate");
    expect(infra).toHaveTextContent("Candidate changed under the cohort");
    expect(infra.dataset.outcomeKind).toBe("infrastructure");
  });

  it("omits the round section entirely for a context that has never had one", () => {
    render(
      <ContextDetail
        execution={cohortExecution(null)}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    expect(
      screen.queryByTestId("validation-round-row"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("validation-rounds")).toHaveTextContent(
      "No validation has run for this context yet.",
    );
  });

  it("opens one cohort member's lane conversation with an assignment-labeled header", () => {
    const onViewConversation = vi.fn();
    render(
      <ContextDetail
        execution={cohortExecution(makeRound())}
        events={[]}
        contextId="context-plan"
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    openRoundArtifacts(2);
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
      <ContextDetail
        execution={cohortExecution(makeRound())}
        events={events}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    openRoundArtifacts(2);

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
      <ContextDetail
        execution={cohortExecution(null)}
        events={events}
        contextId="context-plan"
        onViewConversation={onViewConversation}
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    openRoundArtifacts(2);
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
      <ContextDetail
        execution={cohortExecution(null)}
        events={[cohortRejectionEvent()]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    openRoundArtifacts(2);

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
      <ContextDetail
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
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    selectDetailTab("History");
    openRoundArtifacts(2);

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
      <ContextDetail
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
        contextId="context-plan"
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

describe("ContextDetail — routing section (R13.1)", () => {
  it("lists each incoming guard with its resolution", () => {
    const execution = guardedExecution();
    render(
      <ContextDetail
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
        contextId="context-implement"
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
      <ContextDetail
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
        contextId="context-implement"
        {...baseHandlers}
      />,
    );

    expect(screen.getByText("Skipped")).toBeTruthy();
  });

  it("renders the recorded skip reason of a skipped context", () => {
    const execution = guardedExecution();
    render(
      <ContextDetail
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
        contextId="context-implement"
        {...baseHandlers}
      />,
    );

    const skip = screen.getByTestId("context-skip-reason");
    expect(skip).toHaveTextContent(/branch not taken/i);
    expect(skip).toHaveTextContent("edge-plan-implement");
    expect(skip).toHaveTextContent("inactive");
  });
});

describe("ContextDetail — loop pass section (R13.1)", () => {
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
      <ContextDetail
        execution={loopExecution()}
        events={[]}
        contextId="loop-a__p2__context-implement"
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
});

describe("ContextDetail — advisories in the round history (R9.2/R9.3/R9.5)", () => {
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
      <ContextDetail
        execution={advisoryExecution()}
        events={[roundTwoAggregate()]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );
    selectDetailTab(/history/i);
    openRoundArtifacts(2);

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

  it("badges a seat the live cohort no longer holds as unknown rather than advisory (R9.5)", () => {
    const execution = advisoryExecution();
    const base = execution.workingDefinition;
    render(
      <ContextDetail
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
        contextId="context-plan"
        {...baseHandlers}
      />,
    );
    selectDetailTab(/history/i);
    openRoundArtifacts(2);

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
});

describe("ContextDetail — an origin link reaches the originating round (R9.4)", () => {
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

  /** Raised by the round the context state still holds, not by a concluded one. */
  const roundThreeAdvisory = {
    ...roundOneAdvisory,
    title: "The backfill has no owner",
    identity: { roundSeq: 3, assignmentId: "security", ordinal: 1 },
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
          advisories: [roundThreeAdvisory],
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
          {
            identity: roundThreeAdvisory.identity,
            kind: "plan",
            title: roundThreeAdvisory.title,
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

  function renderAtAdvisory(advisory: WorkflowAdvisoryIdentity) {
    const { execution, events } = advancedContext();
    return render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        contextTabRequest={{
          contextId: "context-plan",
          tab: "history",
          advisory,
          seq: 1,
        }}
        {...baseHandlers}
      />,
    );
  }

  it("focuses the round the advisory came from, not the round the context is on now", () => {
    const { container } = renderAtAdvisory(roundOneAdvisory.identity);

    expect(screen.getByRole("tab", { name: /history/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-round-seq", "1");
    // The context is on round 3; landing there would show a record that never
    // raised this advisory.
    const liveRow = container.querySelector(
      '[data-testid="validation-round-row"][data-round-seq="3"]',
    );
    expect(liveRow).not.toBeNull();
    expect(liveRow).not.toHaveAttribute("data-focused-round", "true");
  });

  it("moves keyboard focus onto the round it navigated to", () => {
    const { container } = renderAtAdvisory(roundOneAdvisory.identity);

    expect(document.activeElement).toBe(
      container.querySelector('[data-focused-round="true"]'),
    );
  });

  it("names the round it landed on", () => {
    const { container } = renderAtAdvisory(roundOneAdvisory.identity);

    const focused = container.querySelector('[data-focused-round="true"]');
    if (!(focused instanceof HTMLElement)) {
      throw new Error("no round was focused");
    }
    expect(focused).toHaveTextContent("round 1");
  });

  it("focuses the live round record when the advisory came from that round", () => {
    const { container } = renderAtAdvisory(roundThreeAdvisory.identity);

    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-round-seq", "3");
  });

  it("focuses nothing when the deep link names no round", () => {
    const { execution, events } = advancedContext();
    const { container } = render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
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

  // A reset ends an attempt, and the visible history is the current attempt.
  // Nothing of a retired round is listed, described, or rendered: the record
  // carries no attempt identity, so a link can only say the round is not here.
  it("does not list or render the rounds a reset retired", () => {
    const { execution, events } = resetContext();
    const { container } = render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        contextTabRequest={{
          contextId: "context-plan",
          tab: "history",
          advisory: roundOneAdvisory.identity,
          seq: 1,
        }}
        {...baseHandlers}
      />,
    );

    expect(screen.queryAllByTestId("validation-round-row")).toHaveLength(0);
    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    const linked = focused[0] as HTMLElement;
    expect(linked).toHaveAttribute("data-round-seq", "1");
    expect(linked).toHaveTextContent("not in this context's current history");
    // No aggregate, no attempt, no cause — none of it is knowable.
    expect(within(linked).queryByTestId("validation-aggregate")).toBeNull();
    expect(linked.textContent ?? "").not.toMatch(/retired|reset|attempt/i);
  });

  // A reset restarts the numbering, so the attempt that follows has its own
  // round 1 — a different round that happens to wear the same number. Nothing
  // in the record tells one attempt's round 1 from another's, so the only thing
  // that can place a link is the advisory itself: the row either holds it or
  // the link says the round is not in this history.
  it("does not land a retired advisory on the current attempt's round of the same number", () => {
    const { execution, events } = resetContext();
    const rebuiltRoundOne: GraphWorkflowExecutionEvent = {
      occurredAt: "2026-03-27T20:00:00.000Z",
      preReset: false,
      event: makeValidationEvent({
        roundSeq: 1,
        summary: "Rebuilt round 1 concluded",
        specialists: [securityEntry([])],
      }),
    };

    const { container } = render(
      <ContextDetail
        execution={execution}
        events={[...events, rebuiltRoundOne]}
        contextId="context-plan"
        contextTabRequest={{
          contextId: "context-plan",
          tab: "history",
          advisory: roundOneAdvisory.identity,
          seq: 1,
        }}
        {...baseHandlers}
      />,
    );

    // The new attempt's round 1 is listed — it is part of this history — but it
    // never raised the advisory, so the link does not open it.
    const listed = screen.getAllByTestId("validation-round-row");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toHaveAttribute("data-round-seq", "1");
    expect(listed[0]).not.toHaveAttribute("data-focused-round", "true");

    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-testid", "linked-round");
    expect(focused[0]).toHaveTextContent(
      "Round 1 is not in this context's current history",
    );
    expect(focused[0]?.textContent ?? "").not.toMatch(/retired|reset|attempt/i);
  });

  // The link is honoured while the execution log is still being read, so the
  // round it names has no anchor to land on yet. When the evidence arrives and
  // the card mounts, the landing still has to happen — a link that silently
  // does nothing leaves the reader looking at the top of a long History.
  it("lands on the linked round once the History evidence finishes loading", () => {
    const { execution, events } = advancedContext();
    const view = (complete: boolean) => (
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        eventsAreComplete={complete}
        contextTabRequest={{
          contextId: "context-plan",
          tab: "history",
          advisory: roundOneAdvisory.identity,
          seq: 1,
        }}
        {...baseHandlers}
      />
    );

    const { container, rerender } = render(view(false));
    expect(screen.getByTestId("history-evidence-pending")).toBeInTheDocument();
    expect(
      container.querySelectorAll('[data-focused-round="true"]'),
    ).toHaveLength(0);

    rerender(view(true));

    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-round-seq", "1");
    expect(document.activeElement).toBe(focused[0]);
  });

  it("still names a round that left no record at all", () => {
    const { execution, events } = advancedContext();
    const { container } = render(
      <ContextDetail
        execution={execution}
        events={events}
        contextId="context-plan"
        contextTabRequest={{
          contextId: "context-plan",
          tab: "history",
          advisory: { roundSeq: 7, assignmentId: "security", ordinal: 1 },
          seq: 1,
        }}
        {...baseHandlers}
      />,
    );

    const focused = container.querySelectorAll('[data-focused-round="true"]');
    expect(focused).toHaveLength(1);
    expect(focused[0]).toHaveAttribute("data-round-seq", "7");
    expect(screen.getByTestId("linked-round")).toHaveTextContent(
      "Round 7 is not in this context's current history",
    );
    // A round with no record has nothing to show beyond saying so.
    expect(
      within(screen.getByTestId("linked-round")).queryByTestId(
        "validation-aggregate",
      ),
    ).toBeNull();
  });
});

describe("ContextDetail — halt repair reaches the refusing contract (R3.2)", () => {
  function haltedOnOutputSchema(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? { ...context, outputSchema: { type: "object", properties: {} } }
          : context,
    );
    return createWorkflowExecution({
      workingDefinition: definition,
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "output_schema_validation",
        failureCount: 3,
        summary: "Output schema not satisfied",
      },
    });
  }

  // The halt card sits inside the context it refused, so the operator reaching
  // it has already selected that context. Landing them on the Config tab is not
  // the destination §11 names: the contract that refused the run is one screen
  // further in, and the typed destination is what carries them there.
  it("opens the Config tab at the Brief → Output schema screen", async () => {
    render(
      <ContextDetail
        execution={haltedOnOutputSchema()}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
        onSaveContextConfig={vi.fn()}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit schema" })[0]!);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Config" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    // Not merely the tab: the panel is drilled onto the contract that refused
    // the run, with Brief as the level it steps back to.
    await waitFor(() => {
      expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
        "Output schema",
      );
    });
    expect(screen.getByLabelText("Output schema JSON")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to Brief" }),
    ).toBeInTheDocument();
  });
});

describe("ContextDetail — Tasks tab controls and motion", () => {
  function runningExecution(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? { ...context, description: "Plan the implementation" }
          : context,
    );
    const base = createWorkflowExecution({
      workingDefinition: definition,
      status: "running",
    });
    return {
      ...base,
      taskStates: {
        ...base.taskStates,
        "task-plan-1": {
          ...base.taskStates["task-plan-1"]!,
          status: "running",
          startedAt: "2026-03-27T10:31:00.000Z",
        },
      },
    };
  }

  function renderTasks() {
    return render(
      <ContextDetail
        execution={runningExecution()}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );
  }

  it("gives each brief read view a real button rather than a div with a role", () => {
    renderTasks();

    for (const name of [/view description/i, /view acceptance criteria/i]) {
      const control = screen.getByRole("button", { name });
      expect(control.tagName).toBe("BUTTON");
      expect(control.className).toContain("focus-visible:");
    }
  });

  it("gives each task disclosure a real button with a visible focus ring", () => {
    renderTasks();

    const rows = screen.getAllByTestId("wf-task-item");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tagName).toBe("BUTTON");
      expect(row).toHaveAttribute("aria-expanded");
      expect(row.className).toContain("focus-visible:");
    }
  });

  it("stops the running-task pulse for readers who ask for reduced motion", () => {
    const { container } = renderTasks();

    const pulsing = container.querySelector('[data-testid="task-status-dot"]');
    expect(pulsing?.className).toContain("pulse-dot");
    expect(pulsing?.className).toContain("motion-reduce:");
  });
});

describe("ContextDetail — Brief preview keeps its markdown links live", () => {
  function briefWithLink(): GraphWorkflowExecution {
    const definition = createResolvedWorkflowDefinition();
    definition.executionContexts = definition.executionContexts.map(
      (context) =>
        context.id === "context-plan"
          ? {
              ...context,
              description:
                "Follow the [runbook](https://example.com/runbook) before starting.",
            }
          : context,
    );
    return createWorkflowExecution({ workingDefinition: definition });
  }

  // The whole preview box opens the focus sheet, but a link inside the prose
  // was directly actionable before the rail was reworked and has to stay so:
  // the box-wide control must not swallow it.
  it("renders a description link as a real anchor outside the open control", async () => {
    render(
      <ContextDetail
        execution={briefWithLink()}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    const link = await screen.findByRole(
      "link",
      { name: "runbook" },
      { timeout: 15000 },
    );
    expect(link).toHaveAttribute("href", "https://example.com/runbook");
    expect(link.closest("button")).toBeNull();
  });

  it("lets a pointer reach the link while the rest of the box opens the sheet", async () => {
    render(
      <ContextDetail
        execution={briefWithLink()}
        events={[]}
        contextId="context-plan"
        {...baseHandlers}
      />,
    );

    await screen.findByRole("link", { name: "runbook" }, { timeout: 15000 });

    // jsdom performs no hit-testing, so the pointer contract is only readable
    // as the classes that declare it: the prose is inert so a click falls
    // through to the control beneath, and anchors opt back in.
    const preview = screen.getAllByTestId("brief-read-view")[0]!;
    expect(preview.className).toContain("pointer-events-none");
    expect(preview.className).toContain("[&_a]:pointer-events-auto");
  });
});
