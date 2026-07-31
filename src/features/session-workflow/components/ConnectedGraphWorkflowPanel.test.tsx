// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import {
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
  workflowDefinitionKeys,
} from "@/lib/workflows/query-keys";
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
});
