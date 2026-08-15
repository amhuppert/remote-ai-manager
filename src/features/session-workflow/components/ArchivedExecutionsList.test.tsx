// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import { renderWithQuery } from "@/test/component-mocks";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GraphWorkflowExecutionHistoryItem } from "@/lib/workflow-graph/schemas";
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

describe("Current and History execution rail", () => {
  it("renders nothing when there is neither Current nor History", () => {
    const { container } = renderWithQuery(
      <ArchivedExecutionsList
        projectName="proj"
        sessionName="sess"
        current={null}
        executions={[]}
        sessionConversationIds={new Set()}
        selectedExecutionId={null}
        onSelect={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders both origins with required provenance fields and History newest first", async () => {
    const current = createWorkflowExecution({
      id: "exec-current",
      origin: { kind: "one_off", planName: "Repair flaky tests" },
      ownerConversationId: "conv-current",
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Repair flaky tests",
        description: "One-off regression repair",
      }),
      status: "running",
      startedAt: "2026-08-14T14:00:00.000Z",
    });
    const newerHistory = createWorkflowExecution({
      id: "exec-template",
      origin: {
        kind: "template",
        definitionId: "release-flow",
        definitionRevision: 7,
        tier: "project",
      },
      ownerConversationId: null,
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Release flow",
        description: null,
      }),
      status: "completed",
      startedAt: "2026-08-14T13:00:00.000Z",
      completedAt: "2026-08-14T13:30:00.000Z",
    });
    const olderHistory = createWorkflowExecution({
      id: "exec-one-off",
      origin: { kind: "one_off", planName: "Inspect queue" },
      ownerConversationId: "conv-history",
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Inspect queue",
        description: "Trace queue ownership",
      }),
      status: "aborted",
      startedAt: "2026-08-14T11:00:00.000Z",
      completedAt: "2026-08-14T11:15:00.000Z",
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    for (const execution of [newerHistory, olderHistory]) {
      client.setQueryData(
        graphWorkflowExecutionKeys.byId("proj", "sess", execution.id),
        execution,
      );
      client.setQueryData(
        graphWorkflowResultKeys.detail("proj", "sess", execution.id, null),
        null,
      );
    }
    client.setQueryData(
      graphWorkflowResultKeys.detail("proj", "sess", current.id, null),
      null,
    );

    renderWithQuery(
      <ArchivedExecutionsList
        projectName="proj"
        sessionName="sess"
        current={current}
        executions={[
          makeItem({
            executionId: olderHistory.id,
            status: olderHistory.status,
            startedAt: olderHistory.startedAt,
          }),
          makeItem({
            executionId: newerHistory.id,
            definitionId: "release-flow",
            definitionRevision: 7,
            status: newerHistory.status,
            startedAt: newerHistory.startedAt,
          }),
        ]}
        sessionConversationIds={new Set(["conv-current", "conv-history"])}
        selectedExecutionId="exec-template"
        onSelect={vi.fn()}
      />,
      client,
    );

    const currentSection = screen.getByRole("region", { name: "Current" });
    expect(currentSection).toHaveTextContent("Repair flaky tests");
    expect(currentSection).toHaveTextContent("One-off");
    expect(currentSection).toHaveTextContent("conv-current");
    expect(currentSection).toHaveTextContent("One-off regression repair");

    const history = screen.getByRole("region", { name: "History" });
    const rows = within(history).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Release flow");
    expect(rows[0]).toHaveTextContent("Template");
    expect(rows[0]).toHaveTextContent("rev 7");
    expect(rows[0]).toHaveTextContent("No origin conversation");
    expect(rows[0]).toHaveTextContent("No description");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[1]).toHaveTextContent("Inspect queue");
    expect(rows[1]).toHaveTextContent("One-off");
    expect(rows[1]).toHaveTextContent("conv-history");
  });

  it("renders a tombstone only when recorded origin conversation provenance is absent from the session", () => {
    const deletedOrigin = createWorkflowExecution({
      id: "exec-deleted-origin",
      ownerConversationId: "conv-deleted",
      status: "completed",
    });
    const existingOrigin = createWorkflowExecution({
      id: "exec-existing-origin",
      ownerConversationId: "conv-existing",
      status: "completed",
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    for (const execution of [deletedOrigin, existingOrigin]) {
      client.setQueryData(
        graphWorkflowExecutionKeys.byId("proj", "sess", execution.id),
        execution,
      );
      client.setQueryData(
        graphWorkflowResultKeys.detail("proj", "sess", execution.id, null),
        null,
      );
    }

    renderWithQuery(
      <ArchivedExecutionsList
        projectName="proj"
        sessionName="sess"
        current={null}
        executions={[
          makeItem({
            executionId: deletedOrigin.id,
            startedAt: "2026-08-14T14:00:00.000Z",
          }),
          makeItem({
            executionId: existingOrigin.id,
            startedAt: "2026-08-14T13:00:00.000Z",
          }),
        ]}
        sessionConversationIds={new Set(["conv-existing"])}
        selectedExecutionId={deletedOrigin.id}
        onSelect={vi.fn()}
      />,
      client,
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

    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    client.setQueryData(
      graphWorkflowResultKeys.detail("proj", "sess", current.id, null),
      null,
    );
    renderWithQuery(
      <ArchivedExecutionsList
        projectName="proj"
        sessionName="sess"
        current={current}
        executions={[]}
        sessionConversationIds={new Set()}
        selectedExecutionId={current.id}
        onSelect={onSelect}
      />,
      client,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /execution exec-current/i }),
    );
    expect(onSelect).toHaveBeenCalledWith("exec-current");
  });
});
