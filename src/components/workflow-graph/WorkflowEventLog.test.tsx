// @vitest-environment jsdom
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import WorkflowEventLog from "./WorkflowEventLog";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowValidationResultEvent,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
function executionWithHistory(
  history: Array<Omit<GraphWorkflowExecutionEvent, "preReset">>,
): {
  execution: GraphWorkflowExecution;
  events: GraphWorkflowExecutionEvent[];
} {
  return {
    execution: createWorkflowExecution(),
    events: history.map((entry) => ({ ...entry, preReset: false })),
  };
}

const EVENT_BASE = {
  projectName: "repo",
  sessionName: "session-1",
  executionId: "exec-1",
} as const;

function statusEntry(
  occurredAt: string,
  workflowStatus: "pending" | "running" | "paused" | "halted",
  activeContextIds: string[],
): Omit<GraphWorkflowExecutionEvent, "preReset"> {
  return {
    occurredAt,
    event: {
      type: "graph-workflow-status",
      ...EVENT_BASE,
      workflowStatus,
      activeContextIds,
      activeBatchIds: [],
      activeJoinIds: [],
      haltReason: null,
      pendingHaltReason: null,
      secondaryHaltReasons: [],
    },
  };
}

function contextStatusEntry(
  occurredAt: string,
  contextId: string,
  status: "running" | "halted" | "completed" | "pending",
  iterationCount: number,
): Omit<GraphWorkflowExecutionEvent, "preReset"> {
  return {
    occurredAt,
    event: {
      type: "graph-workflow-context-status",
      ...EVENT_BASE,
      contextId,
      status,
      remainingTaskCount: 1,
      iterationCount,
    },
  };
}

function laneEntry(
  occurredAt: string,
  laneId: string,
  status: "active" | "merged" | "halted",
): Omit<GraphWorkflowExecutionEvent, "preReset"> {
  return {
    occurredAt,
    event: {
      type: "graph-workflow-lane-status",
      ...EVENT_BASE,
      laneId,
      kind: "worktree",
      status,
      branchName: "csm/feature-lane-plan",
      worktreePath: null,
      includedContextIds: [],
      lastCommittingContextId: null,
    },
  };
}

describe("WorkflowEventLog collapsing of redundant same-status events", () => {
  it("renders a single 'Workflow running' row when consecutive status events re-affirm running with only active-set changes", () => {
    const { execution, events } = executionWithHistory([
      statusEntry("2026-04-02T08:00:00.000Z", "pending", []),
      statusEntry("2026-04-02T08:00:01.000Z", "running", []),
      statusEntry("2026-04-02T08:00:02.000Z", "running", ["context-plan"]),
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    expect(screen.getAllByText("Workflow running")).toHaveLength(1);
    expect(screen.getByText("Workflow pending")).toBeInTheDocument();
  });

  it("collapses two context 'started' rows that re-fire across an interleaved lane event into one", () => {
    const { execution, events } = executionWithHistory([
      contextStatusEntry(
        "2026-04-02T08:00:00.000Z",
        "context-plan",
        "running",
        0,
      ),
      laneEntry("2026-04-02T08:00:01.000Z", "lane-plan", "active"),
      contextStatusEntry(
        "2026-04-02T08:00:02.000Z",
        "context-plan",
        "running",
        1,
      ),
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    expect(screen.getAllByText("Plan · started")).toHaveLength(1);
    expect(screen.getByText(/Lane active · lane-plan/)).toBeInTheDocument();
  });

  it("keeps both 'started' rows when a context restarts after a halt, since the halt is a real intervening transition", () => {
    const { execution, events } = executionWithHistory([
      contextStatusEntry(
        "2026-04-02T08:00:00.000Z",
        "context-plan",
        "running",
        0,
      ),
      contextStatusEntry(
        "2026-04-02T08:00:01.000Z",
        "context-plan",
        "halted",
        0,
      ),
      contextStatusEntry(
        "2026-04-02T08:00:02.000Z",
        "context-plan",
        "running",
        1,
      ),
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    expect(screen.getAllByText("Plan · started")).toHaveLength(2);
    expect(screen.getByText("Plan · halted")).toBeInTheDocument();
  });

  it("renders the delivery-approval halt as its headline only — no remediation link in the log", async () => {
    const { execution, events } = executionWithHistory([
      {
        occurredAt: "2026-04-02T08:00:00.000Z",
        event: {
          type: "graph-workflow-status",
          ...EVENT_BASE,
          workflowStatus: "halted",
          activeContextIds: [],
          activeBatchIds: [],
          activeJoinIds: [],
          haltReason: {
            type: "delivery_gate_failed",
            unmet: [],
            instruction:
              "Approve delivery in Spec Studio: open the spec's Controls view → Merge gate → Approve delivery for merge, then resume the merge.",
            refusalCode: "approval_required",
            spec: {
              specSlug: "audit-log",
              specName: "Audit Log",
              projectName: "command-center",
            },
          },
          pendingHaltReason: null,
          secondaryHaltReasons: [],
        },
      },
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    await userEvent.click(screen.getByText("Workflow halted"));

    expect(
      screen.getByText("Delivery gate — waiting on your approval"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Open the merge gate/ }),
    ).not.toBeInTheDocument();
  });
});

describe("WorkflowEventLog rendering of lane/join events", () => {
  it("renders a graph-workflow-lane-status event title with lane identity so operators can read lane progress in the activity log", () => {
    const { execution, events } = executionWithHistory([
      {
        occurredAt: "2026-04-02T08:00:00.000Z",
        event: {
          type: "graph-workflow-lane-status",
          projectName: "repo",
          sessionName: "session-1",
          executionId: "exec-1",
          laneId: "lane-plan",
          kind: "worktree",
          status: "merged",
          branchName: "csm/feature-lane-plan",
          worktreePath: "/repo/.worktrees/feature.lane-plan",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
        },
      },
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    expect(
      screen.getByText(/Lane merged · lane-plan \(csm\/feature-lane-plan\)/),
    ).toBeInTheDocument();
  });

  it("reveals lane member contexts and last-committer in expanded detail so operators can drill into a lane event", async () => {
    const user = userEvent.setup();
    const { execution, events } = executionWithHistory([
      {
        occurredAt: "2026-04-02T08:00:00.000Z",
        event: {
          type: "graph-workflow-lane-status",
          projectName: "repo",
          sessionName: "session-1",
          executionId: "exec-1",
          laneId: "lane-plan",
          kind: "worktree",
          status: "merged",
          branchName: "csm/feature-lane-plan",
          worktreePath: "/repo/.worktrees/feature.lane-plan",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
        },
      },
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    await user.click(screen.getByText(/Lane merged · lane-plan/));

    expect(screen.getByText(/members: Plan/)).toBeInTheDocument();
    expect(screen.getByText(/last commit: Plan/)).toBeInTheDocument();
  });

  it("renders a graph-workflow-join-status event title with status and id so operators can read join progress in the activity log", () => {
    const { execution, events } = executionWithHistory([
      {
        occurredAt: "2026-04-02T08:01:00.000Z",
        event: {
          type: "graph-workflow-join-status",
          projectName: "repo",
          sessionName: "session-1",
          executionId: "exec-1",
          joinId: "join-1",
          kind: "context_merge",
          contextId: null,
          status: "running",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: ["lane-a"],
          targetLaneId: "lane-target",
          errorMessage: null,
          conflicts: null,
        },
      },
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    expect(screen.getByText(/Join running · join-1/)).toBeInTheDocument();
  });

  it("reveals source->target and merged-source progress in expanded detail when a running join row is opened", async () => {
    const user = userEvent.setup();
    const { execution, events } = executionWithHistory([
      {
        occurredAt: "2026-04-02T08:01:00.000Z",
        event: {
          type: "graph-workflow-join-status",
          projectName: "repo",
          sessionName: "session-1",
          executionId: "exec-1",
          joinId: "join-1",
          kind: "context_merge",
          contextId: null,
          status: "running",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: ["lane-a"],
          targetLaneId: "lane-target",
          errorMessage: null,
          conflicts: null,
        },
      },
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    await user.click(screen.getByText(/Join running · join-1/));

    expect(
      screen.getByText(/sources: lane-a, lane-b -> lane-target/),
    ).toBeInTheDocument();
    expect(screen.getByText(/merged: lane-a/)).toBeInTheDocument();
  });

  it("surfaces the failure error message in expanded detail when a join-status event reports a conflicts outcome", async () => {
    const user = userEvent.setup();
    const { execution, events } = executionWithHistory([
      {
        occurredAt: "2026-04-02T08:02:00.000Z",
        event: {
          type: "graph-workflow-join-status",
          projectName: "repo",
          sessionName: "session-1",
          executionId: "exec-1",
          joinId: "join-2",
          kind: "final_publish",
          contextId: null,
          status: "conflicts",
          sourceLaneIds: ["lane-plan"],
          mergedSourceLaneIds: [],
          targetLaneId: "__session__",
          errorMessage: "merge conflicts in src/foo.ts",
          conflicts: {
            files: ["src/foo.ts"],
            message: "merge conflicts in src/foo.ts",
            analysis: null,
          },
        },
      },
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    expect(
      screen.getByText(/Session publish conflicts · join-2/),
    ).toBeInTheDocument();

    await user.click(screen.getByText(/Session publish conflicts · join-2/));

    expect(
      screen.getByText("merge conflicts in src/foo.ts"),
    ).toBeInTheDocument();
  });

  it("describes a final-publish join as publishing to the session without exposing the internal enum", async () => {
    const user = userEvent.setup();
    const { execution, events } = executionWithHistory([
      {
        occurredAt: "2026-04-02T08:03:00.000Z",
        event: {
          type: "graph-workflow-join-status",
          projectName: "repo",
          sessionName: "session-1",
          executionId: "exec-1",
          joinId: "join-final",
          kind: "final_publish",
          contextId: null,
          status: "running",
          sourceLaneIds: ["lane-plan"],
          mergedSourceLaneIds: [],
          targetLaneId: "__session__",
          errorMessage: null,
          conflicts: null,
        },
      },
    ]);

    render(<WorkflowEventLog execution={execution} events={events} />);

    await user.click(screen.getByText(/Session publish running · join-final/));

    expect(screen.getByText(/kind: session publish/)).toBeInTheDocument();
    expect(screen.queryByText(/final_publish/)).not.toBeInTheDocument();
  });
});

describe("WorkflowEventLog canonical compact Markdown", () => {
  function taskCompletedEntry(
    occurredAt: string,
    summary: string,
  ): Omit<GraphWorkflowExecutionEvent, "preReset"> {
    return {
      occurredAt,
      event: {
        type: "graph-workflow-task-status",
        ...EVENT_BASE,
        contextId: "context-plan",
        taskId: "task-plan-1",
        status: "completed",
        source: "agent",
        order: 1,
        summary,
      },
    };
  }

  function validationEntry(
    occurredAt: string,
    overrides: Partial<GraphWorkflowValidationResultEvent> = {},
  ): Omit<GraphWorkflowExecutionEvent, "preReset"> {
    return {
      occurredAt,
      event: {
        type: "graph-workflow-validation-result",
        ...EVENT_BASE,
        contextId: "context-plan",
        validatorType: "context",
        pass: true,
        summary: "All good",
        issues: [],
        reopenTaskIds: [],
        ...overrides,
      },
    };
  }

  function compactRoots(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-markdown-intent="compact"]',
      ),
    );
  }

  it("renders a completed task summary through the compact adapter with full GFM once expanded", async () => {
    const { execution, events } = executionWithHistory([
      taskCompletedEntry(
        "2026-04-02T08:00:00.000Z",
        "Uses ~~legacy~~ **canonical** rendering.",
      ),
    ]);

    const { container } = render(
      <WorkflowEventLog execution={execution} events={events} />,
    );

    await userEvent.setup().click(screen.getByText(/Task completed/));

    await waitFor(() => expect(compactRoots(container).length).toBe(1));
    // No migrated surface still leans on the generated-descendant CSS hook.
    expect(container.querySelector(".wb-markdown-inline")).toBeNull();
    expect(screen.getByText("legacy").tagName).toBe("DEL");
    expect(screen.getByText("canonical").tagName).toBe("STRONG");
  });

  it("renders a validation summary and its issue descriptions through the compact adapter", async () => {
    const { execution, events } = executionWithHistory([
      validationEntry("2026-04-02T08:01:00.000Z", {
        pass: false,
        summary: "Blocked on `handleSubmit`",
        issues: [
          {
            taskId: "task-plan-1",
            title: "Missing coverage",
            description: "No test for the ~~old~~ **new** path.",
          },
        ],
      }),
    ]);

    const { container } = render(
      <WorkflowEventLog execution={execution} events={events} />,
    );

    await userEvent.setup().click(screen.getByText(/Validation failed/));

    // Summary (detail) + issue description both route through the adapter.
    await waitFor(() => expect(compactRoots(container).length).toBe(2));
    expect(container.querySelector(".wb-markdown-inline")).toBeNull();

    const summaryCode = screen.getByText("handleSubmit");
    expect(summaryCode.closest("code")).not.toBeNull();
    const issue = screen.getByText("Missing coverage").closest("li");
    expect(issue).not.toBeNull();
    expect(within(issue as HTMLElement).getByText("new").tagName).toBe(
      "STRONG",
    );
  });

  it("scopes host issue-item styling to the host li and title, never leaking into generated Markdown descendants", async () => {
    const { execution, events } = executionWithHistory([
      validationEntry("2026-04-02T08:01:00.000Z", {
        pass: false,
        summary: "Blocked",
        issues: [
          {
            taskId: "task-plan-1",
            title: "Missing coverage",
            description: "Steps:\n\n- add a **bold** case\n- cover the edge",
          },
        ],
      }),
    ]);

    const { container } = render(
      <WorkflowEventLog execution={execution} events={events} />,
    );

    await userEvent.setup().click(screen.getByText(/Validation failed/));

    // Summary (detail) + issue description both route through the adapter.
    await waitFor(() => expect(compactRoots(container).length).toBe(2));

    // The issue description's Markdown list renders its own <li>/<strong>
    // inside the canonical root — that is the generated content we must not style.
    const issueRoot = compactRoots(container)[1] as HTMLElement;
    expect(issueRoot.querySelectorAll("li").length).toBeGreaterThan(0);
    expect(issueRoot.querySelector("strong")?.textContent).toBe("bold");

    // The host list container must not reach into descendants, so no generated
    // <li>/<strong> inside CompactMarkdown inherits host spacing/typography.
    const hostList = screen.getByText("Missing coverage").closest("ul");
    expect(hostList).not.toBeNull();
    const hostListClass = hostList?.className ?? "";
    expect(hostListClass).not.toMatch(/_li\]/);
    expect(hostListClass).not.toMatch(/_strong\]/);

    // Host-authored issue item + title carry their styling directly.
    const hostItem = screen.getByText("Missing coverage").closest("li");
    expect(hostItem?.className.length ?? 0).toBeGreaterThan(0);
    const hostTitle = screen.getByText("Missing coverage");
    expect(hostTitle.tagName).toBe("STRONG");
    expect(hostTitle.className.length).toBeGreaterThan(0);
  });
});
