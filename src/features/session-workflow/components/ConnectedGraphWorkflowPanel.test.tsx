// @vitest-environment jsdom
import { Profiler } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  globalWorkflowTemplateKeys,
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
      await screen.findByRole("button", { name: "Approve" }),
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

    // README §11 makes each Overview destination a drill: the walked event
    // pages live behind Events, the approval trail behind Approvals, and the
    // durable result is stated on the root.
    fireEvent.click(await screen.findByTestId("overview-row-events"));
    expect(screen.getByText("Workflow paused")).toBeVisible();
    expect(screen.getByText("Workflow completed")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByTestId("overview-result")).toHaveTextContent(
      "completion",
    );
    expect(screen.getByText("context-plan.releaseNotes")).toBeVisible();
    expect(screen.getByText("Shipped")).toBeVisible();
    fireEvent.click(screen.getByTestId("overview-row-approvals"));
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

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    fireEvent.click(screen.getByTestId("overview-row-events"));
    expect(screen.getByText("Workflow paused")).toBeVisible();
    expect(
      fetchSpy.mock.calls.some(([input]) =>
        String(input).includes("/workflows/workflow-1"),
      ),
    ).toBe(false);
  });

  // The walk is frozen at the moment it ran and the tail is bounded, so a run
  // that appends more rows than the tail holds leaves a span of the log in
  // neither window. History reads absence as evidence — a round nothing names
  // did not run — so it must not describe a log it only half holds, and the gap
  // has to be walked again rather than waited out.
  it("waits and re-walks the log when the run outran the tail the frozen walk was joined to", async () => {
    // A live run: only a selection that still holds the lease reads the bounded
    // tail at all, and the gap is a live run's failure mode.
    const execution = createWorkflowExecution({
      id: "execution-gap",
      status: "running",
    });
    const contextStatus = (occurredAt: string, iterationCount: number) => ({
      occurredAt,
      preReset: false,
      event: {
        type: "graph-workflow-context-status" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        status: "running" as const,
        remainingTaskCount: 1,
        iterationCount,
      },
    });
    const walked = contextStatus("2026-08-14T15:00:00.000Z", 1);
    // Written after the walk froze and after the tail dropped everything
    // between: no row of this one is in the walked pages.
    const beyondTheWalk = contextStatus("2026-08-14T15:25:00.000Z", 2);

    // Held open so the tab can be read while the re-walk is still in flight.
    let completeRewalk = () => {};
    const rewalked = new Promise<void>((resolve) => {
      completeRewalk = resolve;
    });
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        await rewalked;
        return jsonResponse({
          events: [
            { ...beyondTheWalk, seq: 2 },
            { ...walked, seq: 1 },
          ],
          nextCursor: null,
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
      execution,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [beyondTheWalk],
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.pages(PROJECT_NAME, SESSION_NAME, execution.id),
      {
        pages: [{ events: [{ ...walked, seq: 1 }], nextCursor: null }],
        pageParams: [null],
      },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const planNode = (await screen.findByText("Plan")).closest(
      ".react-flow__node",
    );
    expect(planNode).not.toBeNull();
    fireEvent.click(planNode as HTMLElement);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
      /reading the execution log/i,
    );
    expect(
      fetchSpy.mock.calls.some(([input]) =>
        String(input).includes("page=true"),
      ),
    ).toBe(true);

    // The re-walk closes the gap on its own; only then does the tab describe
    // what the execution recorded.
    await act(async () => {
      completeRewalk();
      await rewalked;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
    });
    expect(screen.getByTestId("validation-rounds")).toBeVisible();
  });

  // A completed walk is a prefix of the log frozen at the moment it ran, and the
  // tail is the only window that says what the run has appended since. Until the
  // tail has actually been read, "the walk finished" is not "this is the whole
  // log": every round recorded after the walk would be missing, and a round
  // nothing names reads as a round that left no record.
  it("waits for the live tail before describing the log the frozen walk holds", async () => {
    const execution = createWorkflowExecution({
      id: "execution-tail",
      status: "running",
    });
    const walked = {
      occurredAt: "2026-08-14T15:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-context-status" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        status: "running" as const,
        remainingTaskCount: 1,
        iterationCount: 1,
      },
    };

    // The tail is held open so the tab can be read while it is still in flight
    // and the walk is finished. The walk is served rather than seeded, because a
    // walk the panel did not watch land is one it withholds and reads again.
    let completeTail = () => {};
    const tailRead = new Promise<void>((resolve) => {
      completeTail = resolve;
    });
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        return jsonResponse({
          events: [{ ...walked, seq: 1 }],
          nextCursor: null,
        });
      }
      if (url.includes("/graph-workflow/events")) {
        await tailRead;
        return jsonResponse({ events: [walked] });
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
      execution,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const planNode = (await screen.findByText("Plan")).closest(
      ".react-flow__node",
    );
    expect(planNode).not.toBeNull();
    fireEvent.click(planNode as HTMLElement);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
      /reading the execution log/i,
    );

    await act(async () => {
      completeTail();
      await tailRead;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
    });
    expect(screen.getByTestId("validation-rounds")).toBeVisible();
  });

  // A reset rewrites `preReset` on rows already written and invalidates the
  // execution record and the tail independently. Between the two the tail this
  // panel holds is the log as it read BEFORE the reset, and drawing it beside a
  // rebuilt execution puts the retired attempt's rounds back into the current
  // one. Holding what is already known to be on its way back is the difference.
  it("stops describing the log while the tail it holds is being read again", async () => {
    const execution = createWorkflowExecution({
      id: "execution-refresh",
      status: "running",
    });
    const walked = {
      occurredAt: "2026-08-14T15:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-context-status" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        status: "running" as const,
        remainingTaskCount: 1,
        iterationCount: 1,
      },
    };

    let completeRefresh = () => {};
    const refreshed = new Promise<void>((resolve) => {
      completeRefresh = resolve;
    });
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      // Served rather than seeded: a walk the panel did not watch land is one it
      // withholds and reads again, which is not what this test is about.
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        return jsonResponse({
          events: [{ ...walked, seq: 1 }],
          nextCursor: null,
        });
      }
      if (url.includes("/graph-workflow/events")) {
        await refreshed;
        return jsonResponse({ events: [walked] });
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
      execution,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [walked],
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const planNode = (await screen.findByText("Plan")).closest(
      ".react-flow__node",
    );
    expect(planNode).not.toBeNull();
    fireEvent.click(planNode as HTMLElement);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    await waitFor(() => {
      expect(screen.getByTestId("validation-rounds")).toBeVisible();
    });

    // What the reset's SSE reaction does to the tail this panel is drawing. The
    // refetch it starts is the one held open above, so it is not awaited here.
    await act(async () => {
      void queryClient.invalidateQueries({
        queryKey: graphWorkflowEventsKeys.list(
          PROJECT_NAME,
          SESSION_NAME,
          execution.id,
        ),
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });

    await act(async () => {
      completeRefresh();
      await refreshed;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
    });
    expect(screen.getByTestId("validation-rounds")).toBeVisible();
  });

  // The last rows a run writes — its closing verdict, its settlement — land as
  // it releases the lease, and the tail refresh that would have read them races
  // that release. Letting tenure end the reading freezes the walk mid-log and
  // calls it whole: the round those final rows record would be missing from a
  // list that says it holds every round the execution retained.
  it("reads the tail again when the run it was watching releases its lease", async () => {
    const execution = createWorkflowExecution({
      id: "execution-tenure",
      status: "running",
    });
    const walked = {
      occurredAt: "2026-08-14T15:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-context-status" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        status: "running" as const,
        remainingTaskCount: 1,
        iterationCount: 1,
      },
    };
    // Written as the run finished, after the walk froze and after the last tail
    // read this panel got while the run still held its lease.
    const closingRound = {
      occurredAt: "2026-08-14T15:20:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: true,
        summary: "cohort passed",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 4,
        specialists: [],
      },
    };
    const settled = {
      ...execution,
      status: "completed" as const,
      completedAt: "2026-08-14T15:21:00.000Z",
    };

    // Held open so the tab can be read after the lease ends and while the tail
    // that answers for the run's last rows is still in flight.
    let completeTail = () => {};
    const tailRead = new Promise<void>((resolve) => {
      completeTail = resolve;
    });
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      // Served rather than seeded: a walk the panel did not watch land is one it
      // withholds and reads again, which is not what this test is about.
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        return jsonResponse({
          events: [{ ...walked, seq: 1 }],
          nextCursor: null,
        });
      }
      if (url.includes("/graph-workflow/events")) {
        await tailRead;
        return jsonResponse({ events: [walked, closingRound] });
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
      execution,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [walked],
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, execution.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const planNode = (await screen.findByText("Plan")).closest(
      ".react-flow__node",
    );
    expect(planNode).not.toBeNull();
    fireEvent.click(planNode as HTMLElement);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    await waitFor(() => {
      expect(screen.getByTestId("validation-rounds")).toBeVisible();
    });
    expect(screen.queryByText(/round 4/)).toBeNull();

    // The run settles: the active endpoint still answers with it, but it holds
    // the lease no longer.
    act(() => {
      queryClient.setQueryData(
        graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
        settled,
      );
    });
    // Replacing the run's record clears the canvas selection, so the context is
    // opened again to read what its History says now.
    const settledNode = (await screen.findByText("Plan")).closest(
      ".react-flow__node",
    );
    fireEvent.click(settledNode as HTMLElement);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });

    await act(async () => {
      completeTail();
      await tailRead;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
    });
    expect(screen.getByText(/round 4/)).toBeVisible();
  });

  // A context reset is the one operation that rewrites rows already written: it
  // retires every row of its context. SSE refreshes the bounded tail, but the
  // walked pages are deliberately never invalidated, so their retirement flags
  // are a snapshot — and a reset of a context whose rows have since fallen out
  // of the tail leaves that snapshot saying `preReset: false` forever. Its
  // retired rounds would then be listed as the current attempt's.
  it("walks the log again when the record moves while a reset could rewrite it", async () => {
    const execution = createWorkflowExecution({
      id: "execution-retired",
      status: "halted",
    });
    const walkedRound = {
      seq: 2,
      occurredAt: "2026-08-14T15:10:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };
    // Everything this context wrote is retired by the reset — the walk is the
    // only window that holds these rows, so only a fresh walk says so.
    const retiredPage = {
      events: [{ ...walkedRound, preReset: true }],
      nextCursor: null,
    };
    const afterReset = {
      ...execution,
      status: "paused" as const,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...execution.contextStates["context-plan"]!,
          iterationCount: 0,
        },
      },
    };

    // Held open so the tab can be read while the fresh walk is still in flight.
    let completeWalk = () => {};
    const rewalked = new Promise<void>((resolve) => {
      completeWalk = resolve;
    });
    // The panel describes only a walk whose read it watched land, so the first
    // walk is one it takes for itself rather than one seeded into the cache.
    // Only the walk that FOLLOWS the reset is held open.
    let walks = 0;
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        walks += 1;
        if (walks === 1) {
          return jsonResponse({ events: [walkedRound], nextCursor: null });
        }
        await rewalked;
        return jsonResponse(retiredPage);
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
      execution,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, execution.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const planNode = (await screen.findByText("Plan")).closest(
      ".react-flow__node",
    );
    fireEvent.click(planNode as HTMLElement);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    await waitFor(() => {
      expect(screen.getByText(/round 1/)).toBeVisible();
    });

    // The operator resets the context: the record moves, and every row this
    // context wrote is retired behind it.
    act(() => {
      queryClient.setQueryData(
        graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
        afterReset,
      );
    });

    // Replacing the run's record clears the canvas selection, so the context is
    // opened again to read what its History says now.
    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });

    await act(async () => {
      completeWalk();
      await rewalked;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
    });
    expect(screen.queryByText(/round 1/)).toBeNull();
    expect(screen.getByTestId("validation-rounds")).toHaveTextContent(
      /No validation has run for this context yet/i,
    );
  });

  // The failure mode of the walk above. A walk that could not be taken leaves
  // the previous one's rows in the cache, and those rows are exactly the ones
  // the reset retired: presenting them again would list a retired round as part
  // of the attempt running now.
  it("does not fall back on the walk it holds when a fresh walk fails", async () => {
    const execution = createWorkflowExecution({
      id: "execution-walk-failed",
      status: "halted",
    });
    const walkedRound = {
      seq: 2,
      occurredAt: "2026-08-14T15:10:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };
    const afterReset = {
      ...execution,
      status: "paused" as const,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...execution.contextStates["context-plan"]!,
          iterationCount: 0,
        },
      },
    };

    let failWalk = () => {};
    const walkAttempted = new Promise<void>((resolve) => {
      failWalk = resolve;
    });
    // The walk the panel takes for itself lands, so the rows it holds are rows
    // it can vouch for. The walk the reset calls for is the one that fails.
    let walks = 0;
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        walks += 1;
        if (walks === 1) {
          return jsonResponse({ events: [walkedRound], nextCursor: null });
        }
        await walkAttempted;
        return jsonResponse({ error: "unavailable" }, 503);
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
      execution,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, execution.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    await waitFor(() => {
      expect(screen.getByText(/round 1/)).toBeVisible();
    });

    act(() => {
      queryClient.setQueryData(
        graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
        afterReset,
      );
    });
    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    await act(async () => {
      failWalk();
      await walkAttempted;
    });

    // The walk failed, so what the panel holds is a read of the log taken
    // before the reset. It says so instead of describing it.
    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });
    expect(screen.queryByText(/round 1/)).toBeNull();
  });

  // The reset's own evidence reaches the tail before the execution record is
  // read again: the tail is re-read on the SSE that follows and returns rows the
  // walk holds as live marked retired. Rows the tail does not reach are retired
  // just the same, and the walk is the only window holding them.
  it("stops describing the log when the tail returns a row the walk holds as live retired", async () => {
    const execution = createWorkflowExecution({
      id: "execution-retired-tail",
      status: "paused",
    });
    const retiredRound = {
      seq: 1,
      occurredAt: "2026-08-14T15:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };
    // Inside the tail's window, so both read it — and they disagree.
    const shared = {
      seq: 2,
      occurredAt: "2026-08-14T15:10:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-context-status" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        status: "running" as const,
        remainingTaskCount: 1,
        iterationCount: 1,
      },
    };

    let completeWalk = () => {};
    const rewalked = new Promise<void>((resolve) => {
      completeWalk = resolve;
    });
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        await rewalked;
        return jsonResponse({
          events: [
            { ...retiredRound, preReset: true },
            { ...shared, preReset: true },
          ],
          nextCursor: null,
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
      execution,
    );
    // The tail has already been re-read; the record and the walk have not.
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [{ occurredAt: shared.occurredAt, preReset: true, event: shared.event }],
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.pages(PROJECT_NAME, SESSION_NAME, execution.id),
      {
        pages: [{ events: [retiredRound, shared], nextCursor: null }],
        pageParams: [null],
      },
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, execution.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
      /reading the execution log/i,
    );
    expect(screen.queryByText(/round 1/)).toBeNull();

    await act(async () => {
      completeWalk();
      await rewalked;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
    });
    expect(screen.queryByText(/round 1/)).toBeNull();
  });

  // A context quiet for longer than the tail window leaves no overlapping row
  // for a retirement to be read off, so the reset reaches this panel only
  // through the record. The SSE that follows invalidates the record and the
  // tail together — and the tail can land first. Until the record it is being
  // read against has landed too, the panel is holding a walk it already knows
  // may have been rewritten, and it says so instead of describing it.
  it("stops describing the log while the record it walked against is being read again", async () => {
    const base = createWorkflowExecution({
      id: "execution-quiet-reset",
      status: "paused",
    });
    const execution = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          iterationCount: 3,
        },
      },
    };
    const staleRound = {
      seq: 1,
      occurredAt: "2026-08-14T09:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };
    const afterReset = {
      ...execution,
      contextStates: {
        ...execution.contextStates,
        "context-plan": {
          ...execution.contextStates["context-plan"]!,
          iterationCount: 0,
        },
      },
    };

    let landRecord = () => {};
    const recordRead = new Promise<void>((resolve) => {
      landRecord = resolve;
    });
    let completeWalk = () => {};
    const rewalked = new Promise<void>((resolve) => {
      completeWalk = resolve;
    });
    // The panel takes its own first walk — a walk seeded into the cache is one
    // it never watched land and would withhold on those grounds alone.
    let walks = 0;
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        walks += 1;
        if (walks === 1) {
          return jsonResponse({ events: [staleRound], nextCursor: null });
        }
        await rewalked;
        return jsonResponse({
          events: [{ ...staleRound, preReset: true }],
          nextCursor: null,
        });
      }
      if (url.includes("/graph-workflow/execution")) {
        await recordRead;
        return jsonResponse({ execution: afterReset });
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
      execution,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, execution.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    // The two reads agree so far, so the log is described.
    await waitFor(() => {
      expect(screen.getByText(/round 1/)).toBeVisible();
    });

    // The reset's SSE: the record is invalidated, and the read of it is still
    // in flight when the tab is next painted.
    act(() => {
      void queryClient.invalidateQueries({
        queryKey: graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });
    expect(screen.queryByText(/round 1/)).toBeNull();

    // The record lands, the walk is taken again against it, and what comes back
    // is the retired row.
    await act(async () => {
      landRecord();
      await recordRead;
    });
    await act(async () => {
      completeWalk();
      await rewalked;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
    });
    expect(screen.queryByText(/round 1/)).toBeNull();
  });

  // The re-walk that replaces a stale walk is started from an effect, and an
  // effect runs only AFTER the render that used the walk has been committed. So
  // the record landing must withhold the walk in the SAME render, or the commit
  // in between paints the retired round as current on the way past — briefly,
  // and as fact.
  //
  // Asserted frame by frame rather than on the settled DOM, because the settled
  // DOM is identical either way: the re-walk starts a moment later and hides the
  // round again. `Profiler.onRender` fires during commit with the DOM already
  // mutated, so it sees exactly what each frame put on screen.
  it("never paints a round from a walk the execution record has moved past", async () => {
    const seed = createWorkflowExecution({
      id: "execution-frame-reset",
      status: "paused",
    });
    // The pre-reset record must differ from the post-reset one in fact, not just
    // in identity: React Query keeps the object it already holds when a refetch
    // is deep-equal, and two records that agree would be the same reference.
    const base = {
      ...seed,
      contextStates: {
        ...seed.contextStates,
        "context-plan": {
          ...seed.contextStates["context-plan"]!,
          iterationCount: 3,
        },
      },
    };
    const staleRound = {
      seq: 1,
      occurredAt: "2026-08-14T09:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: base.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };
    // The record after the reset: a different object, as a refetch that actually
    // changed something returns.
    const afterReset = {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...base.contextStates["context-plan"]!,
          iterationCount: 0,
        },
      },
    };

    let landRecord = () => {};
    const recordRead = new Promise<void>((resolve) => {
      landRecord = resolve;
    });
    // The panel takes its own first walk, so the round on screen is one it
    // vouched for against `base`. The re-walk the reset calls for never lands,
    // so anything painted after the record moved came from the walk in hand.
    let walks = 0;
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        walks += 1;
        if (walks === 1) {
          return jsonResponse({ events: [staleRound], nextCursor: null });
        }
        await new Promise(() => {});
      }
      if (url.includes("/graph-workflow/execution")) {
        await recordRead;
        return jsonResponse({ execution: afterReset });
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
      base,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, base.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, base.id),
      null,
    );

    const frames: boolean[] = [];
    const showsRound = () => /round 1/i.test(document.body.textContent ?? "");
    render(
      <Profiler
        id="panel"
        onRender={() => {
          frames.push(showsRound());
        }}
      >
        <QueryClientProvider client={queryClient}>
          <ConnectedGraphWorkflowPanel
            projectName={PROJECT_NAME}
            sessionName={SESSION_NAME}
            selectedExecutionId={base.id}
            isMobile={false}
            mobilePanel="graph"
            autoSwitchPanel={vi.fn()}
          />
        </QueryClientProvider>
      </Profiler>,
    );

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    // The two reads agree so far, so the round is on screen — without this the
    // test could pass on a panel that never renders a round at all.
    await waitFor(() => {
      expect(showsRound()).toBe(true);
    });

    // The reset's SSE invalidates the record, and the read of it lands.
    await act(async () => {
      void queryClient.invalidateQueries({
        queryKey: graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
      });
    });
    frames.length = 0;
    await act(async () => {
      landRecord();
      await recordRead;
    });

    // Every frame committed since the record moved, and the settled DOM.
    expect(frames.length).toBeGreaterThan(0);
    expect(frames).not.toContain(true);
    expect(showsRound()).toBe(false);
  });

  // The panel is not the only reader of the execution record, and it does not
  // outlive the cache. Closed and reopened — a tab switch, a route change, a
  // remount — it comes back to a walk it never watched being read, cached under
  // its own key and still fresh, while the record has meanwhile been refreshed
  // past a reset by somebody else. Nothing the panel holds says which side of
  // that reset the walk was taken on, and for a context quiet longer than the
  // tail window there is no overlapping row left to disagree about either. A
  // walk of unknown provenance is therefore not a walk this panel may describe:
  // it re-reads it first.
  it("does not describe a cached walk it never watched being read", async () => {
    const seed = createWorkflowExecution({
      id: "execution-remount-reset",
      status: "paused",
    });
    // The record as it stands AFTER the reset — the only one this mount ever
    // sees, because the refresh that carried the reset happened while the panel
    // was gone.
    const afterReset = {
      ...seed,
      contextStates: {
        ...seed.contextStates,
        "context-plan": {
          ...seed.contextStates["context-plan"]!,
          iterationCount: 0,
        },
      },
    };
    // The walk left in the cache from before the reset, still holding the round
    // as live. The context has been quiet for longer than the tail window, so
    // the tail holds none of its rows and cannot contradict it.
    const retiredRound = {
      seq: 1,
      occurredAt: "2026-08-14T09:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: seed.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };

    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        // The re-read never lands, so anything on screen came from the walk
        // that was already in the cache.
        await new Promise(() => {});
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
      afterReset,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, afterReset.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.pages(PROJECT_NAME, SESSION_NAME, afterReset.id),
      {
        pages: [{ events: [retiredRound], nextCursor: null }],
        pageParams: [null],
      },
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, afterReset.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={afterReset.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });
    expect(screen.queryByText(/round 1/)).toBeNull();
    // Withholding it is only half the answer: the walk of unknown provenance
    // has to be replaced, not merely hidden.
    expect(
      fetchSpy.mock.calls.some(([input]) =>
        String(input).includes("page=true"),
      ),
    ).toBe(true);
  });

  // Finishing a walk is not re-reading it. An inherited walk that still has
  // pages to fetch is completed by appending OLDER pages, and every append is a
  // successful read of the query — the read stamp moves each time. But the
  // pages already in hand are never touched by it, and those are exactly the
  // pages a reset would have retired. A walk may only be vouched for once the
  // rows it already held have themselves been read again.
  it("does not vouch for an inherited walk merely because its pagination finished", async () => {
    const seed = createWorkflowExecution({
      id: "execution-partial-walk",
      status: "paused",
    });
    const afterReset = {
      ...seed,
      contextStates: {
        ...seed.contextStates,
        "context-plan": {
          ...seed.contextStates["context-plan"]!,
          iterationCount: 0,
        },
      },
    };
    // The retired round sits in the page the mount INHERITED, so only a read of
    // that page can correct it. The page fetched to finish the walk is older
    // and carries nothing about it.
    const retiredRound = {
      seq: 2,
      occurredAt: "2026-08-14T09:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: seed.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };

    const walkUrls: string[] = [];
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        walkUrls.push(url);
        // The page that finishes the walk. A full re-read would start from the
        // top with no cursor; this never lands, so anything on screen came
        // from the inherited page.
        if (url.includes("cursor=")) {
          return jsonResponse({ events: [], nextCursor: null });
        }
        await new Promise(() => {});
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
      afterReset,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, afterReset.id),
      [],
    );
    // One page in hand and another still to come: the walk the panel inherits
    // is PARTIAL, so finishing it moves the read stamp without re-reading it.
    queryClient.setQueryData(
      graphWorkflowEventsKeys.pages(PROJECT_NAME, SESSION_NAME, afterReset.id),
      {
        pages: [{ events: [retiredRound], nextCursor: 1 }],
        pageParams: [null],
      },
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, afterReset.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={afterReset.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    // The appended page arrives and the walk is finished, which is the moment
    // a stamp-only rule would call it proven.
    await waitFor(() => {
      expect(walkUrls.some((url) => url.includes("cursor="))).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });
    expect(screen.queryByText(/round 1/)).toBeNull();
    // And the pages it inherited are actually read again — a walk starting from
    // the top, with no cursor.
    await waitFor(() => {
      expect(
        walkUrls.filter((url) => !url.includes("cursor=")).length,
      ).toBeGreaterThan(0);
    });
  });

  // Whether a reset could happen NOW is the wrong question to ask of a walk.
  // The retirement that condemns an inherited walk happened in the PAST, and a
  // run that was reset while this panel was away may well have been resumed
  // before it came back. The rows stay retired; only the run's status moved on.
  // So a walk of unknown vintage is re-read whatever the run is doing.
  it("does not describe an inherited walk for a run that has since resumed", async () => {
    const resumed = createWorkflowExecution({
      id: "execution-resumed-after-reset",
      status: "running",
    });
    // Retired by a reset this panel never saw, and older than the tail window,
    // so no overlapping row is left to disagree about it.
    const retiredRound = {
      seq: 1,
      occurredAt: "2026-08-14T09:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: resumed.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };

    let walkAsked = false;
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        walkAsked = true;
        // Never lands, so anything on screen came from the inherited walk.
        await new Promise(() => {});
      }
      if (url.includes("/graph-workflow/events")) {
        return jsonResponse({ events: [] });
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
      resumed,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, resumed.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.pages(PROJECT_NAME, SESSION_NAME, resumed.id),
      {
        pages: [{ events: [retiredRound], nextCursor: null }],
        pageParams: [null],
      },
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, resumed.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={resumed.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });
    expect(screen.queryByText(/round 1/)).toBeNull();
    expect(walkAsked).toBe(true);
  });

  // The panel need not be away for a reset to pass it by. Another client can
  // pause the run, reset a context and resume it while this panel's own record
  // read is still in flight — and React Query then hands it only the far side of
  // that excursion, a record reading "running" exactly as the one before it did.
  // Whether a reset is admissible NOW answers no, and the walk it retired is
  // sitting in a cache SSE deliberately never invalidates. What the round trip
  // cannot hide is where the record has BEEN: leaving `running` retires a loop
  // generation and resuming starts another, so the record carries the park it
  // went through even where nobody watched it happen.
  it("walks the log again when the record it was read against went round a park and back", async () => {
    const execution = createWorkflowExecution({
      id: "execution-park-and-back",
      status: "running",
    });
    const walkedRound = {
      seq: 2,
      occurredAt: "2026-08-14T15:10:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: execution.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };
    // The context has been quiet for longer than the tail window, so its retired
    // rows live in the walk alone and no overlapping row is left to disagree
    // about them. Only a fresh walk can say they are retired.
    const retiredPage = {
      events: [{ ...walkedRound, preReset: true }],
      nextCursor: null,
    };
    // The run as it comes back: still running, and running the loop generation
    // the resume started rather than the one the walk was read under.
    const afterParkAndBack = {
      ...execution,
      loopEpoch: execution.loopEpoch + 2,
    };

    let completeWalk = () => {};
    const rewalked = new Promise<void>((resolve) => {
      completeWalk = resolve;
    });
    // Served rather than seeded, so the first walk is one this panel watched
    // land and can vouch for. Only the walk that follows is held open.
    let walks = 0;
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        walks += 1;
        if (walks === 1) {
          return jsonResponse({ events: [walkedRound], nextCursor: null });
        }
        await rewalked;
        return jsonResponse(retiredPage);
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
      execution,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, execution.id),
      null,
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={execution.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    await waitFor(() => {
      expect(screen.getByText(/round 1/)).toBeVisible();
    });

    // The record read this panel invalidated finally lands, carrying the whole
    // excursion — pause, reset and resume — as one move.
    act(() => {
      queryClient.setQueryData(
        graphWorkflowExecutionKeys.detail(PROJECT_NAME, SESSION_NAME),
        afterParkAndBack,
      );
    });

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));
    await waitFor(() => {
      expect(screen.getByTestId("history-evidence-pending")).toHaveTextContent(
        /reading the execution log/i,
      );
    });
    expect(walks).toBeGreaterThan(1);

    await act(async () => {
      completeWalk();
      await rewalked;
    });
    await waitFor(() => {
      expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
    });
    expect(screen.queryByText(/round 1/)).toBeNull();
    expect(screen.getByTestId("validation-rounds")).toHaveTextContent(
      /No validation has run for this context yet/i,
    );
  });

  // A reset is refused for any execution that is not the session's active
  // record, so a run read by id can never be reset however it is halted — its
  // walk needs no watching. Gating it on the ACTIVE-execution query reads a
  // record that has nothing to do with the run on screen: that query answers
  // for whatever the session holds NOW, and its being slow or broken says
  // nothing about a settled run whose own record and log are already in hand.
  it("describes a historical halted run's log while the active-execution query is unread", async () => {
    const historical = createWorkflowExecution({
      id: "execution-historical-halt",
      status: "halted",
    });
    const round = {
      seq: 1,
      occurredAt: "2026-08-14T09:00:00.000Z",
      preReset: false,
      event: {
        type: "graph-workflow-validation-result" as const,
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        executionId: historical.id,
        contextId: "context-plan",
        validatorType: "context" as const,
        kind: "context_validation" as const,
        pass: false,
        summary: "cohort rejected",
        reopenTaskIds: [],
        issues: [],
        rejectedOutput: null,
        gateRepairAttempts: null,
        gateRepairBudget: null,
        roundSeq: 1,
        specialists: [],
      },
    };

    // The active-execution read never lands. Everything else the selected run
    // needs is in hand, and the walk is one this panel takes for itself.
    const fetchSpy = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/graph-workflow/events") && url.includes("page=true")) {
        return jsonResponse({ events: [round], nextCursor: null });
      }
      if (url.includes("/graph-workflow/execution")) {
        await new Promise(() => {});
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
      graphWorkflowResultKeys.latest(PROJECT_NAME, SESSION_NAME, historical.id),
      null,
    );

    render(
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

    fireEvent.click(
      (await screen.findByText("Plan")).closest(
        ".react-flow__node",
      ) as HTMLElement,
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }));

    await waitFor(() => {
      expect(screen.getByText(/round 1/)).toBeVisible();
    });
    expect(screen.queryByTestId("history-evidence-pending")).toBeNull();
  });

  it("withholds mutation authority from a lease-free run the active endpoint still answers with", async () => {
    // The active-execution endpoint keeps answering with a run after it has
    // released the lease, and the rail already shows that run under History.
    // Authority must follow tenure, not endpoint identity — otherwise selecting
    // this row mounts the mutable path on a finished run.
    const aborted = createWorkflowExecution({
      id: "execution-aborted",
      status: "aborted",
      completedAt: "2026-08-20T15:30:00.000Z",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        throw new Error(`Unexpected fetch: ${String(input)}`);
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
      aborted,
    );
    queryClient.setQueryData(
      graphWorkflowExecutionKeys.byId(PROJECT_NAME, SESSION_NAME, aborted.id),
      aborted,
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, aborted.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowEventsKeys.pages(PROJECT_NAME, SESSION_NAME, aborted.id),
      { pages: [{ events: [], nextCursor: null }], pageParams: [null] },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConnectedGraphWorkflowPanel
          projectName={PROJECT_NAME}
          sessionName={SESSION_NAME}
          selectedExecutionId={aborted.id}
          isMobile={false}
          mobilePanel="graph"
          autoSwitchPanel={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // The run is still shown — History is inspectable — but nothing may act.
    expect(await screen.findByTestId("execution-state-chip")).toHaveTextContent(
      "aborted",
    );
    for (const label of ["Pause", "Resume", "Abort", "Abandon"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }

    // Query routing is the tell that survives an empty control list: a
    // lease-free selection reads its history by walking the event pages rather
    // than leaning on the bounded live window. Reading follows the selection —
    // the tail is a read, not an authority — so it is authority, above, that
    // tenure withholds.
    expect(
      queryClient.getQueryState(
        graphWorkflowEventsKeys.pages(PROJECT_NAME, SESSION_NAME, aborted.id),
      ),
    ).toBeDefined();
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
    await userEvent.click(
      screen.getByRole("button", { name: /Execution policy/ }),
    );
    fireEvent.change(screen.getByLabelText("Max iterations"), {
      target: { value: "9" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      'Unknown validation command "premerge"',
    );
  });
});

describe("ConnectedGraphWorkflowPanel draft divergence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A run carries an immutable snapshot of the revision it launched from, and
  // the builder draft moves on without it. Every template run needs that stated
  // — a launch document says which revision ran, not whether it is still the
  // saved one.
  it("states that saved template edits do not reach a run that carries a launch document", async () => {
    const execution = createWorkflowExecution({
      id: "execution-modern",
      status: "running",
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 4,
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Launched snapshot",
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        throw new Error(`Unexpected fetch: ${String(input)}`);
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
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowHistoryKeys.list(PROJECT_NAME, SESSION_NAME),
      [],
    );
    queryClient.setQueryData(
      workflowDefinitionKeys.detail(PROJECT_NAME, "workflow-1"),
      { item: createWorkflowDefinitionRecord({ revision: 5 }) },
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

    expect(
      await screen.findByText(
        "The builder draft is r5. Saved edits do not reach this run.",
      ),
    ).toBeVisible();
  });

  // The layout a run drew with is its own. A launch document already carries
  // one, and the saved template's newer layout must not displace it.
  it("keeps drawing a launch document's own layout while it reads the saved revision", async () => {
    const execution = createWorkflowExecution({
      id: "execution-layout",
      status: "running",
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 4,
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Launched snapshot",
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
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        throw new Error(`Unexpected fetch: ${String(input)}`);
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
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowHistoryKeys.list(PROJECT_NAME, SESSION_NAME),
      [],
    );
    queryClient.setQueryData(
      workflowDefinitionKeys.detail(PROJECT_NAME, "workflow-1"),
      {
        item: createWorkflowDefinitionRecord({
          revision: 5,
          layout: {
            workflowId: "workflow-1",
            contextPositions: { "context-plan": { x: 12, y: 34 } },
            viewport: { x: 0, y: 0, zoom: 1 },
          },
        }),
      },
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

    await screen.findByText(
      "The builder draft is r5. Saved edits do not reach this run.",
    );
    const node = view.container.querySelector<HTMLElement>(
      '.react-flow__node[data-id="context-plan"]',
    );
    expect(node?.style.transform).toContain("611px");
    expect(node?.style.transform).toContain("222px");
  });

  // `origin.tier` is the persisted record of WHICH template library a run was
  // launched from. A global template and a project workflow can carry the same
  // id, so reading the project tier for a global-tier run does not merely fail
  // — it can answer with an unrelated definition and state a revision that was
  // never this run's draft.
  it("reads the global template library for a run launched from the global tier", async () => {
    const execution = createWorkflowExecution({
      id: "execution-global",
      status: "running",
      seedDefinitionId: "workflow-1",
      seedDefinitionRevision: 4,
      launchedTier: "global",
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Launched snapshot",
      }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        throw new Error(`Unexpected fetch: ${String(input)}`);
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
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(
      graphWorkflowHistoryKeys.list(PROJECT_NAME, SESSION_NAME),
      [],
    );
    queryClient.setQueryData(globalWorkflowTemplateKeys.detail("workflow-1"), {
      item: createWorkflowDefinitionRecord({ revision: 5 }),
    });
    // A same-id project workflow that is NOT this run's origin. Reading it
    // would state r9 — a revision belonging to a different definition.
    queryClient.setQueryData(
      workflowDefinitionKeys.detail(PROJECT_NAME, "workflow-1"),
      { item: createWorkflowDefinitionRecord({ revision: 9 }) },
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

    expect(
      await screen.findByText(
        "The builder draft is r5. Saved edits do not reach this run.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "The builder draft is r9. Saved edits do not reach this run.",
      ),
    ).toBeNull();
  });
});

describe("ConnectedGraphWorkflowPanel context approvals", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function runningWithTwoApprovals() {
    const base = createWorkflowExecution({
      id: "execution-gates",
      status: "running",
    });
    const planState = base.contextStates["context-plan"]!;
    const verifyState = base.contextStates["context-verify"]!;
    return {
      ...base,
      contextStates: {
        ...base.contextStates,
        "context-plan": {
          ...planState,
          status: "awaiting_approval" as const,
          pendingApproval: {
            conversationId: "conv-approval-plan",
            requestedAt: "2026-08-21T10:00:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" as const },
          },
        },
        "context-verify": {
          ...verifyState,
          status: "awaiting_approval" as const,
          pendingApproval: {
            conversationId: "conv-approval-verify",
            requestedAt: "2026-08-21T10:05:00.000Z",
            decision: null,
            approvalScope: { kind: "whole_tree" as const },
          },
        },
      },
    };
  }

  // README §10: two parked approvals are two waits on two contexts. Collecting
  // them into one stack above the canvas is the single global gate surface the
  // redesign removes — each decision belongs to the context that parked it and
  // is reached through that context's gate row.
  it("renders only the selected context's approval card", async () => {
    const execution = runningWithTwoApprovals();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.includes("/approval-snapshot")) {
          return jsonResponse({
            kind: "whole_tree",
            contextId: "context-plan",
          });
        }
        if (url.includes("/validation/commands")) {
          return jsonResponse({ commands: [] });
        }
        throw new Error(`Unexpected fetch: ${url}`);
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
      graphWorkflowEventsKeys.list(PROJECT_NAME, SESSION_NAME, execution.id),
      [],
    );
    queryClient.setQueryData(validationKeys.commands(), {
      projects: [{ projectName: PROJECT_NAME, commands: [] }],
    });
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

    // Both gates are counted, but nothing is decided on until a row is opened.
    const chip = await screen.findByRole("button", {
      name: "2 gates awaiting you",
    });
    expect(screen.queryByTestId("approval-gate-panel")).toBeNull();

    fireEvent.click(chip);
    const list = await screen.findByTestId("execution-gates-list");
    fireEvent.click(within(list).getAllByTestId("execution-gate-row")[0]!);

    const panel = await screen.findByTestId("approval-gate-panel");
    expect(within(panel).getByText("Context approval — Plan")).toBeVisible();
    // The sibling's decision is elsewhere, behind its own row.
    expect(screen.queryByText("Context approval — Verify")).toBeNull();
  });
});
