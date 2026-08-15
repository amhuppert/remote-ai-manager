// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import GraphWorkflowCard from "@/features/session/conversation/GraphWorkflowCard";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

/**
 * The session card is an AMBIENT indicator, so it reflects Current only (R12.4).
 *
 * The active-execution query answers with whatever row physically occupies the
 * session's active position, and a lease-free run is allowed to sit there until
 * the next launch normalizes it away (R3.3) — so "a row came back" is not the
 * question the card is asking. Tenure is: a completed, aborted, abandoned, or
 * non-resumably halted run is History, and History has no ambient indicator.
 */

const RESUMABLE_HALT = {
  type: "circuit_breaker",
  contextId: "context-implement",
  condition: "retry_exhaustion",
  summary: null,
} as const;

const NON_RESUMABLE_HALT = {
  type: "recovery_error",
  message: "unrecoverable",
} as const;

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

const EXECUTION_HREF = "/projects/proj-1/sess-1/workflow";

function renderCard(execution: GraphWorkflowExecution): void {
  render(
    <QueryClientProvider client={makeClient()}>
      <GraphWorkflowCard
        projectName="proj-1"
        sessionName="sess-1"
        execution={execution}
        isFinished={false}
      />
    </QueryClientProvider>,
  );
}

/**
 * The indicator IS the link into the run. Both the indicator and the launcher
 * head their card "Graph Workflow", so the heading alone cannot tell them
 * apart — only the link to this session's execution does.
 */
function executionLinks(): HTMLElement[] {
  return screen
    .queryAllByRole("link")
    .filter((link) => link.getAttribute("href") === EXECUTION_HREF);
}

beforeEach(() => {
  // The launcher fallback lists templates over the HTTP boundary; an empty
  // library keeps this test about the card's Current-or-not decision.
  vi.spyOn(global, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GraphWorkflowCard ambient indicator follows the lease", () => {
  const leaseFree: Array<{ label: string; execution: GraphWorkflowExecution }> =
    [
      {
        label: "completed",
        execution: createWorkflowExecution({ status: "completed" }),
      },
      {
        label: "aborted",
        execution: createWorkflowExecution({ status: "aborted" }),
      },
      {
        label: "non-resumably halted",
        execution: createWorkflowExecution({
          status: "halted",
          haltReason: NON_RESUMABLE_HALT,
        }),
      },
      {
        label: "abandoned resumable halt",
        execution: createWorkflowExecution({
          status: "halted",
          haltReason: RESUMABLE_HALT,
          abandonment: {
            abandonedAt: "2026-06-10T11:00:00.000Z",
            actor: { kind: "human" },
            reason: "superseded",
          },
        }),
      },
    ];

  for (const { label, execution } of leaseFree) {
    it(`shows no active workflow indicator for a ${label} run`, async () => {
      renderCard(execution);

      expect(executionLinks()).toHaveLength(0);
      // The session has no Current run, so the card offers a launch instead.
      expect(
        await screen.findByText(/Build a workflow definition/),
      ).toBeVisible();
    });
  }

  const leaseHolders: Array<{
    label: string;
    execution: GraphWorkflowExecution;
  }> = [
    {
      label: "running",
      execution: createWorkflowExecution({ status: "running" }),
    },
    {
      label: "paused",
      execution: createWorkflowExecution({ status: "paused" }),
    },
    {
      label: "pending",
      execution: createWorkflowExecution({ status: "pending" }),
    },
    {
      label: "resumably halted",
      execution: createWorkflowExecution({
        status: "halted",
        haltReason: RESUMABLE_HALT,
      }),
    },
  ];

  for (const { label, execution } of leaseHolders) {
    it(`keeps the active workflow indicator for a ${label} run`, () => {
      renderCard(execution);

      expect(executionLinks()).toHaveLength(1);
      expect(screen.queryByText(/Build a workflow definition/)).toBeNull();
    });
  }
});
