// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import WorkflowEventLog from "./WorkflowEventLog";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
} from "@/lib/workflows/schemas";
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

    expect(screen.getByText(/Join conflicts · join-2/)).toBeInTheDocument();

    await user.click(screen.getByText(/Join conflicts · join-2/));

    expect(
      screen.getByText("merge conflicts in src/foo.ts"),
    ).toBeInTheDocument();
  });
});
