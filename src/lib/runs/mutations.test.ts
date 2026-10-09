// @vitest-environment jsdom
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRunControlMutation, useRunDecisionMutation } from "./mutations";
import { runKeys } from "./query-keys";

const fetchSpy = vi.fn<typeof fetch>();
const requests: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  requests.length = 0;
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async (input, init) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const body = String(input).endsWith("/decide")
      ? { ok: true }
      : { ok: true, progress: { kind: "paused", draining: false } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const page = runKeys.page("plc", "fx", "run-1");
  const list = runKeys.list("plc", "fx");
  client.setQueryData(page, {});
  client.setQueryData(list, []);
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const stale = () => [
    client.getQueryState(page)?.isInvalidated,
    client.getQueryState(list)?.isInvalidated,
  ];
  return { wrapper, stale };
}

describe("run mutations", () => {
  it("asks the run to pause as a person, then refreshes its page and its session's list", async () => {
    const { wrapper, stale } = setup();
    const { result } = renderHook(() => useRunControlMutation("plc", "fx"), {
      wrapper,
    });

    result.current.mutate({ runId: "run-1", control: { action: "pause" } });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requests).toEqual([
      {
        url: "/api/projects/plc/sessions/fx/runs/run-1/control",
        body: { action: "pause" },
      },
    ]);
    expect(stale()).toEqual([true, true]);
  });

  it("records a person's decision on a result awaiting approval", async () => {
    const { wrapper, stale } = setup();
    const { result } = renderHook(() => useRunDecisionMutation("plc", "fx"), {
      wrapper,
    });

    result.current.mutate({
      runId: "run-1",
      decision: {
        contextId: "run-1.agent",
        candidateId: "run-1.agent:candidate:1",
        decision: "rejected",
        notes: "Use the shared helper",
      },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(requests).toEqual([
      {
        url: "/api/projects/plc/sessions/fx/runs/run-1/decide",
        body: {
          contextId: "run-1.agent",
          candidateId: "run-1.agent:candidate:1",
          decision: "rejected",
          notes: "Use the shared helper",
        },
      },
    ]);
    expect(stale()).toEqual([true, true]);
  });

  it("sends and refreshes the run it was asked about, whichever run is selected by the time it settles", async () => {
    const { wrapper, stale } = setup();
    let release: () => void = () => {};
    fetchSpy.mockImplementationOnce(async (input, init) => {
      requests.push({
        url: String(input),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(
        JSON.stringify({ ok: true, progress: { kind: "running" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const { result } = renderHook(() => useRunControlMutation("plc", "fx"), {
      wrapper,
    });

    result.current.mutate({ runId: "run-1", control: { action: "cancel" } });
    await waitFor(() => expect(requests).toHaveLength(1));
    release();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requests[0]?.url).toBe(
      "/api/projects/plc/sessions/fx/runs/run-1/control",
    );
    // run-1's page and the session's list, not whichever run is open.
    await waitFor(() => expect(stale()).toEqual([true, true]));
  });
});
