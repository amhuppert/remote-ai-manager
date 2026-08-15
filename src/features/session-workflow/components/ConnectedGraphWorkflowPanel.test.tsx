// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
  makeLaunchDocument,
} from "@/lib/workflow-graph/test-fixtures";
import {
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
  graphWorkflowHistoryKeys,
  graphWorkflowResultKeys,
  workflowDefinitionKeys,
} from "@/lib/workflows/query-keys";
import { validationKeys } from "@/lib/validation/query-keys";
import { useToastStoreForTesting } from "@/stores/toast.store";
import ConnectedGraphWorkflowPanel from "./ConnectedGraphWorkflowPanel";

const PROJECT_NAME = "project-1";
const SESSION_NAME = "session-1";

function parkedExecution(id: string) {
  return createWorkflowExecution({
    id,
    status: "pending",
    seedDefinitionId: "workflow-1",
    seedDefinitionRevision: 1,
    definitionApproval: {
      requestedAt: "2026-07-31T05:29:58.000Z",
      approvedAt: null,
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ConnectedGraphWorkflowPanel definition approval", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useToastStoreForTesting.setState({ toasts: [] });
  });

  it("reconciles to completed and explains when completion wins before pause", async () => {
    const runningExecution = createWorkflowExecution({
      id: "execution-race",
      status: "running",
    });
    const completedExecution = createWorkflowExecution({
      ...runningExecution,
      status: "completed",
      completedAt: "2026-08-05T19:48:36.580Z",
      loopEpoch: runningExecution.loopEpoch + 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/graph-workflow/pause") && init?.method === "POST") {
          return jsonResponse(
            {
              error: "Only running graph workflow executions can be paused",
              code: "workflow_transition_conflict",
              details: {
                action: "pause",
                currentStatus: "completed",
                allowedStatuses: ["running"],
              },
            },
            409,
          );
        }
        if (url.endsWith("/graph-workflow/execution")) {
          return jsonResponse({ execution: completedExecution });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
      runningExecution,
    );
    queryClient.setQueryData(
      workflowDefinitionKeys.detail(PROJECT_NAME, "workflow-1"),
      { item: createWorkflowDefinitionRecord() },
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(
        PROJECT_NAME,
        SESSION_NAME,
        runningExecution.id,
      ),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowHistoryKeys.list(PROJECT_NAME, SESSION_NAME),
      [],
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    });
    expect(useToastStoreForTesting.getState().toasts.at(-1)?.message).toBe(
      "Workflow completed before pause could be applied.",
    );
  });

  it("does not carry an approval refusal onto a replacement execution", async () => {
    const firstExecution = parkedExecution("execution-1");
    const replacementExecution = parkedExecution("execution-2");
    let activeExecution = firstExecution;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (
          url.endsWith("/graph-workflow/approve-definition") &&
          init?.method === "POST"
        ) {
          return jsonResponse(
            {
              error: "The first execution is no longer approvable.",
              code: "execution_mismatch",
              unmetConditions: ["The approval belongs to the first execution."],
              instruction: "Review the replacement execution.",
            },
            409,
          );
        }
        if (url.endsWith("/graph-workflow/execution")) {
          return jsonResponse({ execution: activeExecution });
        }
        if (url.includes("/graph-workflow/events")) {
          return jsonResponse({ events: [] });
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
      firstExecution,
    );
    queryClient.setQueryData(
      workflowDefinitionKeys.detail(PROJECT_NAME, "workflow-1"),
      { item: createWorkflowDefinitionRecord() },
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(
        PROJECT_NAME,
        SESSION_NAME,
        firstExecution.id,
      ),
      [],
    );

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Approve definition & start",
      }),
    );
    expect(
      await screen.findByText(
        "The approval belongs to the first execution. Review the replacement execution.",
      ),
    ).toBeVisible();

    activeExecution = replacementExecution;
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(
        PROJECT_NAME,
        SESSION_NAME,
        replacementExecution.id,
      ),
      [],
    );
    await act(async () => {
      queryClient.setQueryData(
        graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
        replacementExecution,
      );
    });

    await waitFor(() => {
      expect(
        view.container
          .querySelector("[data-workflow-execution-id]")
          ?.getAttribute("data-workflow-execution-id"),
      ).toBe(replacementExecution.id);
    });
    await waitFor(() => {
      expect(
        screen.queryByText(
          "The approval belongs to the first execution. Review the replacement execution.",
        ),
      ).toBeNull();
    });
  });

  it("renders History from its launch snapshot and every walked event page without reading the source template", async () => {
    const historical = createWorkflowExecution({
      id: "execution-history",
      status: "completed",
      completedAt: "2026-08-14T15:30:00.000Z",
      definitionApproval: {
        requestedAt: "2026-08-14T14:30:00.000Z",
        approvedAt: "2026-08-14T14:35:00.000Z",
      },
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Frozen launch document",
        layout: {
          workflowId: "workflow-1",
          contextPositions: {
            "context-plan": { x: 611, y: 222 },
            "context-implement": { x: 971, y: 222 },
            "context-verify": { x: 1331, y: 222 },
          },
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      }),
    });
    const events = [
      {
        seq: 4,
        occurredAt: "2026-08-14T15:30:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-status" as const,
          projectName: PROJECT_NAME,
          sessionName: SESSION_NAME,
          executionId: historical.id,
          workflowStatus: "completed" as const,
          activeContextIds: [],
          activeBatchIds: [],
          activeJoinIds: [],
          haltReason: null,
          pendingHaltReason: null,
          secondaryHaltReasons: [],
        },
      },
      {
        seq: 3,
        occurredAt: "2026-08-14T15:20:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-approval-resolved" as const,
          projectName: PROJECT_NAME,
          sessionName: SESSION_NAME,
          executionId: historical.id,
          contextId: "context-plan",
          conversationId: "conv-plan",
          decision: "rejected" as const,
          message: "Add migration evidence.",
          decidedAt: "2026-08-14T15:20:00.000Z",
        },
      },
      {
        seq: 2,
        occurredAt: "2026-08-14T15:10:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-approval-pending" as const,
          projectName: PROJECT_NAME,
          sessionName: SESSION_NAME,
          executionId: historical.id,
          contextId: "context-plan",
          contextTitle: "Plan",
          conversationId: "conv-plan",
          requestedAt: "2026-08-14T15:10:00.000Z",
        },
      },
      {
        seq: 1,
        occurredAt: "2026-08-14T15:00:00.000Z",
        preReset: false,
        event: {
          type: "graph-workflow-status" as const,
          projectName: PROJECT_NAME,
          sessionName: SESSION_NAME,
          executionId: historical.id,
          workflowStatus: "paused" as const,
          activeContextIds: [],
          activeBatchIds: [],
          activeJoinIds: [],
          haltReason: null,
          pendingHaltReason: null,
          secondaryHaltReasons: [],
        },
      },
    ];
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/workflows/workflow-1")) {
        return jsonResponse({
          item: createWorkflowDefinitionRecord({
            name: "Mutated source template",
            layout: {
              workflowId: "workflow-1",
              contextPositions: {
                "context-plan": { x: 12, y: 34 },
              },
              viewport: { x: 0, y: 0, zoom: 1 },
            },
          }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
      null,
    );
    queryClient.setQueryData(
      graphWorkflowExecutionKeys.byId(
        PROJECT_NAME,
        SESSION_NAME,
        historical.id,
      ),
      historical,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, historical.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.pages(PROJECT_NAME, SESSION_NAME, historical.id),
      {
        pages: [
          { events: events.slice(0, 2), nextCursor: 2 },
          { events: events.slice(2), nextCursor: null },
        ],
        pageParams: [null, 2],
      },
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, historical.id),
      {
        cursor: 2,
        occurredAt: "2026-08-14T15:30:00.000Z",
        executionId: historical.id,
        boundaryKind: "completion",
        status: "completed",
        contextId: null,
        pendingActions: [],
        outputs: {
          kind: "declared_outputs",
          byContext: { "context-plan": { releaseNotes: "Shipped" } },
        },
        name: "Frozen launch document",
        origin: historical.origin,
        originConversationId: historical.ownerConversationId,
        startedAt: historical.startedAt,
        completedAt: historical.completedAt,
        haltReason: null,
        abandonment: null,
        documents: [],
        deepLink:
          "/projects/project-1/session-1/workflow?execution=execution-history",
      },
    );

    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={historical.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Workflow paused")).toBeVisible();
    expect(screen.getByText("Workflow completed")).toBeVisible();
    expect(screen.getByText("completion result")).toBeVisible();
    expect(screen.getByText("context-plan.releaseNotes")).toBeVisible();
    expect(screen.getByText("Shipped")).toBeVisible();
    const approvalHistory = screen.getByRole("region", {
      name: "Approval history",
    });
    expect(approvalHistory).toHaveTextContent("Definition approved");
    expect(approvalHistory).toHaveTextContent("Plan rejected");
    expect(approvalHistory).toHaveTextContent("Add migration evidence.");
    await waitFor(() => {
      const node = view.container.querySelector<HTMLElement>(
        '.react-flow__node[data-id="context-plan"]',
      );
      expect(node?.style.transform).toContain("611px");
      expect(node?.style.transform).toContain("222px");
    });

    queryClient.setQueryData(
      workflowDefinitionKeys.detail(PROJECT_NAME, "workflow-1"),
      { item: createWorkflowDefinitionRecord({ name: "Edited after launch" }) },
    );
    queryClient.removeQueries({
      queryKey: workflowDefinitionKeys.detail(PROJECT_NAME, "workflow-1"),
    });

    expect(screen.getByText("Workflow paused")).toBeVisible();
    expect(
      fetchSpy.mock.calls.some(([input]) =>
        String(input).includes("/workflows/workflow-1"),
      ),
    ).toBe(false);
  });

  it("surfaces a structured live configuration refusal where Save was clicked", async () => {
    const execution = createWorkflowExecution({
      id: "execution-config",
      status: "paused",
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (
          url.endsWith("/graph-workflow/runtime-edits") &&
          init?.method === "POST"
        ) {
          return jsonResponse(
            {
              error: "live edit was rejected",
              code: "invalid_edit",
              issues: [
                {
                  path: "executionContexts.context-implement.agentValidation.contextValidator.value.commands.0",
                  message:
                    'unknown-validation-command — Unknown validation command "premerge"',
                },
              ],
            },
            400,
          );
        }
        throw new Error(`Unexpected fetch: ${init?.method ?? "GET"} ${url}`);
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
      execution,
    );
    queryClient.setQueryData(
      workflowDefinitionKeys.detail(PROJECT_NAME, "workflow-1"),
      { item: createWorkflowDefinitionRecord() },
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowHistoryKeys.list(PROJECT_NAME, SESSION_NAME),
      [],
    );
    queryClient.setQueryData(validationKeys.commands(), {
      projects: [{ projectName: PROJECT_NAME, commands: [] }],
    });

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("rf__node-context-implement"));
    await userEvent.click(screen.getByRole("tab", { name: "Config" }));
    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "9" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      'Unknown validation command "premerge"',
    );
  });
});
