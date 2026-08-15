// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowApprovalDecision,
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import type { GlobalConfig } from "@/lib/config/schemas";
import {
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import { resolveWorkflowDefinition } from "@/lib/workflow-graph/resolve-config";
import {
  deriveApprovalGateStanding,
  useApprovalGate,
} from "@/features/session/hooks/use-approval-gate";

const GATED_CONVERSATION_ID = "conv-gated";
const GATED_CONTEXT_ID = "context-implement";
const REQUESTED_AT = "2026-06-10T09:00:00.000Z";
const TEST_CONFIG: GlobalConfig = {
  baseDir: "/projects",
  ignorePatterns: [],
  agentBackends: {
    claude: {
      model: "opus",
      reasoningEffort: "high",
      timeoutMs: 3_600_000,
    },
    codex: {
      model: "gpt-5.4",
      reasoningEffort: "high",
      fastMode: false,
      timeoutMs: null,
    },
  },
  defaultAgentBackend: "claude",
};

const OWNED_PATHS = ["src/api"];
const SCOPED_DIFF = {
  files: [
    {
      filePath: "src/api/handler.ts",
      additions: 1,
      deletions: 0,
      hunks: [
        {
          header: "@@ -1 +1,2 @@",
          lines: [
            { type: "hunk-header" as const, content: "@@ -1 +1,2 @@" },
            { type: "add" as const, content: "export const handler = 2;" },
          ],
        },
      ],
    },
  ],
  totalAdditions: 1,
  totalDeletions: 0,
};

const RESUMABLE_HALT: GraphWorkflowHaltReason = {
  type: "circuit_breaker",
  contextId: GATED_CONTEXT_ID,
  condition: "retry_exhaustion",
  summary: null,
};

function gatedExecution(
  opts: {
    executionStatus?: GraphWorkflowStatus;
    decision?: GraphWorkflowApprovalDecision | null;
    ownedPaths?: string[];
    requestedAt?: string;
    /** Live-edit the placement to full access while the gate stands. */
    placementEditedToFull?: boolean;
    haltReason?: GraphWorkflowHaltReason | null;
    abandonment?: GraphWorkflowAbandonment | null;
  } = {},
): GraphWorkflowExecution {
  // A halted fixture carries a resumable reason unless the case supplies its
  // own. The engine's halt event types `reason` as non-nullable, so a reasonless
  // halt is not a shape production can reach — and the lease predicate reads the
  // reason, so defaulting it here keeps "halted" meaning what these cases intend
  // (a run that is still Current) rather than a lease-free History record.
  const haltReason =
    opts.haltReason ??
    (opts.executionStatus === "halted" ? RESUMABLE_HALT : null);
  const execution = createWorkflowExecution({
    status: opts.executionStatus ?? "running",
    ...(haltReason ? { haltReason } : {}),
    ...(opts.abandonment ? { abandonment: opts.abandonment } : {}),
  });
  const contextState = execution.contextStates[GATED_CONTEXT_ID];
  if (!contextState) throw new Error("fixture missing gated context");
  contextState.status = "awaiting_approval";
  contextState.pendingApproval = {
    conversationId: GATED_CONVERSATION_ID,
    requestedAt: opts.requestedAt ?? REQUESTED_AT,
    decision: opts.decision ?? null,
    approvalScope: opts.ownedPaths
      ? {
          kind: "scoped",
          ownedPaths: opts.ownedPaths,
          treeHash: "owned-digest",
          headSha: "base-sha",
        }
      : { kind: "whole_tree" },
  };
  if (opts.ownedPaths) {
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === GATED_CONTEXT_ID,
    );
    if (!context) throw new Error("fixture missing gated context definition");
    context.placement = opts.placementEditedToFull
      ? { lane: "solo", mode: "full" }
      : { lane: "impl", mode: "owned", ownedPaths: opts.ownedPaths };
  }
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
        enveloped: false,
      });
    },
  );

  /**
   * Tenure, not a status set — and the SERVER already decides it this way. The
   * mirrored set this replaces made the client disagree with the feed: the
   * server dropped a dead gate's standing while this hook went on rendering it,
   * offering an operator a decision that could never be applied.
   */
  it("drops standing when the halt is not resumable", () => {
    expect(
      deriveApprovalGateStanding(
        gatedExecution({
          executionStatus: "halted",
          haltReason: { type: "recovery_error", message: "dead" },
        }),
        GATED_CONVERSATION_ID,
      ),
    ).toBeNull();
  });

  it("drops standing when a resumable halt has been abandoned", () => {
    expect(
      deriveApprovalGateStanding(
        gatedExecution({
          executionStatus: "halted",
          haltReason: {
            type: "circuit_breaker",
            contextId: GATED_CONTEXT_ID,
            condition: "retry_exhaustion",
            summary: null,
          },
          abandonment: {
            abandonedAt: "2026-06-10T11:00:00.000Z",
            actor: { kind: "human" },
            reason: "superseded",
          },
        }),
        GATED_CONVERSATION_ID,
      ),
    ).toBeNull();
  });

  it("marks a context under a file-ownership envelope", () => {
    expect(
      deriveApprovalGateStanding(
        gatedExecution({ ownedPaths: ["src/api"] }),
        GATED_CONVERSATION_ID,
      )?.enveloped,
    ).toBe(true);
  });

  it("keeps a parked gate enveloped when its placement is live-edited to full access", () => {
    expect(
      deriveApprovalGateStanding(
        gatedExecution({
          ownedPaths: ["src/api"],
          placementEditedToFull: true,
        }),
        GATED_CONVERSATION_ID,
      )?.enveloped,
    ).toBe(true);
  });

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

  /** Answer the snapshot request from the URL, so a test can serve per gate. */
  type SnapshotResponder = (url: string) => unknown;

  function stubFetch(snapshot?: unknown, respond?: SnapshotResponder) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.includes("/resolve-approval")) {
          return Response.json({ recorded: true });
        }
        if (url.includes("/approval-snapshot")) {
          if (respond) return Response.json(respond(url));
          return Response.json(
            snapshot ?? {
              kind: "scoped",
              snapshot: {
                contextId: GATED_CONTEXT_ID,
                ownedPaths: OWNED_PATHS,
                treeHash: "owned-digest",
                diff: SCOPED_DIFF,
              },
            },
          );
        }
        if (url.includes("/workflows/")) {
          const item = createWorkflowDefinitionRecord({ name: "Review Flow" });
          return Response.json({
            item,
            resolved: resolveWorkflowDefinition(TEST_CONFIG, item.definition),
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

  it("feeds the panel the owned-path-scoped change set, never the whole-session diff", async () => {
    const calls = stubFetch();
    const { result } = renderGateHook({
      execution: gatedExecution({ ownedPaths: OWNED_PATHS }),
    });

    await waitFor(() => {
      expect(result.current?.scopedChanges).toEqual({
        status: "ready",
        ownedPaths: OWNED_PATHS,
        diff: SCOPED_DIFF,
      });
    });

    const snapshotCall = calls.find((c) =>
      c.url.includes("/approval-snapshot"),
    );
    expect(snapshotCall?.url).toContain(
      "/api/projects/proj/sessions/sess/graph-workflow/approval-snapshot?contextId=context-implement",
    );
    // The mutable whole-session delta is exactly what an enveloped context must
    // not be reviewed through: in a shared lane it is partly a sibling's work.
    expect(calls.some((c) => /\/sessions\/sess\/diff/.test(c.url))).toBe(false);
  });

  it("leaves a full-access member on the whole-tree approval view", async () => {
    const calls = stubFetch();
    const { result } = renderGateHook({ execution: gatedExecution() });

    await waitFor(() => {
      expect(result.current?.workflowName).toBe("Review Flow");
    });
    expect(result.current?.scopedChanges).toBeNull();
    expect(calls.some((c) => c.url.includes("/approval-snapshot"))).toBe(false);
  });

  it("keeps requesting the frozen artifact after the placement is live-edited to full access", async () => {
    // Pausing an execution and re-placing a parked context must not hand the
    // reviewer a whole-tree view of a decision that was frozen under an
    // envelope. Standing follows the PARKED record, not the live placement.
    const calls = stubFetch();
    const { result } = renderGateHook({
      execution: gatedExecution({
        ownedPaths: OWNED_PATHS,
        placementEditedToFull: true,
      }),
    });

    await waitFor(() => {
      expect(result.current?.scopedChanges).toEqual({
        status: "ready",
        ownedPaths: OWNED_PATHS,
        diff: SCOPED_DIFF,
      });
    });
    expect(calls.some((c) => c.url.includes("/approval-snapshot"))).toBe(true);
  });

  it("fetches the new gate's artifact instead of reusing the previous gate's cached payload", async () => {
    const SECOND_REQUESTED_AT = "2026-06-10T11:00:00.000Z";
    const SECOND_DIFF = {
      files: [
        {
          filePath: "src/api/handler.ts",
          additions: 3,
          deletions: 1,
          hunks: [
            {
              header: "@@ -1 +1,4 @@",
              lines: [
                { type: "hunk-header" as const, content: "@@ -1 +1,4 @@" },
                { type: "add" as const, content: "export const handler = 9;" },
              ],
            },
          ],
        },
      ],
      totalAdditions: 3,
      totalDeletions: 1,
    };
    // Served per gate identity: a client that does not say WHICH gate it is
    // asking about cannot be handed the second gate's bytes at all.
    stubFetch(undefined, (url) => {
      const requestedAt = new URL(url, "http://localhost").searchParams.get(
        "requestedAt",
      );
      const second = requestedAt === SECOND_REQUESTED_AT;
      return {
        kind: "scoped",
        snapshot: {
          contextId: GATED_CONTEXT_ID,
          ownedPaths: OWNED_PATHS,
          treeHash: second ? "owned-digest-2" : "owned-digest",
          diff: second ? SECOND_DIFF : SCOPED_DIFF,
        },
      };
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ execution }: { execution: GraphWorkflowExecution }) =>
        useApprovalGate({
          projectName: "proj",
          sessionName: "sess",
          conversationId: GATED_CONVERSATION_ID,
          execution,
          conversationBusy: false,
        }),
      {
        wrapper,
        initialProps: {
          execution: gatedExecution({ ownedPaths: OWNED_PATHS }),
        },
      },
    );

    await waitFor(() => {
      expect(result.current?.scopedChanges).toEqual({
        status: "ready",
        ownedPaths: OWNED_PATHS,
        diff: SCOPED_DIFF,
      });
    });

    // The context is rejected, remediates, and parks again on a NEW candidate.
    rerender({
      execution: gatedExecution({
        ownedPaths: OWNED_PATHS,
        requestedAt: SECOND_REQUESTED_AT,
      }),
    });

    await waitFor(() => {
      expect(result.current?.scopedChanges).toEqual({
        status: "ready",
        ownedPaths: OWNED_PATHS,
        diff: SECOND_DIFF,
      });
    });
  });

  it("surfaces drift rather than rendering bytes that are not the frozen candidate", async () => {
    stubFetch({
      kind: "drifted",
      contextId: GATED_CONTEXT_ID,
      frozenTreeHash: "owned-digest",
      observedTreeHash: "owned-digest-moved",
    });
    const { result } = renderGateHook({
      execution: gatedExecution({ ownedPaths: OWNED_PATHS }),
    });

    await waitFor(() => {
      expect(result.current?.scopedChanges).toEqual({ status: "drifted" });
    });
  });

  it("reports an unavailable scoped artifact instead of silently widening", async () => {
    stubFetch({
      kind: "unavailable",
      reason: "the candidate tree could not be read",
    });
    const { result } = renderGateHook({
      execution: gatedExecution({ ownedPaths: OWNED_PATHS }),
    });

    await waitFor(() => {
      expect(result.current?.scopedChanges).toEqual({
        status: "unavailable",
        reason: "the candidate tree could not be read",
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
