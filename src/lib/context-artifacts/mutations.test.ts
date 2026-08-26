// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CONTEXT_ARTIFACT_SCHEMA_VERSION } from "./schemas";
import { contextArtifactKeys, type ContextArtifactTarget } from "./query-keys";
import type { ContextArtifactDetail, ContextArtifactListItem } from "./queries";
import { useCompactMutation, useDeleteArtifactMutation } from "./mutations";

const sessionTarget: ContextArtifactTarget = {
  scope: "session",
  projectName: "proj",
  sessionName: "sess",
  conversationId: "conv-1",
};

const listKey = contextArtifactKeys.list(sessionTarget);

function makeListItem(
  overrides: Partial<ContextArtifactListItem> & { id: string },
): ContextArtifactListItem {
  return {
    kind: "conversation_compaction",
    scope: "session",
    projectPath: "/p/proj",
    sessionName: "sess",
    conversationId: "conv-1",
    messageId: null,
    messageIndex: null,
    coveredStartSeq: 0,
    coveredEndSeq: 42,
    sourceHash: "hash",
    status: "complete",
    error: null,
    backend: "claude",
    modelSelection: {
      modelId: "sonnet",
      parameters: { effort: "medium" },
    },
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
    promptVersion: "v1",
    normalizerVersion: "v1",
    createdBy: "user",
    createdByConversationId: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    stale: false,
    staleBehindMessages: 0,
    outdated: false,
    ...overrides,
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
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

describe("useCompactMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("places an optimistic pending row into the list cache before the server responds", async () => {
    const client = makeClient();
    client.setQueryData<ContextArtifactListItem[]>(listKey, []);
    fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));

    const { result } = renderHook(() => useCompactMutation(sessionTarget), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ kind: "conversation_compaction" });

    await waitFor(() => {
      const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
      expect(cached).toHaveLength(1);
      expect(cached?.[0]?.status).toBe("pending");
      expect(cached?.[0]?.id).toMatch(/^optimistic-/);
      expect(cached?.[0]?.kind).toBe("conversation_compaction");
      expect(cached?.[0]?.scope).toBe("session");
    });
  });

  it("flips an existing artifact of the same logical key to pending instead of adding a row", async () => {
    const client = makeClient();
    client.setQueryData<ContextArtifactListItem[]>(listKey, [
      makeListItem({ id: "a-1", status: "complete", stale: true }),
      makeListItem({
        id: "m-3",
        kind: "message_compaction",
        messageIndex: 3,
      }),
    ]);
    fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));

    const { result } = renderHook(() => useCompactMutation(sessionTarget), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ kind: "conversation_compaction" });

    await waitFor(() => {
      const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
      expect(cached).toHaveLength(2);
      expect(cached?.find((r) => r.id === "a-1")?.status).toBe("pending");
      expect(cached?.find((r) => r.id === "m-3")?.status).toBe("complete");
    });
  });

  it("keys message compactions by messageIndex when matching the existing row", async () => {
    const client = makeClient();
    client.setQueryData<ContextArtifactListItem[]>(listKey, [
      makeListItem({
        id: "m-3",
        kind: "message_compaction",
        messageIndex: 3,
      }),
    ]);
    fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));

    const { result } = renderHook(() => useCompactMutation(sessionTarget), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ kind: "message_compaction", messageIndex: 7 });

    await waitFor(() => {
      const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
      expect(cached).toHaveLength(2);
      expect(cached?.find((r) => r.id === "m-3")?.status).toBe("complete");
      expect(
        cached?.find((r) => r.messageIndex === 7 && r.status === "pending"),
      ).toBeDefined();
    });
  });

  it("POSTs a create_or_refresh body carrying kind, messageIndex, and force", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValue(
      jsonResponse({ artifactId: "a-9", status: "pending" }, 202),
    );

    const { result } = renderHook(() => useCompactMutation(sessionTarget), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({
      kind: "message_compaction",
      messageIndex: 7,
      force: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "/api/projects/proj/sessions/sess/conversations/conv-1/context-artifacts",
    );
    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "message_compaction",
      messageIndex: 7,
      mode: "create_or_refresh",
      force: true,
    });
  });

  it("omits messageIndex from the body for conversation compactions", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValue(
      jsonResponse({ artifactId: "a-9", status: "pending" }, 202),
    );

    const { result } = renderHook(() => useCompactMutation(sessionTarget), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ kind: "conversation_compaction" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      kind: "conversation_compaction",
      mode: "create_or_refresh",
    });
  });

  it("adopts the server artifact id onto the optimistic row on a 202 response", async () => {
    const client = makeClient();
    client.setQueryData<ContextArtifactListItem[]>(listKey, []);
    fetchSpy.mockResolvedValue(
      jsonResponse({ artifactId: "a-real", status: "pending" }, 202),
    );

    const { result } = renderHook(() => useCompactMutation(sessionTarget), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ kind: "conversation_compaction" });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
    expect(cached?.map((r) => r.id)).toEqual(["a-real"]);
    expect(cached?.[0]?.status).toBe("pending");
  });

  it("replaces the row and seeds the detail cache when the server answers with a fresh artifact", async () => {
    const client = makeClient();
    client.setQueryData<ContextArtifactListItem[]>(listKey, [
      makeListItem({ id: "a-1", status: "complete" }),
    ]);
    const artifact = {
      ...makeListItem({ id: "a-1", status: "complete", coveredEndSeq: 99 }),
      payload: null,
    };
    fetchSpy.mockResolvedValue(
      jsonResponse({ artifact, hint: "already fresh" }),
    );

    const { result } = renderHook(() => useCompactMutation(sessionTarget), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ kind: "conversation_compaction" });
    await waitFor(() => {
      expect(result.current.error).toBeNull();
      expect(result.current.isSuccess).toBe(true);
    });

    const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
    expect(cached?.[0]?.coveredEndSeq).toBe(99);
    expect(cached?.[0]?.status).toBe("complete");
    const detail = client.getQueryData<ContextArtifactDetail>(
      contextArtifactKeys.detail(sessionTarget, "a-1"),
    );
    expect(detail?.id).toBe("a-1");
  });

  it("rolls back the optimistic row when the server rejects", async () => {
    const client = makeClient();
    const before = [makeListItem({ id: "a-1", status: "complete" })];
    client.setQueryData(listKey, before);
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useCompactMutation(sessionTarget), {
      wrapper: wrapperFor(client),
    });

    result.current.mutate({ kind: "conversation_compaction" });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData(listKey)).toEqual(before);
  });
});

describe("useDeleteArtifactMutation", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("removes the row from the list cache before the server responds", async () => {
    const client = makeClient();
    client.setQueryData<ContextArtifactListItem[]>(listKey, [
      makeListItem({ id: "a-1" }),
      makeListItem({ id: "m-3", kind: "message_compaction", messageIndex: 3 }),
    ]);
    fetchSpy.mockImplementation(() => new Promise<Response>(() => {}));

    const { result } = renderHook(
      () => useDeleteArtifactMutation(sessionTarget),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate("a-1");

    await waitFor(() => {
      const cached = client.getQueryData<ContextArtifactListItem[]>(listKey);
      expect(cached?.map((r) => r.id)).toEqual(["m-3"]);
    });
  });

  it("issues a DELETE against the artifact route", async () => {
    const client = makeClient();
    fetchSpy.mockResolvedValue(jsonResponse({ deleted: true }));

    const { result } = renderHook(
      () => useDeleteArtifactMutation(sessionTarget),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate("a-1");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
      "/api/projects/proj/sessions/sess/conversations/conv-1/context-artifacts/a-1",
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it("restores the list and detail caches when the server rejects", async () => {
    const client = makeClient();
    const detailKey = contextArtifactKeys.detail(sessionTarget, "a-1");
    const beforeList = [makeListItem({ id: "a-1" })];
    const beforeDetail = { ...makeListItem({ id: "a-1" }), payload: null };
    client.setQueryData(listKey, beforeList);
    client.setQueryData(detailKey, beforeDetail);
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(
      () => useDeleteArtifactMutation(sessionTarget),
      { wrapper: wrapperFor(client) },
    );

    result.current.mutate("a-1");
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(client.getQueryData(listKey)).toEqual(beforeList);
    expect(client.getQueryData(detailKey)).toEqual(beforeDetail);
  });
});
