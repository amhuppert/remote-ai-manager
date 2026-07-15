// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  GraphWorkflowApprovalDecision,
  GraphWorkflowExecution,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import {
  deriveApprovalGateStanding,
  useApprovalGate,
} from "@/features/session/hooks/use-approval-gate";

const GATED_CONVERSATION_ID = "conv-gated";
const GATED_CONTEXT_ID = "context-implement";
const REQUESTED_AT = "2026-06-10T09:00:00.000Z";

function gatedExecution(
  opts: {
    executionStatus?: GraphWorkflowStatus;
    decision?: GraphWorkflowApprovalDecision | null;
  } = {},
): GraphWorkflowExecution {
  const execution = createWorkflowExecution({
    status: opts.executionStatus ?? "running",
  });
  const contextState = execution.contextStates[GATED_CONTEXT_ID];
  if (!contextState) throw new Error("fixture missing gated context");
  contextState.status = "awaiting_approval";
  contextState.pendingApproval = {
    conversationId: GATED_CONVERSATION_ID,
    requestedAt: REQUESTED_AT,
    decision: opts.decision ?? null,
  };
  return execution;
}

describe("deriveApprovalGateStanding", () => {
  it("returns null when there is no execution", () => {
    expect(deriveApprovalGateStanding(null, GATED_CONVERSATION_ID)).toBeNull();
  });

  it.each(["running", "paused", "halted"] as const)(
    "returns the standing while the execution is %s",
    (executionStatus) => {
      const standing = deriveApprovalGateStanding(
        gatedExecution({ executionStatus }),
        GATED_CONVERSATION_ID,
      );
      expect(standing).toEqual({
        contextId: GATED_CONTEXT_ID,
        contextTitle: "Implement",
        requestedAt: REQUESTED_AT,
      });
    },
  );

  it.each(["pending", "completed", "aborted"] as const)(
    "returns null when the execution is %s",
    (executionStatus) => {
      expect(
        deriveApprovalGateStanding(
          gatedExecution({ executionStatus }),
          GATED_CONVERSATION_ID,
        ),
      ).toBeNull();
    },
  );

  it("returns null once a decision has been recorded", () => {
    const execution = gatedExecution({
      decision: {
        type: "approved",
        decidedAt: "2026-06-10T10:00:00.000Z",
      },
    });
    expect(
      deriveApprovalGateStanding(execution, GATED_CONVERSATION_ID),
    ).toBeNull();
  });

  it("returns null for a different conversation", () => {
    expect(
      deriveApprovalGateStanding(gatedExecution(), "conv-other"),
    ).toBeNull();
  });

  it("returns null when no context awaits approval", () => {
    expect(
      deriveApprovalGateStanding(
        createWorkflowExecution({ status: "running" }),
        GATED_CONVERSATION_ID,
      ),
    ).toBeNull();
  });
});

describe("useApprovalGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch() {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes("/resolve-approval")) {
          return Response.json({ recorded: true });
        }
        if (url.includes("/workflows/")) {
          return Response.json({
            item: createWorkflowDefinitionRecord({ name: "Review Flow" }),
            resolved: createResolvedWorkflowDefinition(),
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    return calls;
  }

  function renderGateHook(args: {
    execution: GraphWorkflowExecution | null;
    conversationBusy?: boolean;
    conversationId?: string;
  }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return renderHook(
      () =>
        useApprovalGate({
          projectName: "proj",
          sessionName: "sess",
          conversationId: args.conversationId ?? GATED_CONVERSATION_ID,
          execution: args.execution,
          conversationBusy: args.conversationBusy ?? false,
        }),
      { wrapper },
    );
  }

  it("returns null when the conversation is not gated", () => {
    stubFetch();
    const { result } = renderGateHook({ execution: null });
    expect(result.current).toBeNull();
  });

  it("returns panel props with the context title and the workflow name from the seed definition", async () => {
    stubFetch();
    const { result } = renderGateHook({ execution: gatedExecution() });

    expect(result.current).not.toBeNull();
    expect(result.current?.contextTitle).toBe("Implement");
    expect(result.current?.isSubmitting).toBe(false);
    expect(result.current?.conversationBusy).toBe(false);
    expect(result.current?.executionSuspended).toBe(false);
    await waitFor(() => {
      expect(result.current?.workflowName).toBe("Review Flow");
    });
  });

  it("threads conversationBusy through to the panel props", () => {
    stubFetch();
    const { result } = renderGateHook({
      execution: gatedExecution(),
      conversationBusy: true,
    });
    expect(result.current?.conversationBusy).toBe(true);
  });

  it.each(["paused", "halted"] as const)(
    "flags executionSuspended while the execution is %s",
    (executionStatus) => {
      stubFetch();
      const { result } = renderGateHook({
        execution: gatedExecution({ executionStatus }),
      });
      expect(result.current?.executionSuspended).toBe(true);
    },
  );

  it("posts an approve decision for the gated context", async () => {
    const calls = stubFetch();
    const { result } = renderGateHook({ execution: gatedExecution() });

    act(() => {
      result.current?.onApprove();
    });

    await waitFor(() => {
      const resolveCall = calls.find((c) =>
        c.url.includes("/resolve-approval"),
      );
      expect(resolveCall).toBeDefined();
      expect(resolveCall?.url).toContain(
        "/api/projects/proj/sessions/sess/graph-workflow/resolve-approval",
      );
      expect(resolveCall?.init?.method).toBe("POST");
      expect(JSON.parse(String(resolveCall?.init?.body))).toEqual({
        contextId: GATED_CONTEXT_ID,
        decision: "approve",
      });
    });
  });

  it("posts a reject decision carrying the message", async () => {
    const calls = stubFetch();
    const { result } = renderGateHook({ execution: gatedExecution() });

    act(() => {
      result.current?.onReject("needs more tests");
    });

    await waitFor(() => {
      const resolveCall = calls.find((c) =>
        c.url.includes("/resolve-approval"),
      );
      expect(resolveCall).toBeDefined();
      expect(JSON.parse(String(resolveCall?.init?.body))).toEqual({
        contextId: GATED_CONTEXT_ID,
        decision: "reject",
        message: "needs more tests",
      });
    });
  });

  it("returns null once a decision is recorded so the read-only treatment can return", () => {
    stubFetch();
    const { result } = renderGateHook({
      execution: gatedExecution({
        decision: {
          type: "rejected",
          message: "redo",
          decidedAt: "2026-06-10T10:00:00.000Z",
        },
      }),
    });
    expect(result.current).toBeNull();
  });
});
