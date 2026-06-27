// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  useApproveCharterMutation,
  useRejectCharterMutation,
  useResolveDecisionsMutation,
  useRollbackAlignmentMutation,
} from "./mutations";
import { alignmentKeys } from "./query-keys";
import type { AlignmentVersion } from "./schemas";

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

function activeVersion(
  overrides: Partial<AlignmentVersion> & { id: string },
): AlignmentVersion {
  return {
    id: overrides.id,
    version: overrides.version ?? 2,
    content: overrides.content ?? "Mission: ship",
    contentHash: overrides.contentHash ?? "hash",
    status: overrides.status ?? "active",
    source: overrides.source ?? "align_initial",
    authorConversationId: overrides.authorConversationId ?? null,
    autoActivate: overrides.autoActivate ?? false,
    linkedDecisionIds: overrides.linkedDecisionIds ?? [],
    createdAt: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    activatedAt: overrides.activatedAt ?? "2025-01-01T00:00:00.000Z",
    approver: overrides.approver ?? null,
  };
}

const fetchSpy = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useApproveCharterMutation", () => {
  it("POSTs the draft approval and invalidates the alignment state query", async () => {
    const client = makeClient();
    const stateKey = alignmentKeys.state("p", "s");
    client.setQueryData(stateKey, { active: null });
    fetchSpy.mockResolvedValue(jsonResponse(activeVersion({ id: "v2" })));

    const { result } = renderHook(() => useApproveCharterMutation("p", "s"), {
      wrapper: wrapperFor(client),
    });

    const returned = await result.current.mutateAsync({ draftId: "d1" });
    expect(returned.id).toBe("v2");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/alignment/charter/approve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ draftId: "d1" }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(stateKey)?.isInvalidated).toBe(true);
    });
  });

  it("invalidates the alignment state query even when the server rejects", async () => {
    const client = makeClient();
    const stateKey = alignmentKeys.state("p", "s");
    client.setQueryData(stateKey, { active: null });
    fetchSpy.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const { result } = renderHook(() => useApproveCharterMutation("p", "s"), {
      wrapper: wrapperFor(client),
    });

    await expect(
      result.current.mutateAsync({ draftId: "d1" }),
    ).rejects.toBeDefined();

    await waitFor(() => {
      expect(client.getQueryState(stateKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useRejectCharterMutation", () => {
  it("POSTs the draft rejection and invalidates the alignment state query", async () => {
    const client = makeClient();
    const stateKey = alignmentKeys.state("p", "s");
    client.setQueryData(stateKey, { active: null });
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true }));

    const { result } = renderHook(() => useRejectCharterMutation("p", "s"), {
      wrapper: wrapperFor(client),
    });

    const returned = await result.current.mutateAsync({ draftId: "d1" });
    expect(returned.ok).toBe(true);

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/alignment/charter/reject",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ draftId: "d1" }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(stateKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useResolveDecisionsMutation", () => {
  it("POSTs the batch resolutions and invalidates the alignment state query", async () => {
    const client = makeClient();
    const stateKey = alignmentKeys.state("p", "s");
    client.setQueryData(stateKey, { active: null });
    fetchSpy.mockResolvedValue(jsonResponse({ approved: 2, rejected: 1 }));

    const { result } = renderHook(() => useResolveDecisionsMutation("p", "s"), {
      wrapper: wrapperFor(client),
    });

    const vars = {
      batchId: "b1",
      resolutions: [
        { proposalId: "pr1", approve: true },
        { proposalId: "pr2", approve: true },
        { proposalId: "pr3", approve: false, feedback: "no" },
      ],
    };
    const returned = await result.current.mutateAsync(vars);
    expect(returned).toEqual({ approved: 2, rejected: 1 });

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/alignment/decisions/resolve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(vars),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(stateKey)?.isInvalidated).toBe(true);
    });
  });
});

describe("useRollbackAlignmentMutation", () => {
  it("POSTs the rollback and invalidates the alignment state query", async () => {
    const client = makeClient();
    const stateKey = alignmentKeys.state("p", "s");
    client.setQueryData(stateKey, { active: null });
    fetchSpy.mockResolvedValue(jsonResponse(activeVersion({ id: "v3" })));

    const { result } = renderHook(
      () => useRollbackAlignmentMutation("p", "s"),
      {
        wrapper: wrapperFor(client),
      },
    );

    const returned = await result.current.mutateAsync({ version: 1 });
    expect(returned.id).toBe("v3");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/projects/p/sessions/s/alignment/rollback",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ version: 1 }),
      }),
    );
    await waitFor(() => {
      expect(client.getQueryState(stateKey)?.isInvalidated).toBe(true);
    });
  });
});
