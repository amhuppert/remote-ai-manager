// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";

import type { AgentCapabilityViewResponse } from "@/lib/agent-capabilities/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";

import {
  type AgentCapabilityScope,
  agentCapabilityScopeQueryKey,
  useRefreshAgentCapabilityMutation,
  useAgentCapabilityViewQuery,
  useToggleAgentCapabilityItemMutation,
} from "./use-agent-capabilities";

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function sampleView(
  overrides: Partial<AgentCapabilityViewResponse> = {},
): AgentCapabilityViewResponse {
  return {
    level: "project",
    projectName: "remote-ai-manager",
    cascadeKind: "claude-skills",
    backend: "claude",
    effectiveHash: "hash-1",
    metadata: {
      cascadeKind: "claude-skills",
      backend: "claude",
      capabilityKind: "skill",
      applySemantics: "idle-live-apply",
      discoverySupport: "available",
      runtimeVisibility: "sdk-runtime",
      compositionSupport: "translator",
    },
    diagnostics: [],
    items: [
      {
        itemId: "reviewer",
        displayName: "Reviewer",
        backend: "claude",
        capabilityKind: "skill",
        cascadeKind: "claude-skills",
        source: {
          kind: "user-file",
          path: "/home/alex/.claude/skills/reviewer",
        },
        nativeDefault: { enabled: true },
        ownEffectiveState: { enabled: true, originLayer: "native" },
        inheritedEffectiveState: { enabled: true, originLayer: "native" },
        effectiveState: { enabled: true, originLayer: "native" },
        originLayer: "native",
        runtimeVisibility: "runtime-visible",
        runtimeEmittable: true,
        stale: false,
        applyStatus: "applied",
        diagnostics: [],
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useAgentCapabilityViewQuery", () => {
  it("fetches a schema-validated capability view for the selected scope and cascade", async () => {
    const queryClient = createQueryClient();
    const view = sampleView();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ view }), { status: 200 }),
      );

    const { result } = renderHook(
      () =>
        useAgentCapabilityViewQuery(
          { level: "project", projectName: "remote-ai-manager" },
          "claude-skills",
        ),
      { wrapper: wrapperFor(queryClient) },
    );

    await waitFor(() => expect(result.current.data).toEqual(view));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/remote-ai-manager/agent-capabilities?cascadeKind=claude-skills",
    );
  });

  it("fetches project-conversation capability views without sentinel keys or URLs", async () => {
    const queryClient = createQueryClient();
    const view = sampleView({
      level: "conversation",
      conversationScope: "project",
      conversationId: "plc-1",
    });
    const scope: AgentCapabilityScope = {
      level: "conversation",
      projectName: "remote-ai-manager",
      conversationScope: "project",
      conversationId: "plc-1",
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ view }), { status: 200 }),
      );

    const queryKey = agentCapabilityScopeQueryKey(scope, "claude-skills");
    expect(queryKey).toEqual([
      "agent-capabilities",
      "conversation",
      "remote-ai-manager",
      "claude-skills",
      "project",
      "plc-1",
    ]);
    expect(queryKey).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);

    const { result } = renderHook(
      () => useAgentCapabilityViewQuery(scope, "claude-skills"),
      { wrapper: wrapperFor(queryClient) },
    );

    await waitFor(() => expect(result.current.data).toEqual(view));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/remote-ai-manager/conversations/plc-1/agent-capabilities?cascadeKind=claude-skills",
    );
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });
});

describe("useToggleAgentCapabilityItemMutation", () => {
  it("marks only the edited visible row pending and rolls back when the mutation fails", async () => {
    const queryClient = createQueryClient();
    const scope = {
      level: "project",
      projectName: "remote-ai-manager",
    } as const;
    const queryKey = agentCapabilityScopeQueryKey(scope, "claude-skills");
    queryClient.setQueryData(queryKey, sampleView());

    let rejectRequest: (error: Error) => void = () => {};
    vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );

    const { result } = renderHook(
      () => useToggleAgentCapabilityItemMutation(scope, "claude-skills"),
      { wrapper: wrapperFor(queryClient) },
    );

    result.current.mutate({ itemId: "reviewer", enabled: false });

    await waitFor(() => {
      const pending =
        queryClient.getQueryData<AgentCapabilityViewResponse>(queryKey);
      expect(pending?.items[0]?.applyStatus).toBe("staged-idle");
      expect(pending?.items[0]?.effectiveState.enabled).toBe(true);
    });

    rejectRequest(new Error("network down"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData<AgentCapabilityViewResponse>(queryKey),
    ).toEqual(sampleView());
  });

  it("patches project-conversation capability rows and rolls back without sentinel URLs", async () => {
    const queryClient = createQueryClient();
    const scope: AgentCapabilityScope = {
      level: "conversation",
      projectName: "remote-ai-manager",
      conversationScope: "project",
      conversationId: "plc-1",
    };
    const queryKey = agentCapabilityScopeQueryKey(scope, "claude-skills");
    queryClient.setQueryData(queryKey, sampleView());

    let rejectRequest: (error: Error) => void = () => {};
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(
      new Promise<Response>((_resolve, reject) => {
        rejectRequest = reject;
      }),
    );

    const { result } = renderHook(
      () => useToggleAgentCapabilityItemMutation(scope, "claude-skills"),
      { wrapper: wrapperFor(queryClient) },
    );

    result.current.mutate({ itemId: "reviewer", enabled: false });

    await waitFor(() => {
      const pending =
        queryClient.getQueryData<AgentCapabilityViewResponse>(queryKey);
      expect(pending?.items[0]?.applyStatus).toBe("staged-idle");
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/remote-ai-manager/conversations/plc-1/agent-capabilities",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );

    rejectRequest(new Error("network down"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData<AgentCapabilityViewResponse>(queryKey),
    ).toEqual(sampleView());
  });
});

describe("useRefreshAgentCapabilityMutation", () => {
  it("posts refresh requests to the documented refresh endpoint", async () => {
    const queryClient = createQueryClient();
    const view = sampleView();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          inventory: {
            cascadeKind: "claude-skills",
            items: [],
            diagnostics: [],
            sourceSignature: "sig",
            refreshedAt: "2026-05-18T12:00:00.000Z",
          },
          view,
          invalidationHints: {
            level: "project",
            projectName: "remote-ai-manager",
            cascadeKind: "claude-skills",
            refreshDiscovery: true,
          },
        }),
        { status: 200 },
      ),
    );

    const scope = {
      level: "project",
      projectName: "remote-ai-manager",
    } as const;
    const { result } = renderHook(
      () => useRefreshAgentCapabilityMutation(scope, "claude-skills"),
      { wrapper: wrapperFor(queryClient) },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/remote-ai-manager/agent-capabilities/refresh",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("posts project-conversation refresh requests without sentinel URLs", async () => {
    const queryClient = createQueryClient();
    const view = sampleView({
      level: "conversation",
      conversationScope: "project",
      conversationId: "plc-1",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          inventory: {
            cascadeKind: "claude-skills",
            items: [],
            diagnostics: [],
            sourceSignature: "sig",
            refreshedAt: "2026-05-18T12:00:00.000Z",
          },
          view,
          invalidationHints: {
            level: "conversation",
            projectName: "remote-ai-manager",
            conversationScope: "project",
            conversationId: "plc-1",
            cascadeKind: "claude-skills",
            refreshDiscovery: true,
          },
        }),
        { status: 200 },
      ),
    );

    const scope: AgentCapabilityScope = {
      level: "conversation",
      projectName: "remote-ai-manager",
      conversationScope: "project",
      conversationId: "plc-1",
    };
    const { result } = renderHook(
      () => useRefreshAgentCapabilityMutation(scope, "claude-skills"),
      { wrapper: wrapperFor(queryClient) },
    );

    result.current.mutate();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/remote-ai-manager/conversations/plc-1/agent-capabilities/refresh",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchSpy.mock.calls[0]?.[0]).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });
});
