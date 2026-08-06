// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GraphWorkflowExecutionHistoryItem } from "@/lib/workflow-graph/schemas";
import ArchivedExecutionsList from "./ArchivedExecutionsList";

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

describe("ArchivedExecutionsList", () => {
  it("renders nothing when there is no history", () => {
    const { container } = render(<ArchivedExecutionsList executions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each archived run with its terminal status", () => {
    render(
      <ArchivedExecutionsList
        executions={[
          makeItem({ executionId: "exec-1", status: "completed" }),
          makeItem({ executionId: "exec-2", status: "aborted" }),
        ]}
      />,
    );

    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("aborted")).toBeInTheDocument();
    expect(screen.getByText(/exec-1/)).toBeInTheDocument();
    expect(screen.getByText(/exec-2/)).toBeInTheDocument();
  });

  it("explains a migration-cutover abort on the entry that carries it", () => {
    render(
      <ArchivedExecutionsList
        executions={[
          makeItem({
            status: "aborted",
            haltReason: {
              type: "aborted",
              cause: "migration_cutover",
              summary:
                "Aborted by the agent assignments cutover: this run's configuration no longer loads.",
            },
          }),
        ]}
      />,
    );

    expect(
      screen.getByText(/ended by a Command Center schema cutover/i),
    ).toBeInTheDocument();
    // The migration's own wording, not a headline the UI invented for it.
    expect(
      screen.getByText(/this run's configuration no longer loads/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/relaunch the workflow to continue/i),
    ).toBeInTheDocument();
  });

  it("shows a plain abort without inventing a cutover cause", () => {
    render(
      <ArchivedExecutionsList
        executions={[
          makeItem({
            status: "aborted",
            haltReason: { type: "aborted", cause: null, summary: null },
          }),
        ]}
      />,
    );

    expect(screen.getByText("Execution aborted")).toBeInTheDocument();
    expect(screen.queryByText(/schema cutover/i)).not.toBeInTheDocument();
  });
});
