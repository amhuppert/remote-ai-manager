// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useAmendGraphWorkflowMutation,
  useApproveGraphWorkflowDefinitionMutation,
  usePauseGraphWorkflowMutation,
  useResetExecutionContextMutation,
  useResolveApprovalMutation,
  useStartGraphWorkflowMutation,
} from "@/lib/workflows/mutations";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import {
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
} from "@/lib/workflows/query-keys";
import { ApiCallError } from "@/lib/api/errors";

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return React.createElement(QueryClientProvider, { client }, children);
}

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useAmendGraphWorkflowMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the canonical additive request and refreshes execution, events, and session state", async () => {
    const client = makeClient();
    const executionKey = graphWorkflowExecutionKeys.detail("proj-1", "sess-1");
    const eventsKey = graphWorkflowEventsKeys.list(
      "proj-1",
      "sess-1",
      "workflow-exec-1",
    );
    const sessionKey = sessionKeys.detail("proj-1", "sess-1");
    client.setQueryData(executionKey, { id: "workflow-exec-1" });
    client.setQueryData(eventsKey, []);
    client.setQueryData(sessionKey, { sessionName: "sess-1" });
    fetchSpy.mockResolvedValue(
      jsonResponse({
        amended: 1,
        liveRevision: 2,
        policyBasis: "human_operator",
        addedContextIds: [],
        addedTaskIds: ["verify-added-path"],
        addedEdgeIds: [],
        previousWorkingDefinitionHash: "sha256:old",
        workingDefinitionHash: "sha256:new",
      }),
    );
    const request = {
      reason: "Add live verification.",
      operations: [
        {
          type: "add-task" as const,
          id: "verify-added-path",
          contextId: "capture-studio",
          title: "Verify the added path",
          instructions: "Exercise the production route.",
        },
      ],
    };

    const { result } = renderHook(
      () =>
        useAmendGraphWorkflowMutation("proj-1", "sess-1", "workflow-exec-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(result.current.mutateAsync(request)).resolves.toMatchObject({
      liveRevision: 2,
      previousWorkingDefinitionHash: "sha256:old",
      workingDefinitionHash: "sha256:new",
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/projects/proj-1/sessions/sess-1/graph-workflow/amend",
    );
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify(request),
    });
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
    await waitFor(() => {
      expect(client.getQueryState(executionKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(eventsKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useResetExecutionContextMutation", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs {executionId, contextId} to the reset-context endpoint", async () => {
    const { result } = renderHook(
      () => useResetExecutionContextMutation("proj-1", "sess-1"),
      { wrapper },
    );

    result.current.mutate({ executionId: "exec-42", contextId: "ctx-7" });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/projects/proj-1/sessions/sess-1/graph-workflow/reset-context",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ executionId: "exec-42", contextId: "ctx-7" }),
    );
  });
});

describe("usePauseGraphWorkflowMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reconciles execution and session queries when a terminal-state race rejects pause", async () => {
    const client = makeClient();
    const executionKey = graphWorkflowExecutionKeys.detail("proj-1", "sess-1");
    const sessionKey = sessionKeys.detail("proj-1", "sess-1");
    client.setQueryData(executionKey, { id: "exec-1", status: "running" });
    client.setQueryData(sessionKey, { sessionName: "sess-1" });
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          error: "Only running graph workflow executions can be paused",
          code: "workflow_transition_conflict",
          details: {
            action: "pause",
            currentStatus: "completed",
            allowedStatuses: ["running"],
          },
        },
        409,
      ),
    );

    const { result } = renderHook(
      () => usePauseGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(result.current.mutateAsync()).rejects.toMatchObject({
      name: "ApiCallError",
      code: "workflow_transition_conflict",
      status: 409,
    });

    await waitFor(() => {
      expect(client.getQueryState(executionKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useResolveApprovalMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function seededClient() {
    const client = makeClient();
    client.setQueryData(conversationKeys.active(), { conversations: [] });
    client.setQueryData(sessionKeys.detail("proj-1", "sess-1"), {
      sessionName: "sess-1",
    });
    return client;
  }

  function invalidationState(client: QueryClient) {
    return {
      active: client.getQueryState(conversationKeys.active())?.isInvalidated,
      session: client.getQueryState(sessionKeys.detail("proj-1", "sess-1"))
        ?.isInvalidated,
    };
  }

  it("POSTs an approve decision and invalidates active conversations and session detail on success", async () => {
    const client = seededClient();
    fetchSpy.mockResolvedValue(jsonResponse({ execution: { id: "exec-1" } }));

    const { result } = renderHook(
      () => useResolveApprovalMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({ contextId: "ctx-7", decision: "approve" }),
    ).resolves.toEqual({ status: "ok" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/projects/proj-1/sessions/sess-1/graph-workflow/resolve-approval",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({ contextId: "ctx-7", decision: "approve" }),
    );

    await waitFor(() => {
      expect(invalidationState(client)).toEqual({
        active: true,
        session: true,
      });
    });
  });

  it("POSTs a reject decision with its message", async () => {
    const client = seededClient();
    fetchSpy.mockResolvedValue(jsonResponse({ execution: { id: "exec-1" } }));

    const { result } = renderHook(
      () => useResolveApprovalMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      contextId: "ctx-7",
      decision: "reject",
      message: "Wrong file layout",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe(
      JSON.stringify({
        contextId: "ctx-7",
        decision: "reject",
        message: "Wrong file layout",
      }),
    );
  });

  it("resolves with conflict status and still invalidates both keys on 409", async () => {
    const client = seededClient();
    fetchSpy.mockResolvedValue(
      jsonResponse({ error: "Context ctx-7 is not awaiting approval" }, 409),
    );

    const { result } = renderHook(
      () => useResolveApprovalMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({ contextId: "ctx-7", decision: "approve" }),
    ).resolves.toEqual({
      status: "conflict",
      error: "Context ctx-7 is not awaiting approval",
    });

    await waitFor(() => {
      expect(invalidationState(client)).toEqual({
        active: true,
        session: true,
      });
    });
  });

  it("throws ApiCallError and does not invalidate on other errors", async () => {
    const client = seededClient();
    fetchSpy.mockResolvedValue(jsonResponse({ error: "Boom" }, 500));

    const { result } = renderHook(
      () => useResolveApprovalMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({ contextId: "ctx-7", decision: "approve" }),
    ).rejects.toThrow(ApiCallError);

    expect(invalidationState(client)).toEqual({
      active: false,
      session: false,
    });
  });
});

describe("useStartGraphWorkflowMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(
      jsonResponse({ execution: { id: "exec-1" } }, 202),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function requestBody(): unknown {
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body));
  }

  it("omits `parameters` from the body for a zero-input launch", async () => {
    const { result } = renderHook(
      () => useStartGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper },
    );

    await expect(
      result.current.mutateAsync({ definitionId: "def-1" }),
    ).resolves.toEqual({ kind: "started" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/proj-1/sessions/sess-1/graph-workflow");
    expect(init.method).toBe("POST");
    expect(requestBody()).toEqual({ definitionId: "def-1" });
  });

  it("includes `parameters` in the body when supplied", async () => {
    const { result } = renderHook(
      () => useStartGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper },
    );

    await result.current.mutateAsync({
      definitionId: "def-1",
      parameters: { feature: "Search", mode: "fast" },
    });

    expect(requestBody()).toEqual({
      definitionId: "def-1",
      parameters: { feature: "Search", mode: "fast" },
    });
  });

  it("includes the selected immutable definition revision in the launch body", async () => {
    const { result } = renderHook(
      () => useStartGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper },
    );

    await result.current.mutateAsync({
      definitionId: "def-1",
      definitionRevision: 7,
    });

    expect(requestBody()).toEqual({
      definitionId: "def-1",
      definitionRevision: 7,
    });
  });

  it("includes `tier` in the body when supplied", async () => {
    const { result } = renderHook(
      () => useStartGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper },
    );

    await result.current.mutateAsync({
      definitionId: "def-1",
      tier: "global",
    });

    expect(requestBody()).toEqual({ definitionId: "def-1", tier: "global" });
  });

  it("omits `tier` from the body for a project-tier launch", async () => {
    const { result } = renderHook(
      () => useStartGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper },
    );

    await result.current.mutateAsync({ definitionId: "def-1" });

    expect(requestBody()).toEqual({ definitionId: "def-1" });
  });

  it("resolves a seeded approval-required run as parked and invalidates its caches", async () => {
    const client = makeClient();
    const executionKey = graphWorkflowExecutionKeys.detail("proj-1", "sess-1");
    const sessionKey = sessionKeys.detail("proj-1", "sess-1");
    client.setQueryData(executionKey, { execution: null });
    client.setQueryData(sessionKey, { sessionName: "sess-1" });
    const awaitingApproval = {
      kind: "awaiting_approval",
      executionId: "exec-parked",
      instruction:
        "Approve the pending workflow definition to resume execution exec-parked.",
    } as const;
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          error:
            "Workflow execution exec-parked was created and parked awaiting definition approval",
          code: "definition_approval_required",
          executionId: "exec-parked",
          instruction:
            "Approve the pending workflow definition to resume execution exec-parked.",
        },
        409,
      ),
    );

    const { result } = renderHook(
      () => useStartGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({ definitionId: "def-1" }),
    ).resolves.toEqual(awaitingApproval);

    await waitFor(() => {
      expect(client.getQueryState(executionKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(sessionKey)?.isInvalidated).toBe(true);
    });
  });

  it("surfaces a 400 input-validation rejection as an ApiCallError with the engine message", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        { error: 'Parameter "feature" is required but was not supplied' },
        400,
      ),
    );

    const { result } = renderHook(
      () => useStartGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper },
    );

    await expect(
      result.current.mutateAsync({
        definitionId: "def-1",
        parameters: {},
      }),
    ).rejects.toMatchObject({
      name: "ApiCallError",
      message: 'Parameter "feature" is required but was not supplied',
    });
  });

  it("rejects a malformed approval-required response instead of treating it as parked", async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          error: "Workflow was parked",
          code: "definition_approval_required",
          executionId: 42,
          instruction: null,
        },
        409,
      ),
    );

    const { result } = renderHook(
      () => useStartGraphWorkflowMutation("proj-1", "sess-1"),
      { wrapper },
    );

    await expect(
      result.current.mutateAsync({ definitionId: "def-1" }),
    ).rejects.toMatchObject({
      name: "ApiCallError",
      code: "definition_approval_required",
      message: "Workflow was parked",
    });
  });
});

describe("useApproveGraphWorkflowDefinitionMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the human approval and invalidates the active execution detail", async () => {
    const client = makeClient();
    const executionKey = graphWorkflowExecutionKeys.detail("proj-1", "sess-1");
    client.setQueryData(executionKey, {
      execution: { id: "exec-parked", status: "pending" },
    });
    fetchSpy.mockResolvedValue(
      jsonResponse({
        execution: { executionId: "exec-parked", status: "running" },
      }),
    );

    const { result } = renderHook(
      () => useApproveGraphWorkflowDefinitionMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      executionId: "exec-parked",
      definitionId: "def-parked",
      definitionRevision: 7,
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/projects/proj-1/sessions/sess-1/graph-workflow/approve-definition",
    );
    expect(init.method).toBe("POST");
    expect(init.body).toBe(
      JSON.stringify({
        executionId: "exec-parked",
        definitionId: "def-parked",
        definitionRevision: 7,
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(executionKey)?.isInvalidated).toBe(true);
    });
  });

  it("preserves a gate refusal's conditions and recovery instruction", async () => {
    const client = makeClient();
    const executionKey = graphWorkflowExecutionKeys.detail("proj-1", "sess-1");
    client.setQueryData(executionKey, {
      execution: { id: "exec-parked", status: "pending" },
    });
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          error: "The pinned revision is no longer approved.",
          code: "revision_not_approved",
          unmetConditions: ["The pinned revision is no longer approved."],
          instruction: "Sign off the revision, then approve again.",
        },
        409,
      ),
    );

    const { result } = renderHook(
      () => useApproveGraphWorkflowDefinitionMutation("proj-1", "sess-1"),
      { wrapper: wrapperFor(client) },
    );

    const error = await result.current
      .mutateAsync({
        executionId: "exec-parked",
        definitionId: "def-parked",
        definitionRevision: 7,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiCallError);
    if (error instanceof ApiCallError) {
      expect(error.code).toBe("revision_not_approved");
      expect(error.details).toEqual({
        unmetConditions: ["The pinned revision is no longer approved."],
        instruction: "Sign off the revision, then approve again.",
      });
    }
    await waitFor(() => {
      expect(client.getQueryState(executionKey)?.isInvalidated).toBe(true);
    });
  });
});
