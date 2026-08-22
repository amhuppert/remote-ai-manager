// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { renderWithQuery } from "@/test/component-mocks";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionHistoryItem,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  makeLaunchDocument,
} from "@/lib/workflow-graph/test-fixtures";
import {
  graphWorkflowExecutionKeys,
  graphWorkflowResultKeys,
} from "@/lib/workflows/query-keys";
import ArchivedExecutionsList from "./ArchivedExecutionsList";

const resumableHalt: GraphWorkflowHaltReason = {
  type: "agent_turn_failed",
  contextId: "context-plan",
  engine: "claude",
  cause: "sdk_error",
  message: "SDK stream ended unexpectedly",
};

const nonResumableHalt: GraphWorkflowHaltReason = {
  type: "recovery_error",
  message: "Recovery failed",
};

function makeItem(
  overrides: Partial<GraphWorkflowExecutionHistoryItem> = {},
): GraphWorkflowExecutionHistoryItem {
  return {
    executionId: "exec-1",
    definitionId: "wf-1",
    definitionRevision: 2,
    status: "completed",
    startedAt: "2026-03-01T00:00:00.000Z",
    completedAt: "2026-03-02T00:00:00.000Z",
    haltReason: null,
    archived: true,
    ...overrides,
  };
}

/** A client that answers every row's lookups from cache rather than the network. */
function seededClient(executions: GraphWorkflowExecution[]): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  for (const execution of executions) {
    client.setQueryData(
      graphWorkflowExecutionKeys.byId("proj", "sess", execution.id),
      execution,
    );
    client.setQueryData(
      graphWorkflowResultKeys.detail("proj", "sess", execution.id, null),
      null,
    );
  }
  return client;
}

function renderRail(
  props: {
    current?: GraphWorkflowExecution | null;
    executions?: GraphWorkflowExecutionHistoryItem[];
    sessionConversationIds?: ReadonlySet<string> | null;
    selectedExecutionId?: string | null;
    onSelect?: (executionId: string) => void;
    onCollapse?: () => void;
  } = {},
  client?: QueryClient,
) {
  return renderWithQuery(
    <ArchivedExecutionsList
      projectName="proj"
      sessionName="sess"
      current={props.current ?? null}
      executions={props.executions ?? []}
      sessionConversationIds={props.sessionConversationIds ?? new Set()}
      selectedExecutionId={props.selectedExecutionId ?? null}
      onSelect={props.onSelect ?? vi.fn()}
      {...(props.onCollapse === undefined
        ? {}
        : { onCollapse: props.onCollapse })}
    />,
    client,
  );
}

describe("Executions rail — tenure decides the section", () => {
  it("renders nothing when there is neither Current nor History", () => {
    const { container } = renderRail();
    expect(container).toBeEmptyDOMElement();
  });

  it("states the lease, the launch snapshot and the bound inputs for the Current run", () => {
    const current = createWorkflowExecution({
      id: "exec-current",
      status: "running",
      boundInputs: { target_branch: "main", rollout: "canary" },
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Checkout rules migration",
        description: "Migrate the checkout rules",
      }),
    });

    renderRail({ current }, seededClient([current]));

    const section = screen.getByRole("region", { name: "Current" });
    expect(section).toHaveTextContent("holds the lease");
    expect(section).toHaveTextContent("Checkout rules migration");
    expect(section).toHaveTextContent(
      "exec-current · launched from r1 · 3 contexts",
    );
    expect(section).toHaveTextContent(
      "inputs: target_branch=main · rollout=canary",
    );
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  });

  it.each([
    ["paused", { status: "paused" as const }],
    [
      "resumably halted",
      { status: "halted" as const, haltReason: resumableHalt },
    ],
  ])("keeps a %s run under Current", (_label, overrides) => {
    const current = createWorkflowExecution({ id: "exec-held", ...overrides });

    renderRail({ current }, seededClient([current]));

    expect(
      within(screen.getByRole("region", { name: "Current" })).getByRole(
        "button",
        { name: /execution exec-held/i },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  });

  it.each([
    ["completed", { status: "completed" as const }],
    [
      "non-resumably halted",
      { status: "halted" as const, haltReason: nonResumableHalt },
    ],
    [
      "abandoned",
      {
        status: "halted" as const,
        haltReason: resumableHalt,
        abandonment: {
          abandonedAt: "2026-08-20T10:00:00.000Z",
          reason: "Operator abandoned the run.",
          actor: { kind: "human" as const },
        },
      },
    ],
  ])("moves a %s run to History exactly once", (_label, overrides) => {
    const ended = createWorkflowExecution({ id: "exec-ended", ...overrides });

    renderRail(
      {
        current: ended,
        executions: [
          makeItem({ executionId: "exec-ended", status: ended.status }),
        ],
      },
      seededClient([ended]),
    );

    expect(screen.queryByRole("region", { name: "Current" })).toBeNull();
    const rows = within(
      screen.getByRole("region", { name: "History" }),
    ).getAllByRole("button");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAccessibleName(/execution exec-ended/i);
  });

  it("orders History newest first, states each immutable snapshot and offers no mutation control", () => {
    const newer = createWorkflowExecution({
      id: "exec-template",
      seedDefinitionId: "release-flow",
      seedDefinitionRevision: 7,
      status: "completed",
      startedAt: "2026-08-14T13:00:00.000Z",
      boundInputs: { rollout: "canary" },
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Release flow",
        description: null,
      }),
    });
    const older = createWorkflowExecution({
      id: "exec-one-off",
      origin: { kind: "one_off", planName: "Inspect queue" },
      status: "aborted",
      startedAt: "2026-08-14T11:00:00.000Z",
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Inspect queue",
        description: "Trace queue ownership",
      }),
    });

    renderRail(
      {
        executions: [
          makeItem({
            executionId: older.id,
            status: older.status,
            startedAt: older.startedAt,
          }),
          makeItem({
            executionId: newer.id,
            definitionId: "release-flow",
            definitionRevision: 7,
            status: newer.status,
            startedAt: newer.startedAt,
          }),
        ],
        selectedExecutionId: newer.id,
      },
      seededClient([newer, older]),
    );

    const history = screen.getByRole("region", { name: "History" });
    const rows = within(history).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Release flow");
    expect(rows[0]).toHaveTextContent(/exec-template · r7 snapshot · /);
    expect(rows[0]).toHaveTextContent("inputs: rollout=canary");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    // A one-off run has no definition revision to snapshot, and the seed filler
    // that lets an older build parse its row is never rendered as one.
    expect(rows[1]).toHaveTextContent(/exec-one-off · One-off · /);
    expect(rows[1]).not.toHaveTextContent("r1 snapshot");
    expect(history).toHaveTextContent("has no mutation controls");
  });

  it("keeps a run parked for a definition decision under Current, and its rejection in History", () => {
    const parked = createWorkflowExecution({
      id: "exec-parked",
      status: "pending",
      definitionApproval: {
        requestedAt: "2026-08-20T09:00:00.000Z",
        approvedAt: null,
      },
    });

    const view = renderRail({ current: parked }, seededClient([parked]));
    expect(
      within(screen.getByRole("region", { name: "Current" })).getByRole(
        "button",
        { name: /execution exec-parked/i },
      ),
    ).toBeInTheDocument();
    view.unmount();

    // Rejection ends the run at the definition gate, which is what moves it.
    const rejected = createWorkflowExecution({
      id: "exec-parked",
      status: "aborted",
      haltReason: {
        type: "aborted",
        cause: "definition_rejected",
        summary: "Reviewer rejected the parked definition.",
      },
    });
    renderRail({ current: rejected }, seededClient([rejected]));
    expect(screen.queryByRole("region", { name: "Current" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "History" })).getByRole(
        "button",
        { name: /execution exec-parked/i },
      ),
    ).toBeInTheDocument();
  });

  it("renders a tombstone only when recorded origin conversation provenance is absent from the session", () => {
    const deletedOrigin = createWorkflowExecution({
      id: "exec-deleted-origin",
      ownerConversationId: "conv-deleted",
      status: "completed",
      startedAt: "2026-08-14T14:00:00.000Z",
    });
    const existingOrigin = createWorkflowExecution({
      id: "exec-existing-origin",
      ownerConversationId: "conv-existing",
      status: "completed",
      startedAt: "2026-08-14T13:00:00.000Z",
    });

    renderRail(
      {
        executions: [
          makeItem({
            executionId: deletedOrigin.id,
            startedAt: deletedOrigin.startedAt,
          }),
          makeItem({
            executionId: existingOrigin.id,
            startedAt: existingOrigin.startedAt,
          }),
        ],
        sessionConversationIds: new Set(["conv-existing"]),
        selectedExecutionId: deletedOrigin.id,
      },
      seededClient([deletedOrigin, existingOrigin]),
    );

    const rows = within(
      screen.getByRole("region", { name: "History" }),
    ).getAllByRole("button");
    expect(rows[0]).toHaveTextContent("Origin conversation deleted");
    expect(rows[0]).not.toHaveTextContent("conv-deleted");
    expect(rows[1]).toHaveTextContent("conv-existing");
  });

  it("selects a run only when the operator activates its row", async () => {
    const onSelect = vi.fn();
    const current = createWorkflowExecution({ id: "exec-current" });

    renderRail(
      { current, selectedExecutionId: current.id, onSelect },
      seededClient([current]),
    );

    await userEvent.click(
      screen.getByRole("button", { name: /execution exec-current/i }),
    );
    expect(onSelect).toHaveBeenCalledWith("exec-current");
  });

  it("offers a labelled collapse control only to a page that owns the collapsed state", async () => {
    const onCollapse = vi.fn();
    const current = createWorkflowExecution({ id: "exec-current" });
    const client = seededClient([current]);

    const { unmount } = renderRail({ current }, client);
    expect(
      screen.queryByRole("button", { name: "Collapse executions rail" }),
    ).toBeNull();
    unmount();

    renderRail({ current, onCollapse }, client);
    await userEvent.click(
      screen.getByRole("button", { name: "Collapse executions rail" }),
    );
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
