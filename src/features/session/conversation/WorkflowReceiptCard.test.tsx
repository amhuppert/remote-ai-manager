// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  makeLaunchDocument,
} from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowLaunchReceipt } from "@/lib/workflow-graph/schemas";
import {
  graphWorkflowExecutionKeys,
  graphWorkflowResultKeys,
} from "@/lib/workflows/query-keys";
import WorkflowReceiptCard, {
  deriveWorkflowReceiptCardRows,
  stripWorkflowReceiptToolResults,
} from "./WorkflowReceiptCard";

const receipt: GraphWorkflowLaunchReceipt = {
  executionId: "exec-receipt",
  status: "running",
  origin: { kind: "one_off", planName: "Repair the release" },
  originConversationId: "conv-origin",
  deepLink: "/projects/proj/sess/workflow?execution=exec-receipt",
  startedAt: "2026-08-14T14:00:00.000Z",
};

function message(
  role: TranscriptMessage["role"],
  content: TranscriptMessage["content"],
): TranscriptMessage {
  return { role, content, timestamp: "2026-08-14T14:00:00.000Z" };
}

function launchTurn(
  options: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    isError?: boolean;
    result?: unknown;
  } = {},
): TranscriptMessage[] {
  return [
    message("assistant", [
      {
        type: "tool_use",
        id: "tool-launch",
        name: options.toolName ?? "mcp__command_center__start_graph_workflow",
        input: options.toolInput ?? { plan: { name: "Repair the release" } },
      },
    ]),
    message("user", [
      {
        type: "tool_result",
        tool_use_id: "tool-launch",
        content: JSON.stringify(options.result ?? { receipt }),
        ...(options.isError ? { isError: true } : {}),
      },
    ]),
  ];
}

describe("workflow launch receipt transcript projection", () => {
  it("derives exactly one turn-anchored card from a paired successful raw tool unit", () => {
    const messages = launchTurn();

    expect(deriveWorkflowReceiptCardRows(messages, "conv-origin")).toEqual([
      {
        key: "workflow-receipt:exec-receipt",
        anchorMessageIndex: 1,
        kind: "workflow-receipt-card",
        receipt,
      },
    ]);
    expect(
      stripWorkflowReceiptToolResults(
        messages[1]!.content,
        1,
        messages,
        "conv-origin",
      ),
    ).toEqual([]);
  });

  it("derives a card from the successful JSON receipt of a cctl workflow launch", () => {
    const messages = launchTurn({
      toolName: "Bash",
      toolInput: {
        command:
          "cctl workflow run --file .cc/temp/plan.json --inputs .cc/temp/inputs.json --json",
      },
      result: { ok: true, ...receipt },
    });

    expect(deriveWorkflowReceiptCardRows(messages, "conv-origin")).toEqual([
      {
        key: "workflow-receipt:exec-receipt",
        anchorMessageIndex: 1,
        kind: "workflow-receipt-card",
        receipt,
      },
    ]);
    expect(
      stripWorkflowReceiptToolResults(
        messages[1]!.content,
        1,
        messages,
        "conv-origin",
      ),
    ).toEqual([]);
  });

  it("derives nothing for failures, unrelated commands, or a non-origin conversation", () => {
    expect(
      deriveWorkflowReceiptCardRows(
        launchTurn({ isError: true }),
        "conv-origin",
      ),
    ).toEqual([]);
    expect(
      deriveWorkflowReceiptCardRows(
        launchTurn({ toolName: "mcp__command_center__get_graph_workflow" }),
        "conv-origin",
      ),
    ).toEqual([]);
    expect(deriveWorkflowReceiptCardRows(launchTurn(), "conv-sibling")).toEqual(
      [],
    );
  });

  it("re-derives the same single card after reload without stored UI state", () => {
    const messages = [...launchTurn(), ...launchTurn()];
    const first = deriveWorkflowReceiptCardRows(messages, "conv-origin");
    const reloaded = deriveWorkflowReceiptCardRows(
      structuredClone(messages),
      "conv-origin",
    );

    expect(first).toHaveLength(1);
    expect(reloaded).toEqual(first);
  });
});

describe("WorkflowReceiptCard", () => {
  it("deep-links by execution id and follows by-id/result cache updates", async () => {
    const running = createWorkflowExecution({
      id: receipt.executionId,
      origin: receipt.origin,
      ownerConversationId: receipt.originConversationId,
      status: "running",
      launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
        name: "Repair the release",
        description: "One-off release repair",
      }),
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    client.setQueryData(
      graphWorkflowExecutionKeys.byId("proj", "sess", receipt.executionId),
      running,
    );
    client.setQueryData(
      graphWorkflowResultKeys.detail("proj", "sess", receipt.executionId, null),
      {
        cursor: 4,
        boundaryKind: "pause",
        status: "paused",
      },
    );
    client.setQueryData(
      graphWorkflowResultKeys.latest("proj", "sess", receipt.executionId),
      {
        cursor: 4,
        boundaryKind: "pause",
        status: "paused",
      },
    );

    render(
      <QueryClientProvider client={client}>
        <WorkflowReceiptCard
          projectName="proj"
          sessionName="sess"
          receipt={receipt}
        />
      </QueryClientProvider>,
    );

    expect(screen.getByText("Repair the release")).toBeVisible();
    expect(screen.getByText("running")).toBeVisible();
    expect(
      screen.getByRole("link", { name: /open workflow execution/i }),
    ).toHaveAttribute(
      "href",
      "/projects/proj/sess/workflow?execution=exec-receipt",
    );

    await act(async () => {
      client.setQueryData(
        graphWorkflowExecutionKeys.byId("proj", "sess", receipt.executionId),
        {
          ...running,
          status: "completed",
          completedAt: "2026-08-14T15:00:00.000Z",
        },
      );
      client.setQueryData(
        graphWorkflowResultKeys.latest("proj", "sess", receipt.executionId),
        {
          cursor: 9,
          boundaryKind: "completion",
          status: "completed",
        },
      );
    });

    expect(await screen.findByText("completed")).toBeVisible();
    expect(screen.getByText("completion result recorded")).toBeVisible();
  });
});
